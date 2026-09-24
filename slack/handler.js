/**
 * Claudia Slack Message Handler
 *
 * Core request/response pipeline:
 *
 *   1. Receive Slack message (mention or DM)
 *   2. Recall relevant memory context for this user
 *   3. Build a prompt with the context prepended
 *   4. Call the Claude API for a response
 *   5. Reply to the Slack thread
 *   6. Asynchronously store the exchange as a new memory
 *
 * This module is stateless. All persistence goes through the memory client.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL,
  EXTRACTION_MODEL,
  SYSTEM_PROMPT,
  MAX_TOKENS,
  MEMORY_RECALL_LIMIT,
  HISTORY_LIMIT,
} from './config.js';
import * as memory from './memory-client.js';
import { buildCalendarContext, createEvent, isCalendarConfigured } from './calendar-client.js';
import { storageId } from './identity.js';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });


// ---------------------------------------------------------------------------
// Calendar tool definition
// ---------------------------------------------------------------------------

const CALENDAR_TOOLS = [
  {
    name: 'create_calendar_event',
    description: "Create a new event on the user's Google Calendar. Use this when the user asks to schedule, add, book, or create a meeting, appointment, or event.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title or summary' },
        start_datetime: { type: 'string', description: 'Start date and time in ISO 8601 format (e.g. 2026-06-08T14:00:00). Resolve relative dates like "tomorrow" or "Friday" using the current date.' },
        end_datetime: { type: 'string', description: 'End date and time in ISO 8601 format. Defaults to 1 hour after start if not provided.' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'List of attendee email addresses (optional)' },
        description: { type: 'string', description: 'Event description or agenda (optional)' },
        location: { type: 'string', description: 'Event location or video call link (optional)' },
      },
      required: ['title', 'start_datetime'],
    },
  },
];
// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Handle an incoming Slack message and reply with Claude's response.
 *
 * @param {object} opts
 * @param {string} opts.text          - The user's message text (already cleaned)
 * @param {string} opts.userId        - RAW Slack user ID (e.g. "U012AB3CD"), used
 *                                       for Slack API calls. NOT used as a storage key.
 * @param {string} opts.username      - Slack display name
 * @param {string} opts.channelId     - Slack channel ID
 * @param {string} opts.threadTs      - Thread timestamp to reply into
 * @param {string} [opts.messageTs]   - Timestamp of the incoming message itself
 * @param {boolean} [opts.isDm]       - True when the message is a direct message
 * @param {string} [opts.botUserId]   - The bot's own user ID (to tag its past turns)
 * @param {object} [opts.client]      - Bolt WebClient for this workspace (history fetch)
 * @param {string} [opts.teamId]      - Slack team/workspace ID (multi-tenant namespacing)
 * @param {string} [opts.enterpriseId]- Slack enterprise/org ID (org installs)
 * @param {Function} opts.say         - Bolt say() function or equivalent
 */
export async function handleMessage({ text, userId, username, channelId, threadTs, messageTs, isDm, botUserId, client, teamId, enterpriseId, say }) {
  // Composite storage key in multi-tenant mode so two users with the same Slack
  // id in different workspaces never collide. Single-workspace mode keeps the
  // bare userId (Bolt always sends teamId; that must not rewrite existing stores).
  const storeKey = storageId({ userId, teamId, enterpriseId });

  // 1. Recall relevant context for this user (keyed on storeKey)
  //    and the prior turns of this conversation, in parallel.
  const [context, history] = await Promise.all([
    buildMemoryContext({ text, storeKey, username }),
    fetchConversationHistory({ client, channelId, threadTs, messageTs, isDm, botUserId }),
  ]);

  // 2. Build the messages array for Claude
  const messages = buildMessages({ text, username, context, history });

  // 3. Call Claude (storeKey is threaded down so calendar tools resolve per-user)
  let replyText;
  try {
    replyText = await callClaude(messages, storeKey);
  } catch (err) {
    console.error('[handler] Claude API error:', err);
    await say({
      text: "Sorry, I ran into a problem generating a response. Please try again.",
      thread_ts: threadTs,
    });
    return;
  }

  // 4. Send the reply
  await say({
    text: replyText,
    thread_ts: threadTs,
  });

  // 5. Store the exchange as memory (fire and forget, don't block the reply)
  storeExchange({ text, replyText, storeKey, username }).catch((err) => {
    console.warn('[handler] Failed to store memory:', err.message);
  });
}

// ---------------------------------------------------------------------------
// Context retrieval
// ---------------------------------------------------------------------------

/**
 * Build a memory context block to prepend to the Claude prompt.
 *
 * Recalls relevant memories for the user and formats them as a concise
 * context section. Returns an empty string if memory is unavailable.
 */
async function buildMemoryContext({ text, storeKey, username }) {
  try {
    const [recallResult, briefingResult, calendarContext] = await Promise.allSettled([
      memory.recall({ query: text, userId: storeKey, limit: MEMORY_RECALL_LIMIT }),
      memory.briefing({ userId: storeKey }),
      buildCalendarContext(storeKey),
    ]);

    const lines = [];

    if (briefingResult.status === 'fulfilled' && briefingResult.value?.briefing) {
      lines.push('## Session Briefing');
      lines.push(briefingResult.value.briefing);
      lines.push('');
    }

    if (calendarContext.status === 'fulfilled' && calendarContext.value) {
      lines.push(calendarContext.value);
    }

    if (recallResult.status === 'fulfilled' && recallResult.value?.results?.length > 0) {
      lines.push('## Relevant Memory Context');
      for (const m of recallResult.value.results) {
        lines.push(`- ${m.content}`);
      }
      lines.push('');
    }

    return lines.length > 0 ? lines.join('\n') : '';
  } catch (err) {
    // Memory being unavailable is non-fatal; Claude still responds.
    console.warn('[handler] Could not retrieve memory context:', err.message);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Conversation history
// ---------------------------------------------------------------------------

// Cap per-message text pulled into history so one giant paste can't blow the
// prompt budget.
const HISTORY_MESSAGE_MAX_CHARS = 2000;

// Page size and page cap for walking a thread to its end. conversations.replies
// always returns a thread oldest-first and offers no "newest N" query: `latest`
// only narrows the window, it does not seek backwards from the end. So reaching
// the recent replies in a long thread means paging to the end. Large pages keep
// even a busy thread down to a couple of calls; the cap bounds the worst case.
const THREAD_PAGE_SIZE = 200;
const THREAD_MAX_PAGES = 5;

/**
 * Fetch the most recent messages of a thread, newest window last.
 *
 * A single conversations.replies call with `limit` returns the OLDEST messages,
 * so any thread longer than the limit would inject its opening messages as
 * "context" instead of the turns around the current mention. Paging to the end
 * and keeping the tail fixes that.
 *
 * @param {object} opts
 * @param {object} opts.client     - Bolt WebClient for this workspace.
 * @param {string} opts.channelId  - Channel the thread lives in.
 * @param {string} opts.threadTs   - Thread parent timestamp.
 * @param {number} opts.limit      - Max messages to keep (the tail).
 * @returns {Promise<Array<object>>} Slack message objects, oldest-first.
 */
export async function fetchThreadTail({ client, channelId, threadTs, limit }) {
  const collected = [];
  let cursor;
  let truncated = false;

  for (let page = 0; page < THREAD_MAX_PAGES; page++) {
    const res = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: THREAD_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });

    collected.push(...(res.messages || []));
    cursor = res.response_metadata?.next_cursor;
    truncated = Boolean(res.has_more && cursor);
    if (!truncated) break;
  }

  if (truncated) {
    console.warn(
      `[handler] Thread ${threadTs} exceeds ${THREAD_PAGE_SIZE * THREAD_MAX_PAGES} messages; ` +
      'history may not reach the newest replies.'
    );
  }

  // Slack leads each response with the thread parent, so a paged fetch can
  // repeat it. Dedupe on ts (keeping first position) before taking the tail.
  const seen = new Set();
  const unique = [];
  for (const m of collected) {
    if (m.ts) {
      if (seen.has(m.ts)) continue;
      seen.add(m.ts);
    }
    unique.push(m);
  }

  return unique.slice(-limit);
}

/**
 * Fetch the prior turns of the current conversation so Claude sees the actual
 * thread, not just semantic memory recall.
 *
 * Sources:
 *   - Message inside an existing thread: conversations.replies for that thread,
 *     paged to the end so long threads contribute their RECENT turns.
 *   - Top-level DM: conversations.history for the DM channel (users rarely
 *     reply inside threads in a 1:1 DM). This one returns newest-first, so a
 *     plain limited call already gives the most recent messages.
 *   - Top-level channel mention: no history (the reply starts a new thread).
 *
 * Requires channels:history / groups:history for threads in channels and
 * im:history for DMs. Installs that predate those scopes degrade gracefully:
 * the fetch fails, we log, and the reply proceeds without history.
 *
 * @returns {Promise<Array<{role: 'user'|'assistant', content: string}>>}
 */
export async function fetchConversationHistory({ client, channelId, threadTs, messageTs, isDm, botUserId }) {
  if (!client || !channelId) return [];

  let slackMessages;
  try {
    if (threadTs && threadTs !== messageTs) {
      slackMessages = await fetchThreadTail({
        client,
        channelId,
        threadTs,
        limit: HISTORY_LIMIT,
      });
    } else if (isDm) {
      const res = await client.conversations.history({
        channel: channelId,
        limit: HISTORY_LIMIT,
      });
      // conversations.history returns newest-first; Claude needs oldest-first.
      slackMessages = (res.messages || []).reverse();
    } else {
      return [];
    }
  } catch (err) {
    console.warn('[handler] Could not fetch conversation history:', err.data?.error || err.message);
    return [];
  }

  const turns = [];
  for (const m of slackMessages) {
    if (!m.text || !m.ts) continue;
    if (m.ts === messageTs) continue; // The current message is appended separately.
    if (m.subtype && m.subtype !== 'bot_message' && m.subtype !== 'thread_broadcast') continue;

    const isAssistant = Boolean(m.bot_id) || (botUserId && m.user === botUserId);
    let content = m.text.trim();
    if (!content) continue;
    if (botUserId) {
      content = content.replace(new RegExp(`^<@${botUserId}>\\s*`, 'i'), '').trim() || content;
    }
    if (content.length > HISTORY_MESSAGE_MAX_CHARS) {
      content = content.slice(0, HISTORY_MESSAGE_MAX_CHARS) + '...';
    }
    turns.push({ role: isAssistant ? 'assistant' : 'user', content });
  }

  // The API requires the first message to be a user turn; drop any leading
  // assistant turns (e.g. the bot's own connect confirmation opening a DM).
  while (turns.length > 0 && turns[0].role === 'assistant') {
    turns.shift();
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the messages array to send to Claude: prior conversation turns first,
 * then the current message.
 *
 * The memory context is injected as a system-level note before the user's
 * actual message so Claude can reference it without the user seeing the raw
 * memory dump.
 */
function buildMessages({ text, username, context, history = [] }) {
  const userContent = context
    ? `[Memory context for ${username}]\n${context}\n[User message]\n${text}`
    : text;

  return [
    ...history,
    {
      role: 'user',
      content: userContent,
    },
  ];
}

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

// Safety cap on tool-use rounds per message, so a pathological loop can't
// spin the API forever.
const MAX_TOOL_ROUNDS = 5;

/**
 * Send messages to Claude and return the response text.
 *
 * Runs the tool-use loop until Claude stops requesting tools (bounded by
 * MAX_TOOL_ROUNDS), so multi-step requests like "create these two events"
 * complete instead of failing after the first round.
 *
 * Note on cache_control: the marker is kept on the stable system prompt, but
 * the default prompt is below the model's minimum cacheable prefix, so it only
 * takes effect for deployments that set a larger SLACK_SYSTEM_PROMPT. It is
 * harmless otherwise.
 */
async function callClaude(messages, storeKey) {
  const calendarConnected = isCalendarConfigured(storeKey);

  const system = [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `Today's date is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`,
    },
    {
      type: "text",
      text: calendarConnected
        ? "This user has connected their Google Calendar. Their upcoming events appear under \"## Upcoming Calendar Events\" when present, and you can create events for them."
        : "This user has NOT connected a Google Calendar yet. If they ask about their schedule or to create an event, tell them to connect it by sending \"/connect-calendar\" (or just \"connect calendar\") to you. Do not claim to have their calendar data.",
    },
  ];

  // Only offer calendar tools when this specific user has connected their calendar.
  const tools = calendarConnected ? CALENDAR_TOOLS : [];
  const toolOptions = tools.length > 0 ? { tools, tool_choice: { type: "auto" } } : {};

  const convo = [...messages];
  let response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: convo,
    ...toolOptions,
  });

  let rounds = 0;
  while (response.stop_reason === "tool_use" && rounds < MAX_TOOL_ROUNDS) {
    rounds += 1;
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (toolUse) => ({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(await dispatchTool(toolUse.name, toolUse.input, storeKey)),
      }))
    );

    convo.push({ role: "assistant", content: response.content });
    convo.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: convo,
      ...toolOptions,
    });
  }

  const block = response.content.find((b) => b.type === "text");
  if (!block) {
    if (response.stop_reason === "tool_use") {
      // Hit MAX_TOOL_ROUNDS with another tool call pending. The work done so
      // far (e.g. events created) is real, so tell the user rather than error.
      return "I did part of that, but the request needed more steps than I allow in one message. Ask me to continue and I'll pick up where I left off.";
    }
    throw new Error(`No text block in Claude response (stop_reason: ${response.stop_reason})`);
  }

  if (response.stop_reason === "max_tokens") {
    return block.text + "\n\n_(I ran out of room mid-reply. Ask me to continue for the rest.)_";
  }
  return block.text;
}

async function dispatchTool(name, input, storeKey) {
  if (name === "create_calendar_event") {
    try {
      const event = await createEvent(storeKey, input);
      console.log("[handler] Calendar event created:", event.summary);
      return { success: true, event };
    } catch (err) {
      console.error("[handler] Failed to create calendar event:", err.message);
      return { success: false, error: err.message };
    }
  }
  return { error: "Unknown tool: " + name };
}

// ---------------------------------------------------------------------------
// Memory storage
// ---------------------------------------------------------------------------

/**
 * Store the conversation exchange as two memories: the user's message and
 * Claudia's response.
 *
 * This runs asynchronously after the reply is sent so it never blocks the
 * user-facing response.
 */
async function storeExchange({ text, replyText, storeKey, username }) {
  // Store user's message
  await memory.remember({
    content: `[Slack] ${username} said: ${text}`,
    userId: storeKey,
    type: 'observation',
    importance: 0.5,
    entities: [username],
  });

  // Store Claudia's reply as a shorter note
  const truncated = replyText.length > 500 ? replyText.slice(0, 497) + '...' : replyText;
  await memory.remember({
    content: `[Slack] Claudia replied to ${username}: ${truncated}`,
    userId: storeKey,
    type: 'observation',
    importance: 0.4,
    entities: [username],
  });

  // Extract and store discrete facts from the exchange at high importance
  extractAndStoreFacts({ text, replyText, storeKey, username }).catch((err) => {
    console.warn('[handler] Fact extraction failed:', err.message);
  });
}

// Skip the extraction pass for tiny messages ("thanks", "ok", "help me
// rephrase this"). They carry no durable facts, and each pass costs an API
// call plus memory writes.
const EXTRACTION_MIN_CHARS = 25;

/**
 * Pull a JSON array out of a model reply that may be wrapped in markdown code
 * fences or surrounded by prose. Returns null if no parseable array is found.
 */
function parseJsonArray(raw) {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Use a fast Claude call to pull structured facts out of a user/assistant exchange
 * and store them as high-importance 'fact' memories so they survive recall ranking.
 */
async function extractAndStoreFacts({ text, replyText, storeKey, username }) {
  if (text.trim().length < EXTRACTION_MIN_CHARS) return;

  const extractionPrompt = `Extract discrete, standalone facts from this conversation exchange. Only extract facts that are clearly stated and would be useful to remember (names, relationships, meeting times, dates, preferences, corrections). Return a JSON array of strings, one fact per item. Return an empty array [] if there is nothing worth extracting.

User said: ${text}
Assistant replied: ${replyText}

Return only a JSON array, no other text.`;

  const response = await anthropic.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 256,
    messages: [{ role: 'user', content: extractionPrompt }],
  });

  const block = response.content.find((b) => b.type === 'text');
  if (!block) return;

  const facts = parseJsonArray(block.text);
  if (!facts) return;

  if (facts.length === 0) return;

  for (const fact of facts) {
    if (typeof fact !== 'string' || !fact.trim()) continue;
    await memory.remember({
      content: fact.trim(),
      userId: storeKey,
      type: 'fact',
      importance: 0.85,
      entities: [username],
    });
  }

  console.log(`[handler] Extracted ${facts.length} fact(s) from exchange for ${username}`);
}

// ---------------------------------------------------------------------------
// Commitment detection
// ---------------------------------------------------------------------------

/**
 * Detect commitment language in a message and store it if found.
 *
 * Patterns: "I'll ...", "I will ...", "I promise ...", "I'll get back to you"
 * This is best-effort; the memory daemon's consolidation pass does deeper
 * pattern analysis overnight.
 */
export async function detectAndStoreCommitment({ text, userId, username, teamId, enterpriseId }) {
  const storeKey = storageId({ userId, teamId, enterpriseId });
  // "I'll" requires an apostrophe (straight or curly): a bare /i'?ll/ also
  // matches the word "ill" ("I feel ill" is not a commitment). Losing the rare
  // typo'd "Ill send it" is a fair trade against that false positive.
  const COMMITMENT_PATTERNS = [
    /\bi(?:'|’)ll\b/i,
    /\bi will\b/i,
    /\bi promise\b/i,
    /\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    /\bby (end of|eod|eow)\b/i,
    /\bby (tomorrow|next week)\b/i,
    /\bsending.*(today|tomorrow|this week)\b/i,
  ];

  const isCommitment = COMMITMENT_PATTERNS.some((re) => re.test(text));
  if (!isCommitment) return;

  try {
    await memory.remember({
      content: `[Commitment] ${username} committed: "${text}"`,
      userId: storeKey,
      type: 'commitment',
      importance: 0.85,
      entities: [username],
    });
  } catch (err) {
    console.warn('[handler] Could not store commitment:', err.message);
  }
}


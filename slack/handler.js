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
  SYSTEM_PROMPT,
  MAX_TOKENS,
  MEMORY_RECALL_LIMIT,
} from './config.js';
import * as memory from './memory-client.js';
import { buildCalendarContext, createEvent, isCalendarConfigured } from './calendar-client.js';

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
 * @param {string} opts.text        - The user's message text (already cleaned)
 * @param {string} opts.userId      - Slack user ID (e.g. "U012AB3CD")
 * @param {string} opts.username    - Slack display name
 * @param {string} opts.channelId   - Slack channel ID
 * @param {string} opts.threadTs    - Thread timestamp to reply into
 * @param {Function} opts.say       - Bolt say() function or equivalent
 */
export async function handleMessage({ text, userId, username, channelId, threadTs, say }) {
  // 1. Recall relevant context for this user
  const context = await buildMemoryContext({ text, userId, username });

  // 2. Build the messages array for Claude
  const messages = buildMessages({ text, username, context });

  // 3. Call Claude
  let replyText;
  try {
    replyText = await callClaude(messages);
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
  storeExchange({ text, replyText, userId, username }).catch((err) => {
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
async function buildMemoryContext({ text, userId, username }) {
  try {
    const [recallResult, briefingResult, calendarContext] = await Promise.allSettled([
      memory.recall({ query: text, userId, limit: MEMORY_RECALL_LIMIT }),
      memory.briefing({ userId }),
      buildCalendarContext(),
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
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the messages array to send to Claude.
 *
 * The memory context is injected as a system-level note before the user's
 * actual message so Claude can reference it without the user seeing the raw
 * memory dump.
 */
function buildMessages({ text, username, context }) {
  const userContent = context
    ? `[Memory context for ${username}]\n${context}\n[User message]\n${text}`
    : text;

  return [
    {
      role: 'user',
      content: userContent,
    },
  ];
}

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

/**
 * Send messages to Claude and return the response text.
 *
 * Uses prompt caching on the system prompt to reduce latency and cost for
 * repeated interactions (system prompt is stable across requests).
 */
async function callClaude(messages) {
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
  ];

  const tools = isCalendarConfigured() ? CALENDAR_TOOLS : [];
  const toolOptions = tools.length > 0 ? { tools, tool_choice: { type: "auto" } } : {};

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages,
    ...toolOptions,
  });

  if (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (toolUse) => ({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(await dispatchTool(toolUse.name, toolUse.input)),
      }))
    );

    const continued = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [
        ...messages,
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults },
      ],
      ...toolOptions,
    });

    const block = continued.content.find((b) => b.type === "text");
    if (!block) throw new Error("No text block in Claude follow-up response");
    return block.text;
  }

  const block = response.content.find((b) => b.type === "text");
  if (!block) throw new Error("No text block in Claude response");
  return block.text;
}

async function dispatchTool(name, input) {
  if (name === "create_calendar_event") {
    try {
      const event = await createEvent(input);
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
async function storeExchange({ text, replyText, userId, username }) {
  // Store user's message
  await memory.remember({
    content: `[Slack] ${username} said: ${text}`,
    userId,
    type: 'observation',
    importance: 0.5,
    entities: [username],
  });

  // Store Claudia's reply as a shorter note
  const truncated = replyText.length > 500 ? replyText.slice(0, 497) + '...' : replyText;
  await memory.remember({
    content: `[Slack] Claudia replied to ${username}: ${truncated}`,
    userId,
    type: 'observation',
    importance: 0.4,
    entities: [username],
  });

  // Extract and store discrete facts from the exchange at high importance
  extractAndStoreFacts({ text, replyText, userId, username }).catch((err) => {
    console.warn('[handler] Fact extraction failed:', err.message);
  });
}

/**
 * Use a fast Claude call to pull structured facts out of a user/assistant exchange
 * and store them as high-importance 'fact' memories so they survive recall ranking.
 */
async function extractAndStoreFacts({ text, replyText, userId, username }) {
  const extractionPrompt = `Extract discrete, standalone facts from this conversation exchange. Only extract facts that are clearly stated and would be useful to remember (names, relationships, meeting times, dates, preferences, corrections). Return a JSON array of strings, one fact per item. Return an empty array [] if there are nothing worth extracting.

User said: ${text}
Assistant replied: ${replyText}

Return only a JSON array, no other text.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: extractionPrompt }],
  });

  const block = response.content.find((b) => b.type === 'text');
  if (!block) return;

  let facts;
  try {
    facts = JSON.parse(block.text.trim());
  } catch {
    return;
  }

  if (!Array.isArray(facts) || facts.length === 0) return;

  for (const fact of facts) {
    if (typeof fact !== 'string' || !fact.trim()) continue;
    await memory.remember({
      content: fact.trim(),
      userId,
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
export async function detectAndStoreCommitment({ text, userId, username }) {
  const COMMITMENT_PATTERNS = [
    /\bi'?ll\b/i,
    /\bi will\b/i,
    /\bi promise\b/i,
    /\bi'll get back\b/i,
    /\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    /\bby (end of|eod|eow)\b/i,
    /\bby (tomorrow|next week|friday)\b/i,
    /\bsending.*(today|tomorrow|this week)\b/i,
  ];

  const isCommitment = COMMITMENT_PATTERNS.some((re) => re.test(text));
  if (!isCommitment) return;

  try {
    await memory.remember({
      content: `[Commitment] ${username} committed: "${text}"`,
      userId,
      type: 'commitment',
      importance: 0.85,
      entities: [username],
    });
  } catch (err) {
    console.warn('[handler] Could not store commitment:', err.message);
  }
}


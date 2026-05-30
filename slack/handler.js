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

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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
    const [recallResult, briefingResult] = await Promise.allSettled([
      memory.recall({ query: text, userId, limit: MEMORY_RECALL_LIMIT }),
      memory.briefing({ userId }),
    ]);

    const lines = [];

    if (briefingResult.status === 'fulfilled' && briefingResult.value?.briefing) {
      lines.push('## Session Briefing');
      lines.push(briefingResult.value.briefing);
      lines.push('');
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
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }, // Cache stable system prompt
      },
      {
        type: 'text',
        text: `Today's date is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`,
      },
    ],
    messages,
  });

  const block = response.content.find((b) => b.type === 'text');
  if (!block) throw new Error('No text block in Claude response');
  return block.text;
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

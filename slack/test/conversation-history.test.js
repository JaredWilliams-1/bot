/**
 * Tests for Slack conversation history assembly.
 *
 * The thread path is the interesting one. conversations.replies returns a
 * thread OLDEST-first and has no "newest N" query, so a single limited call
 * yields the thread's opening messages. For any thread longer than the limit
 * that means stale context instead of the turns around the current mention.
 * These tests lock in that we page to the end and keep the tail, that the
 * paging is bounded, and that a repeated thread parent is deduped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js validates required env at import time, so stub before loading the
// handler. Assign explicitly (not ||=) so an ambient .env cannot skew results.
process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.MEMORY_API_KEY = 'test-memory-key';
process.env.SLACK_HISTORY_LIMIT = '20';
delete process.env.SLACK_BOT_CLIENT_ID;
delete process.env.SLACK_BOT_CLIENT_SECRET;
delete process.env.SLACK_STATE_SECRET;

const { fetchThreadTail, fetchConversationHistory } = await import('../handler.js');

const HISTORY_LIMIT = 20;

/** Build `count` plain user messages with increasing timestamps. */
function thread(count, { user = 'U1' } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    type: 'message',
    user,
    text: `msg-${i}`,
    ts: `1000.${String(i).padStart(4, '0')}`,
  }));
}

/**
 * Fake Bolt client for conversations.replies.
 *
 * Mirrors the real API: pages are oldest-first, honor the requested `limit`,
 * expose next_cursor/has_more, and repeat the thread parent at the head of
 * every page (which is why the implementation dedupes on ts).
 */
function fakeThreadClient(messages) {
  const calls = [];
  return {
    calls,
    conversations: {
      async replies({ channel, ts, limit, cursor }) {
        calls.push({ channel, ts, limit, cursor });
        const start = cursor ? Number(cursor) : 0;
        const page = messages.slice(start, start + limit);
        const next = start + limit;
        const hasMore = next < messages.length;
        return {
          messages: start === 0 ? page : [messages[0], ...page],
          has_more: hasMore,
          response_metadata: hasMore ? { next_cursor: String(next) } : {},
        };
      },
    },
  };
}

test('a thread shorter than the limit is returned whole, in one call', async () => {
  const messages = thread(5);
  const client = fakeThreadClient(messages);

  const result = await fetchThreadTail({
    client,
    channelId: 'C1',
    threadTs: messages[0].ts,
    limit: HISTORY_LIMIT,
  });

  assert.equal(client.calls.length, 1);
  assert.deepEqual(result.map((m) => m.text), messages.map((m) => m.text));
});

test('a long thread yields its NEWEST messages, not its opening ones', async () => {
  const messages = thread(450);
  const client = fakeThreadClient(messages);

  const result = await fetchThreadTail({
    client,
    channelId: 'C1',
    threadTs: messages[0].ts,
    limit: HISTORY_LIMIT,
  });

  assert.equal(result.length, HISTORY_LIMIT);
  // The tail of the thread, still oldest-first within the window.
  assert.equal(result[0].text, 'msg-430');
  assert.equal(result[result.length - 1].text, 'msg-449');
  // The regression this guards: the opening messages must NOT be the context.
  assert.ok(!result.some((m) => m.text === 'msg-0'));
});

test('the repeated thread parent is deduped across pages', async () => {
  const messages = thread(450);
  const client = fakeThreadClient(messages);

  // A limit wide enough to span every page, so the repeated parent would show
  // up multiple times if it were not deduped.
  const result = await fetchThreadTail({
    client,
    channelId: 'C1',
    threadTs: messages[0].ts,
    limit: 1000,
  });

  assert.equal(result.length, 450);
  assert.equal(result.filter((m) => m.ts === messages[0].ts).length, 1);
  assert.equal(new Set(result.map((m) => m.ts)).size, result.length);
});

test('paging is bounded so a huge thread cannot spin the API', async () => {
  const messages = thread(5000);
  const client = fakeThreadClient(messages);

  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await fetchThreadTail({
      client,
      channelId: 'C1',
      threadTs: messages[0].ts,
      limit: HISTORY_LIMIT,
    });
  } finally {
    console.warn = warn;
  }

  assert.ok(client.calls.length <= 5, `expected <= 5 calls, got ${client.calls.length}`);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /exceeds/);
});

test('thread history maps roles and excludes the triggering message', async () => {
  const messages = [
    { type: 'message', user: 'U1', text: 'first question', ts: '1000.0001' },
    { type: 'message', user: 'UBOT', bot_id: 'B1', text: 'bot answer', ts: '1000.0002' },
    { type: 'message', user: 'U1', text: '<@UBOT> follow up', ts: '1000.0003' },
  ];
  const client = fakeThreadClient(messages);

  const turns = await fetchConversationHistory({
    client,
    channelId: 'C1',
    threadTs: '1000.0001',
    messageTs: '1000.0003',
    isDm: false,
    botUserId: 'UBOT',
  });

  assert.deepEqual(turns, [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'bot answer' },
  ]);
});

test('DM history is reversed into oldest-first order', async () => {
  const client = {
    conversations: {
      // conversations.history returns newest-first.
      async history() {
        return {
          messages: [
            { type: 'message', user: 'U1', text: 'newest', ts: '1000.0003' },
            { type: 'message', user: 'U1', text: 'middle', ts: '1000.0002' },
            { type: 'message', user: 'U1', text: 'oldest', ts: '1000.0001' },
          ],
        };
      },
    },
  };

  const turns = await fetchConversationHistory({
    client,
    channelId: 'D1',
    threadTs: '1000.0003',
    messageTs: '1000.0003',
    isDm: true,
    botUserId: 'UBOT',
  });

  assert.deepEqual(turns.map((t) => t.content), ['oldest', 'middle']);
});

test('a failed history fetch degrades to no history', async () => {
  const client = {
    conversations: {
      async replies() {
        throw Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } });
      },
    },
  };

  const warn = console.warn;
  console.warn = () => {};
  try {
    const turns = await fetchConversationHistory({
      client,
      channelId: 'C1',
      threadTs: '1000.0001',
      messageTs: '1000.0009',
      isDm: false,
      botUserId: 'UBOT',
    });
    assert.deepEqual(turns, []);
  } finally {
    console.warn = warn;
  }
});

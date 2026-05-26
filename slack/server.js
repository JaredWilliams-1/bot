/**
 * Claudia Slack Bot Server
 *
 * Entry point for the Slack integration. Handles:
 *   - App mention events (@claudia ...)
 *   - Direct messages to the bot
 *   - Health endpoint for Docker/load-balancer probes
 *
 * Supports both HTTP Events API mode (default) and Socket Mode
 * (set SLACK_SOCKET_MODE=true when you can't expose a public endpoint).
 *
 * Usage:
 *   node server.js
 */

import { App, LogLevel } from '@slack/bolt';
import express from 'express';
import { handleMessage, detectAndStoreCommitment } from './handler.js';
import { isHealthy } from './memory-client.js';
import {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_APP_TOKEN,
  USE_SOCKET_MODE,
  PORT,
} from './config.js';
import 'dotenv/config';

// ---------------------------------------------------------------------------
// Bolt app setup
// ---------------------------------------------------------------------------

const boltOptions = {
  token: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  logLevel: process.env.NODE_ENV === 'production' ? LogLevel.WARN : LogLevel.INFO,
};

if (USE_SOCKET_MODE) {
  // Socket Mode requires an app-level token (xapp-...)
  boltOptions.socketMode = true;
  boltOptions.appToken = SLACK_APP_TOKEN;
  if (!SLACK_APP_TOKEN) {
    throw new Error('SLACK_APP_TOKEN is required when SLACK_SOCKET_MODE=true');
  }
} else {
  // HTTP Events API: Bolt manages its own Express receiver internally,
  // but we add a sidecar Express app for the /health endpoint on the
  // same port so Docker probes work without needing Bolt internals.
  boltOptions.port = PORT;
}

const slackApp = new App(boltOptions);

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

/**
 * Extract a clean text string from a Slack message event.
 * Strips bot mention tokens (<@U...>) from the beginning of the text.
 */
function cleanText(text = '', botUserId = '') {
  if (!text) return '';
  // Remove leading bot mention
  const mentionPattern = new RegExp(`^<@${botUserId}>\\s*`, 'i');
  return text.replace(mentionPattern, '').trim();
}

// ---------------------------------------------------------------------------
// App mention handler
// ---------------------------------------------------------------------------

slackApp.event('app_mention', async ({ event, say, client }) => {
  const { user, text, ts, thread_ts, channel } = event;

  try {
    // Fetch user info for display name
    const userInfo = await client.users.info({ user }).catch(() => null);
    const username = userInfo?.user?.real_name || userInfo?.user?.name || user;

    // Get the bot's user ID to strip the mention prefix
    const authInfo = await client.auth.test().catch(() => null);
    const botUserId = authInfo?.user_id || '';

    const cleanedText = cleanText(text, botUserId);
    if (!cleanedText) return; // Ignore empty mentions

    console.log(`[mention] ${username} (${user}): ${cleanedText.slice(0, 80)}`);

    // Detect commitments before handling (fire and forget)
    detectAndStoreCommitment({
      text: cleanedText,
      userId: user,
      username,
    }).catch(() => {});

    await handleMessage({
      text: cleanedText,
      userId: user,
      username,
      channelId: channel,
      threadTs: thread_ts || ts,
      say,
    });
  } catch (err) {
    console.error('[mention] Error handling app_mention:', err);
    await say({
      text: "Something went wrong. Please try again.",
      thread_ts: event.thread_ts || event.ts,
    }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Direct message handler
// ---------------------------------------------------------------------------

slackApp.message(async ({ message, say, client }) => {
  // Only handle DMs (channel type "im") and ignore bot messages / edits
  if (message.channel_type !== 'im') return;
  if (message.subtype) return; // Ignore message edits, deletes, etc.
  if (message.bot_id) return;  // Ignore messages from bots

  const { user, text, ts, thread_ts, channel } = message;

  try {
    const userInfo = await client.users.info({ user }).catch(() => null);
    const username = userInfo?.user?.real_name || userInfo?.user?.name || user;

    const cleanedText = (text || '').trim();
    if (!cleanedText) return;

    console.log(`[dm] ${username} (${user}): ${cleanedText.slice(0, 80)}`);

    detectAndStoreCommitment({ text: cleanedText, userId: user, username }).catch(() => {});

    await handleMessage({
      text: cleanedText,
      userId: user,
      username,
      channelId: channel,
      threadTs: thread_ts || ts,
      say,
    });
  } catch (err) {
    console.error('[dm] Error handling DM:', err);
    await say({
      text: "Something went wrong. Please try again.",
      thread_ts: message.thread_ts || message.ts,
    }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

slackApp.error(async (error) => {
  console.error('[bolt] Unhandled error:', error.code, error.message);
});

// ---------------------------------------------------------------------------
// Health endpoint (sidecar Express server for Docker probes)
// ---------------------------------------------------------------------------

// In Socket Mode, Bolt does not open an HTTP port, so we add our own.
// In HTTP mode, Bolt's receiver already owns PORT, so we put health on PORT+1.
const healthApp = express();
const healthPort = USE_SOCKET_MODE ? PORT : PORT + 1;

healthApp.get('/health', async (_req, res) => {
  const memoryOk = await isHealthy();
  const status = memoryOk ? 'ok' : 'degraded';
  res.status(memoryOk ? 200 : 503).json({
    status,
    memory: memoryOk ? 'connected' : 'unavailable',
    uptime: process.uptime(),
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  try {
    await slackApp.start();

    healthApp.listen(healthPort, () => {
      console.log(`[health] listening on :${healthPort}/health`);
    });

    if (USE_SOCKET_MODE) {
      console.log('[claudia-slack] Socket Mode started');
    } else {
      console.log(`[claudia-slack] HTTP Events API listening on :${PORT}`);
    }

    // Log memory daemon connectivity
    const memHealthy = await isHealthy();
    if (memHealthy) {
      console.log(`[claudia-slack] Memory daemon connected at ${process.env.MEMORY_API_URL || 'http://localhost:3850'}`);
    } else {
      console.warn('[claudia-slack] Memory daemon is not reachable. Responses will have no memory context.');
    }
  } catch (err) {
    console.error('[claudia-slack] Failed to start:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[claudia-slack] Shutting down...');
  await slackApp.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await slackApp.stop();
  process.exit(0);
});

start();

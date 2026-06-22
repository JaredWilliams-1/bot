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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleMessage, detectAndStoreCommitment } from './handler.js';
import { isHealthy } from './memory-client.js';
import { generateAuthUrl, handleOAuthCallback, isCalendarConfigured } from './calendar-client.js';
import {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_APP_TOKEN,
  USE_SOCKET_MODE,
  PORT,
  GOOGLE_REDIRECT_URI,
  GOOGLE_REDIRECT_PATH,
  HELP_TEXT,
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

// Fires only when the WHOLE trimmed message is the connect request itself
// (e.g. "/connect-calendar", "connect calendar", "connect my calendar").
// Anchored start AND end so real questions like "how do I connect my Google
// calendar to Zoom?" fall through to the normal Claude pipeline.
const CONNECT_CALENDAR_PATTERN = /^(?:\/connect-calendar|connect(?:\s+my)?\s+calendar)\s*$/i;

// Tight, anchored keyword fallbacks so plain "help" / "info" work as a DM or
// mention even before the slash commands are installed. Anchored start AND end
// so a normal sentence containing "help" or "info" still falls through to Claude.
const HELP_PATTERN = /^(?:\/help|help)\s*$/i;
const INFO_PATTERN = /^(?:\/info|info)\s*$/i;

/**
 * Read the bot version from the root package.json at runtime.
 * server.js lives in slack/, so the root package.json is one level up.
 *
 * @returns {string} The package version, or "unknown" if it can't be read.
 */
function readBotVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Build the /info status text for a given user.
 * Reports bot identity, version, memory connectivity, and whether THIS user
 * has connected their own Google Calendar. Uses Slack mrkdwn, no em dashes.
 *
 * @param {string} userId - Slack user ID, used for the per-user calendar check.
 * @returns {Promise<string>} The formatted status message.
 */
async function buildInfoText(userId) {
  const version = readBotVersion();
  const memoryOk = await isHealthy().catch(() => false);
  const calendarOk = isCalendarConfigured(userId);

  return (
    '*Claudia* is a relationship-aware AI assistant that learns how you work.\n\n' +
    `• *Version:* ${version}\n` +
    `• *Memory:* ${memoryOk ? 'connected' : 'unavailable'}\n` +
    `• *Your calendar:* ${calendarOk ? 'connected' : 'not connected (send /connect-calendar)'}`
  );
}

/**
 * Start the per-user Google Calendar connect flow.
 * Generates a consent URL whose `state` carries the userId, then DMs the link
 * to the user so the OAuth callback can save their token.
 *
 * @param {object} opts
 * @param {string} opts.userId - Slack user ID (becomes the OAuth state).
 * @param {Function} opts.say  - Bolt say() for the current DM/thread.
 * @param {string} [opts.threadTs] - Optional thread timestamp to reply into.
 */
async function startCalendarConnect({ userId, say, threadTs }) {
  try {
    const url = generateAuthUrl(userId);
    await say({
      text:
        'To connect your Google Calendar, open this link and approve access:\n' +
        url +
        '\n\nOnce you approve, I\'ll be able to see your schedule and create events for you. ' +
        'The link is unique to you, so don\'t share it.',
      thread_ts: threadTs,
    });
  } catch (err) {
    console.error('[connect-calendar] Failed to start connect flow:', err.message);
    await say({
      text:
        'I couldn\'t start the calendar connection. Google Calendar may not be ' +
        'configured on this server yet. Ask the admin to set GOOGLE_CLIENT_ID / ' +
        'GOOGLE_CLIENT_SECRET.',
      thread_ts: threadTs,
    }).catch(() => {});
  }
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

    // Static keyword fallbacks: short-circuit before the Claude pipeline.
    if (CONNECT_CALENDAR_PATTERN.test(cleanedText)) {
      await startCalendarConnect({ userId: user, say, threadTs: thread_ts || ts });
      return;
    }
    if (HELP_PATTERN.test(cleanedText)) {
      await say({ text: HELP_TEXT, thread_ts: thread_ts || ts });
      return;
    }
    if (INFO_PATTERN.test(cleanedText)) {
      await say({ text: await buildInfoText(user), thread_ts: thread_ts || ts });
      return;
    }

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

    // Static keyword fallbacks: short-circuit before the Claude pipeline.
    if (CONNECT_CALENDAR_PATTERN.test(cleanedText)) {
      await startCalendarConnect({ userId: user, say, threadTs: thread_ts || ts });
      return;
    }
    if (HELP_PATTERN.test(cleanedText)) {
      await say({ text: HELP_TEXT, thread_ts: thread_ts || ts });
      return;
    }
    if (INFO_PATTERN.test(cleanedText)) {
      await say({ text: await buildInfoText(user), thread_ts: thread_ts || ts });
      return;
    }

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
// Slash command: /connect-calendar
// ---------------------------------------------------------------------------
//
// Note: slash commands require registering "/connect-calendar" in the Slack app
// config (and, in HTTP mode, a public request URL). The DM/mention keyword
// ("connect calendar") works WITHOUT that extra setup, so it's the primary path.

slackApp.command('/connect-calendar', async ({ command, ack, respond }) => {
  await ack();
  try {
    const url = generateAuthUrl(command.user_id);
    await respond({
      response_type: 'ephemeral',
      text:
        'To connect your Google Calendar, open this link and approve access:\n' +
        url +
        '\n\nThe link is unique to you, so don\'t share it.',
    });
  } catch (err) {
    console.error('[connect-calendar] Slash command failed:', err.message);
    await respond({
      response_type: 'ephemeral',
      text:
        'I couldn\'t start the calendar connection. Google Calendar may not be ' +
        'configured on this server yet.',
    });
  }
});

// ---------------------------------------------------------------------------
// Slash command: /help
// ---------------------------------------------------------------------------
//
// Like /connect-calendar, this requires registering "/help" in the Slack app
// config. The DM/mention keyword ("help") works WITHOUT that extra setup.

slackApp.command('/help', async ({ ack, respond }) => {
  await ack();
  await respond({
    response_type: 'ephemeral',
    text: HELP_TEXT,
  });
});

// ---------------------------------------------------------------------------
// Slash command: /info
// ---------------------------------------------------------------------------
//
// Reports bot version, memory connectivity, and the calling user's calendar
// status. The DM/mention keyword ("info") works WITHOUT slash registration.

slackApp.command('/info', async ({ command, ack, respond }) => {
  await ack();
  try {
    await respond({
      response_type: 'ephemeral',
      text: await buildInfoText(command.user_id),
    });
  } catch (err) {
    console.error('[info] Slash command failed:', err.message);
    await respond({
      response_type: 'ephemeral',
      text: "Sorry, I couldn't pull my status just now. Please try again.",
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
// Google Calendar OAuth callback
// ---------------------------------------------------------------------------
//
// This route receives the redirect from Google's consent screen. It runs on the
// SAME sidecar Express app as /health, so in Socket Mode (the VPS deployment)
// it listens on `healthPort` (= SLACK_PORT). That port MUST be published in
// docker-compose.yml and reachable at the public GOOGLE_REDIRECT_URI.
//
// The route path is derived from GOOGLE_REDIRECT_URI (default /oauth2callback).

healthApp.get(GOOGLE_REDIRECT_PATH, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    res.status(400).send(oauthHtml('Calendar connection cancelled', `Google reported: ${error}`));
    return;
  }
  if (!code || !state) {
    res.status(400).send(oauthHtml('Calendar connection failed', 'Missing authorization code or state.'));
    return;
  }

  try {
    const userId = await handleOAuthCallback(String(code), String(state));
    res.status(200).send(oauthHtml('Calendar connected!', 'You can close this tab and head back to Slack.'));

    // Best-effort: DM the user to confirm.
    slackApp.client.chat
      .postMessage({
        channel: userId,
        text: 'Your Google Calendar is connected. I can now see your schedule and create events for you.',
      })
      .catch((err) => console.warn('[oauth] Could not DM connect confirmation:', err.message));
  } catch (err) {
    console.error('[oauth] Callback failed:', err.message);
    res.status(500).send(oauthHtml('Calendar connection failed', 'Something went wrong exchanging the code. Please try /connect-calendar again.'));
  }
});

/** Render a minimal HTML page for the OAuth callback response. */
function oauthHtml(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    '<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5}h2{margin-bottom:.5rem}</style>' +
    `</head><body><h2>${title}</h2><p>${body}</p></body></html>`;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  try {
    await slackApp.start();

    healthApp.listen(healthPort, () => {
      console.log(`[health] listening on :${healthPort}/health`);
      console.log(`[oauth] calendar callback listening on :${healthPort}${GOOGLE_REDIRECT_PATH}`);
      // Warn if the configured redirect URI's port won't reach this listener.
      try {
        const configuredPort = parseInt(
          new URL(GOOGLE_REDIRECT_URI).port || (new URL(GOOGLE_REDIRECT_URI).protocol === 'https:' ? '443' : '80'),
          10
        );
        const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(GOOGLE_REDIRECT_URI);
        if (isLocal && configuredPort !== healthPort) {
          console.warn(
            `[oauth] WARNING: GOOGLE_REDIRECT_URI port (${configuredPort}) does not match the callback listener port (${healthPort}). ` +
            'Google will redirect to a port nothing is listening on. ' +
            (USE_SOCKET_MODE
              ? `Set GOOGLE_REDIRECT_URI to use port ${healthPort}.`
              : `In HTTP mode the sidecar runs on SLACK_PORT+1 (${healthPort}); point GOOGLE_REDIRECT_URI there.`)
          );
        }
      } catch {
        // Non-fatal: redirect URI parsing is best-effort for the warning only.
      }
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

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

import { App, LogLevel, SocketModeReceiver } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleMessage, detectAndStoreCommitment } from './handler.js';
import { isHealthy } from './memory-client.js';
import { generateAuthUrl, handleOAuthCallback, isCalendarConfigured } from './calendar-client.js';
import { FileInstallationStore } from './installation-store.js';
import {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_APP_TOKEN,
  USE_SOCKET_MODE,
  PORT,
  GOOGLE_REDIRECT_URI,
  GOOGLE_REDIRECT_PATH,
  HELP_TEXT,
  MULTI_TENANT,
  SLACK_BOT_CLIENT_ID,
  SLACK_BOT_CLIENT_SECRET,
  SLACK_STATE_SECRET,
  SLACK_SCOPES,
  SLACK_INSTALL_PORT,
} from './config.js';
import 'dotenv/config';

// ---------------------------------------------------------------------------
// Bolt app setup
// ---------------------------------------------------------------------------
//
// Two modes:
//   - Multi-tenant (MULTI_TENANT true): workspaces install the app themselves
//     via "Add to Slack". A SocketModeReceiver runs the OAuth install flow on
//     its own HTTP port while events flow over the socket. Bolt resolves the
//     per-workspace bot token from the installation store on every event, so we
//     do NOT pass a static `token`.
//   - Single-workspace (default): the EXACT prior behavior using the static
//     SLACK_BOT_TOKEN. Unchanged so existing deployments keep working.

// Shared installation store, only used in multi-tenant mode. Also used by the
// Google OAuth callback to look up a workspace's bot token so it can DM the user.
const installationStore = MULTI_TENANT ? new FileInstallationStore() : null;

let slackApp;

if (MULTI_TENANT) {
  if (!SLACK_APP_TOKEN) {
    throw new Error('SLACK_APP_TOKEN (xapp-...) is required for multi-tenant Socket Mode.');
  }
  // SocketModeReceiver with OAuth enabled. It serves /slack/install and
  // /slack/oauth_redirect on its own HTTP server (installerOptions.port) while
  // events arrive over the socket via appToken.
  const receiver = new SocketModeReceiver({
    appToken: SLACK_APP_TOKEN,
    clientId: SLACK_BOT_CLIENT_ID,
    clientSecret: SLACK_BOT_CLIENT_SECRET,
    stateSecret: SLACK_STATE_SECRET,
    scopes: SLACK_SCOPES,
    installationStore,
    logLevel: process.env.NODE_ENV === 'production' ? LogLevel.WARN : LogLevel.INFO,
    installerOptions: {
      // Skip the extra "Add to Slack" landing page; go straight to authorize.
      directInstall: true,
      // HTTP port for the install + oauth_redirect routes. Caddy proxies
      // /slack/* here. Must differ from the sidecar health/callback port.
      port: SLACK_INSTALL_PORT,
    },
  });

  slackApp = new App({
    receiver,
    logLevel: process.env.NODE_ENV === 'production' ? LogLevel.WARN : LogLevel.INFO,
  });
} else {
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

  slackApp = new App(boltOptions);
}

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
 * @param {string|object} idOrContext - Slack user ID, or a context object
 *   { userId, teamId, enterpriseId }, used for the per-user calendar check.
 * @returns {Promise<string>} The formatted status message.
 */
async function buildInfoText(idOrContext) {
  const version = readBotVersion();
  const memoryOk = await isHealthy().catch(() => false);
  const calendarOk = isCalendarConfigured(idOrContext);

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
 * @param {string} opts.userId  - RAW Slack user ID.
 * @param {string} [opts.teamId]       - Slack team ID (multi-tenant namespacing).
 * @param {string} [opts.enterpriseId] - Slack enterprise ID (org installs).
 * @param {boolean} [opts.isEnterpriseInstall] - Bolt's org-wide install flag,
 *   carried so the callback can look the installation up under the right key.
 * @param {Function} opts.say   - Bolt say() for the current DM/thread.
 * @param {string} [opts.threadTs] - Optional thread timestamp to reply into.
 */
async function startCalendarConnect({ userId, teamId, enterpriseId, isEnterpriseInstall, say, threadTs }) {
  try {
    const url = generateAuthUrl({ userId, teamId, enterpriseId, isEnterpriseInstall });
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
// Shared message routing (mentions and DMs)
// ---------------------------------------------------------------------------

/**
 * Route an incoming mention or DM: keyword short-circuits first, then the
 * Claude pipeline. Shared by the app_mention and message handlers so the two
 * paths cannot drift apart.
 *
 * @param {object} opts
 * @param {string} opts.kind      - 'mention' | 'dm' (log prefix)
 * @param {string} opts.user      - Raw Slack user ID
 * @param {string} opts.text      - Raw message text (mention prefix not yet stripped)
 * @param {string} opts.ts        - Message timestamp
 * @param {string} [opts.threadTs]- Thread timestamp when inside a thread
 * @param {string} opts.channel   - Channel ID
 * @param {object} opts.context   - Bolt context (teamId, enterpriseId, botUserId)
 * @param {Function} opts.say     - Bolt say()
 * @param {object} opts.client    - Bolt WebClient for this workspace
 */
async function routeMessage({ kind, user, text, ts, threadTs, channel, context, say, client }) {
  // Team/enterprise context for multi-tenant per-user data namespacing.
  // Bolt resolves botUserId per workspace; no auth.test() round-trip needed.
  const { teamId, enterpriseId, isEnterpriseInstall, botUserId } = context;
  const replyThreadTs = threadTs || ts;

  try {
    const userInfo = await client.users.info({ user }).catch(() => null);
    const username = userInfo?.user?.real_name || userInfo?.user?.name || user;

    const cleanedText = cleanText(text, botUserId || '');
    if (!cleanedText) return; // Ignore empty mentions/messages

    console.log(`[${kind}] ${username} (${user}): ${cleanedText.slice(0, 80)}`);

    // Static keyword fallbacks: short-circuit before the Claude pipeline.
    if (CONNECT_CALENDAR_PATTERN.test(cleanedText)) {
      await startCalendarConnect({
        userId: user,
        teamId,
        enterpriseId,
        isEnterpriseInstall,
        say,
        threadTs: replyThreadTs,
      });
      return;
    }
    if (HELP_PATTERN.test(cleanedText)) {
      await say({ text: HELP_TEXT, thread_ts: replyThreadTs });
      return;
    }
    if (INFO_PATTERN.test(cleanedText)) {
      await say({ text: await buildInfoText({ userId: user, teamId, enterpriseId }), thread_ts: replyThreadTs });
      return;
    }

    // Detect commitments before handling (fire and forget)
    detectAndStoreCommitment({
      text: cleanedText,
      userId: user,
      username,
      teamId,
      enterpriseId,
    }).catch(() => {});

    await handleMessage({
      text: cleanedText,
      userId: user,
      username,
      channelId: channel,
      threadTs: replyThreadTs,
      messageTs: ts,
      isDm: kind === 'dm',
      botUserId,
      client,
      teamId,
      enterpriseId,
      say,
    });
  } catch (err) {
    console.error(`[${kind}] Error handling message:`, err);
    await say({
      text: "Something went wrong. Please try again.",
      thread_ts: replyThreadTs,
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// App mention handler
// ---------------------------------------------------------------------------

slackApp.event('app_mention', async ({ event, context, say, client }) => {
  const { user, text, ts, thread_ts, channel } = event;
  await routeMessage({ kind: 'mention', user, text, ts, threadTs: thread_ts, channel, context, say, client });
});

// ---------------------------------------------------------------------------
// Direct message handler
// ---------------------------------------------------------------------------

slackApp.message(async ({ message, context, say, client }) => {
  // Only handle DMs (channel type "im") and ignore bot messages / edits
  if (message.channel_type !== 'im') return;
  if (message.subtype) return; // Ignore message edits, deletes, etc.
  if (message.bot_id) return;  // Ignore messages from bots

  const { user, text, ts, thread_ts, channel } = message;
  await routeMessage({ kind: 'dm', user, text, ts, threadTs: thread_ts, channel, context, say, client });
});

// ---------------------------------------------------------------------------
// Slash command: /connect-calendar
// ---------------------------------------------------------------------------
//
// Note: slash commands require registering "/connect-calendar" in the Slack app
// config (and, in HTTP mode, a public request URL). The DM/mention keyword
// ("connect calendar") works WITHOUT that extra setup, so it's the primary path.

slackApp.command('/connect-calendar', async ({ command, context, ack, respond }) => {
  await ack();
  try {
    const url = generateAuthUrl({
      userId: command.user_id,
      teamId: context.teamId,
      enterpriseId: context.enterpriseId,
      isEnterpriseInstall: context.isEnterpriseInstall,
    });
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

slackApp.command('/info', async ({ command, context, ack, respond }) => {
  await ack();
  try {
    await respond({
      response_type: 'ephemeral',
      text: await buildInfoText({
        userId: command.user_id,
        teamId: context.teamId,
        enterpriseId: context.enterpriseId,
      }),
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

// Bolt only owns an HTTP listener on PORT in single-workspace HTTP Events API
// mode, and there we move the sidecar to PORT+1 to avoid the clash. In Socket
// Mode Bolt opens no HTTP port at all, and multi-tenant mode always runs a
// SocketModeReceiver whose install routes live on SLACK_INSTALL_PORT, so in
// both of those cases the sidecar takes PORT itself. Deriving this from
// USE_SOCKET_MODE alone would push the Google callback to PORT+1 whenever
// multi-tenant ran without SLACK_SOCKET_MODE=true, while Caddy and
// GOOGLE_REDIRECT_URI still point at PORT.
const boltOwnsPort = !MULTI_TENANT && !USE_SOCKET_MODE;

const healthApp = express();
const healthPort = boltOwnsPort ? PORT + 1 : PORT;

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
// SAME sidecar Express app as /health, so in Socket Mode and multi-tenant mode
// (the VPS deployments) it listens on `healthPort` (= SLACK_PORT). That port
// MUST be published in docker-compose.yml and reachable at the public
// GOOGLE_REDIRECT_URI.
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
    const result = await handleOAuthCallback(String(code), String(state));
    res.status(200).send(oauthHtml('Calendar connected!', 'You can close this tab and head back to Slack.'));

    // Best-effort: DM the user to confirm. The raw Slack userId is required for
    // the DM target (the storage key may be a composite team:user value).
    sendConnectConfirmationDM(result).catch((err) =>
      console.warn('[oauth] Could not DM connect confirmation:', err.message)
    );
  } catch (err) {
    console.error('[oauth] Callback failed:', err.message);
    res.status(500).send(oauthHtml('Calendar connection failed', 'Something went wrong exchanging the code. Please try /connect-calendar again.'));
  }
});

/**
 * DM the user a "calendar connected" confirmation.
 *
 * In single-workspace mode, slackApp.client is authed with the static bot token,
 * so we use it directly. In multi-tenant mode, slackApp.client has no static
 * token, so we look up the installation for this user's workspace and build a
 * per-team WebClient. If we cannot resolve a token (e.g. the installation is
 * gone), we skip the DM rather than fail the token save.
 *
 * @param {{rawUserId: string, teamId?: string, enterpriseId?: string,
 *   isEnterpriseInstall?: boolean}} result
 */
async function sendConnectConfirmationDM({ rawUserId, teamId, enterpriseId, isEnterpriseInstall }) {
  if (!rawUserId) return;
  const text = 'Your Google Calendar is connected. I can now see your schedule and create events for you.';

  if (!MULTI_TENANT) {
    await slackApp.client.chat.postMessage({ channel: rawUserId, text });
    return;
  }

  // Multi-tenant: resolve this workspace's bot token from the installation store.
  if (!installationStore) return;
  let token;
  try {
    const installation = await installationStore.fetchInstallation({
      teamId,
      enterpriseId,
      // Use Bolt's own flag, carried through the connect flow. Inferring it
      // from the ids (enterpriseId && !teamId) breaks org-wide installs, which
      // are filed under the enterprise id but still report a teamId on events.
      isEnterpriseInstall: isEnterpriseInstall ?? Boolean(enterpriseId && !teamId),
    });
    token = installation?.bot?.token;
  } catch (err) {
    console.warn('[oauth] No installation found for confirmation DM; skipping:', err.message);
    return;
  }
  if (!token) return;

  const client = new WebClient(token);
  await client.chat.postMessage({ channel: rawUserId, text });
}

/** Escape a value for safe interpolation into HTML text/attributes. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render a minimal HTML page for the OAuth callback response. */
function oauthHtml(title, body) {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title>` +
    '<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5}h2{margin-bottom:.5rem}</style>' +
    `</head><body><h2>${safeTitle}</h2><p>${safeBody}</p></body></html>`;
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
            (boltOwnsPort
              ? `In single-workspace HTTP mode the sidecar runs on SLACK_PORT+1 (${healthPort}); point GOOGLE_REDIRECT_URI there.`
              : `Set GOOGLE_REDIRECT_URI to use port ${healthPort}.`)
          );
        }
      } catch {
        // Non-fatal: redirect URI parsing is best-effort for the warning only.
      }
    });

    if (MULTI_TENANT) {
      console.log('[claudia-slack] Multi-tenant Socket Mode started');
      console.log(`[claudia-slack] Install routes on :${SLACK_INSTALL_PORT} (/slack/install, /slack/oauth_redirect)`);
      console.log('[claudia-slack] Share the public /slack/install URL so workspaces can add the app.');
    } else if (USE_SOCKET_MODE) {
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

/**
 * Slack bot configuration.
 *
 * All values are read from environment variables with descriptive error
 * messages if required vars are missing. Import this module early so config
 * failures surface at startup rather than at runtime.
 */

function required(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
      `Copy .env.example to .env and fill in all required values.`
    );
  }
  return val;
}

function optional(name, fallback) {
  return process.env[name] || fallback;
}

// ---------------------------------------------------------------------------
// Slack credentials
// ---------------------------------------------------------------------------

/** Bot token (xoxb-...) from the Slack app OAuth page */
export const SLACK_BOT_TOKEN = required('SLACK_BOT_TOKEN');

/** Signing secret from the Slack app Basic Information page */
export const SLACK_SIGNING_SECRET = required('SLACK_SIGNING_SECRET');

/** App-level token (xapp-...) for Socket Mode */
export const SLACK_APP_TOKEN = optional('SLACK_APP_TOKEN', '');

// ---------------------------------------------------------------------------
// Anthropic / Claude
// ---------------------------------------------------------------------------

/** Anthropic API key */
export const ANTHROPIC_API_KEY = required('ANTHROPIC_API_KEY');

/** Claude model to use for responses */
export const CLAUDE_MODEL = optional('CLAUDE_MODEL', 'claude-sonnet-4-6');

/** System prompt that gives the bot its Claudia persona */
export const SYSTEM_PROMPT = optional(
  'SLACK_SYSTEM_PROMPT',
  `You are Claudia, a relationship-aware AI assistant. You have access to the user's \
memory context, and to their Google Calendar IF they have connected it. Each user \
connects their own calendar, so calendar access is per-user. \
When a user has connected their calendar, their live events appear under \
"## Upcoming Calendar Events" - treat that data as accurate and complete for the \
lookahead window, and use it to answer scheduling questions directly. \
If the conversation context indicates the user has NOT connected a calendar, do not \
claim to see their events; instead tell them to connect it by sending \
"/connect-calendar" (or just "connect calendar") to you. Be concise in Slack (this \
is a chat, not a report). Use bullet points when listing things. No em dashes.`
);

// ---------------------------------------------------------------------------
// Help / discovery text
// ---------------------------------------------------------------------------

/**
 * Static help text shown by the /help slash command and the "help" keyword.
 * Uses Slack mrkdwn (single *asterisks* for bold). No em dashes.
 */
export const HELP_TEXT =
  '*Claudia* is a relationship-aware AI assistant with memory. Here is what you can do:\n\n' +
  '• *Chat with me.* DM me directly, or @mention me in a channel. I remember our ' +
  'past conversations and the people you work with, so context carries over.\n' +
  '• *Connect your calendar.* Send `/connect-calendar` (or just "connect calendar"). ' +
  'Once connected, ask things like "what\'s on my calendar this week?" and I can ' +
  'create events for you too.\n' +
  '• *Get help.* Send `/help` (or just "help") to see this message.\n' +
  '• *Check status.* Send `/info` (or just "info") for my version and connection status.';

// ---------------------------------------------------------------------------
// Memory daemon HTTP API
// ---------------------------------------------------------------------------

/** Base URL for the claudia-memory FastAPI server */
export const MEMORY_API_URL = optional('MEMORY_API_URL', 'http://localhost:3850');

/** API key for the memory HTTP server */
export const MEMORY_API_KEY = required('MEMORY_API_KEY');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Port for the Slack bot Express server (HTTP Events API mode) */
export const PORT = parseInt(optional('SLACK_PORT', '3851'), 10);

/** Whether to use Socket Mode instead of HTTP Events API */
export const USE_SOCKET_MODE = optional('SLACK_SOCKET_MODE', 'false') === 'true';

/** Max tokens in Claude response */
export const MAX_TOKENS = parseInt(optional('MAX_TOKENS', '1024'), 10);

/** Number of past memories to inject as context */
export const MEMORY_RECALL_LIMIT = parseInt(optional('MEMORY_RECALL_LIMIT', '15'), 10);

// ---------------------------------------------------------------------------
// Google Calendar (per-user OAuth)
// ---------------------------------------------------------------------------

/**
 * OAuth redirect URI for the per-user Google Calendar connect flow.
 *
 * The OAuth callback is served by the Slack server's sidecar Express app
 * (healthApp). In Socket Mode (the VPS deployment), that sidecar listens on
 * SLACK_PORT (default 3851), so the callback path lives on SLACK_PORT.
 *
 * IMPORTANT for VPS hosting: this MUST be the PUBLIC HTTPS URL of the bot and
 * must be registered as an authorized redirect URI in your Google Cloud OAuth
 * client. Example: https://yourdomain.com/oauth2callback
 *
 * Whatever port this URL points at must be the port the callback server
 * actually listens on AND must be published in docker-compose.yml.
 *
 * Default (dev): http://localhost:3851/oauth2callback
 */
export const GOOGLE_REDIRECT_URI = optional(
  'GOOGLE_REDIRECT_URI',
  `http://localhost:${PORT}/oauth2callback`
);

/**
 * The path portion of GOOGLE_REDIRECT_URI, used to register the Express route.
 * Falls back to '/oauth2callback' if the URI can't be parsed.
 */
export const GOOGLE_REDIRECT_PATH = (() => {
  try {
    return new URL(GOOGLE_REDIRECT_URI).pathname || '/oauth2callback';
  } catch {
    return '/oauth2callback';
  }
})();

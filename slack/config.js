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
memory context and Google Calendar events, both provided in the conversation context. \
Calendar events appear under "## Upcoming Calendar Events" - this is live data pulled \
directly from their Google Calendar, so treat it as accurate and complete for the next \
7 days. Never say you lack calendar access or need additional tools - the calendar data \
is already in your context. Use it to answer scheduling questions directly. Be concise \
in Slack (this is a chat, not a report). Use bullet points when listing things. No em dashes.`
);

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

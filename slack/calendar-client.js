/**
 * Google Calendar Client (per-user)
 *
 * Fetches upcoming events for a specific Slack user and formats them as a
 * context block to inject into the Claude prompt, alongside memory context.
 *
 * Each Slack user connects their own Google Calendar. Tokens are stored
 * per-user so that, when hosted on a VPS, every user sees THEIR OWN calendar
 * rather than the host's.
 *
 * Token storage:
 *   - Per-user: ~/.claudia/memory/users/<sanitizedUserId>/google-token.json
 *     (mirrors the memory daemon's db_manager routing convention, and the
 *      directory is already volume-mounted so tokens persist)
 *   - Legacy/global (no userId): ~/.claudia/google-token.json
 *     (backward compatible with the host's existing single-user token)
 *
 * Auth flows:
 *   - Host CLI: `node calendar-client.js --auth` runs a local OAuth flow and
 *     saves the global token (unchanged behavior).
 *   - Per-user (Slack): generateAuthUrl(userId) produces a consent URL whose
 *     `state` carries the userId. The OAuth callback (in server.js) calls
 *     handleOAuthCallback(code, state) to exchange the code and save the token
 *     to that user's path.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID       - OAuth client ID from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET   - OAuth client secret
 *   GOOGLE_REDIRECT_URI    - Must match what's set in GCP. On a VPS this must be
 *                            the public HTTPS callback URL (default for dev:
 *                            http://localhost:3851/oauth2callback, matching the
 *                            Slack server's sidecar callback port)
 *   GOOGLE_TOKEN_PATH      - Where to persist the LEGACY global token
 *                            (default: ~/.claudia/google-token.json)
 *   USER_DB_BASE_DIR       - Optional override for the per-user base directory
 *                            (default: ~/.claudia/memory/users)
 */

import { google } from 'googleapis';
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import 'dotenv/config';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Default matches the Slack server's sidecar callback port (SLACK_PORT, default
// 3851). Override via GOOGLE_REDIRECT_URI; on a VPS this must be the public URL.
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI
  || `http://localhost:${process.env.SLACK_PORT || '3851'}/oauth2callback`;

// Legacy global token path (used when no userId is supplied, e.g. host CLI auth)
const GLOBAL_TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || join(homedir(), '.claudia', 'google-token.json');

// Per-user token base directory. Mirrors the memory daemon's db_manager so
// per-user calendar tokens live alongside per-user memory databases.
const USER_BASE_DIR = process.env.USER_DB_BASE_DIR || join(homedir(), '.claudia', 'memory', 'users');

// OAuth scope: read + write calendar (create events).
const CALENDAR_SCOPE = ['https://www.googleapis.com/auth/calendar'];

// How many days ahead to fetch events
const LOOKAHEAD_DAYS = parseInt(process.env.CALENDAR_LOOKAHEAD_DAYS || '7', 10);
// Max events to include in context
const MAX_EVENTS = parseInt(process.env.CALENDAR_MAX_EVENTS || '10', 10);

// Per-user OAuth client cache, keyed by userId (or '__global__' for legacy).
const _clientCache = new Map();
const GLOBAL_CACHE_KEY = '__global__';

// Pending OAuth connects, keyed by an unguessable single-use nonce.
// Value: { userId, expiresAt }. The nonce (not the userId) travels through
// the OAuth `state` parameter, so a public callback cannot be used to bind a
// victim's Slack identity to an attacker's Google account.
const _pendingConnects = new Map();
const CONNECT_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// OAuth client setup
// ---------------------------------------------------------------------------

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

function createOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

/**
 * Sanitize a Slack userId for use as a directory name.
 * Mirrors the memory daemon's db_manager: keep alphanumerics, '-' and '_'.
 *
 * @param {string} userId
 * @returns {string} A filesystem-safe id (falls back to 'default' if empty)
 */
function sanitizeUserId(userId) {
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, '');
  return safe || 'default';
}

/**
 * Resolve the token file path for a given userId.
 *
 * @param {string} [userId] - Slack user ID. If falsy, returns the legacy
 *                            global token path for backward compatibility.
 * @returns {string} Absolute path to the token JSON file.
 */
export function tokenPathFor(userId) {
  if (!userId) return GLOBAL_TOKEN_PATH;
  return join(USER_BASE_DIR, sanitizeUserId(userId), 'google-token.json');
}

function cacheKeyFor(userId) {
  return userId ? sanitizeUserId(userId) : GLOBAL_CACHE_KEY;
}

function loadSavedToken(tokenPath) {
  if (!existsSync(tokenPath)) return null;
  try {
    return JSON.parse(readFileSync(tokenPath, 'utf8'));
  } catch {
    return null;
  }
}

function saveToken(tokenPath, token) {
  const dir = dirname(tokenPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(token, null, 2));
}

/**
 * Get an authenticated OAuth2 client for a specific user.
 * Uses a per-user cached client if already authorized, otherwise loads the
 * user's saved token. Returns null if credentials are not configured or the
 * user has not connected their calendar.
 *
 * @param {string} [userId] - Slack user ID. Falsy uses the legacy global token.
 * @returns {Promise<import('google-auth-library').OAuth2Client|null>}
 */
async function getAuthClient(userId) {
  if (!isConfigured()) return null;

  const key = cacheKeyFor(userId);
  if (_clientCache.has(key)) return _clientCache.get(key);

  const tokenPath = tokenPathFor(userId);
  const saved = loadSavedToken(tokenPath);
  if (!saved) return null;

  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(saved);
  // Persist refreshed tokens automatically to this user's path.
  oauth2Client.on('tokens', (tokens) => {
    const merged = { ...saved, ...tokens };
    saveToken(tokenPath, merged);
  });

  _clientCache.set(key, oauth2Client);
  return oauth2Client;
}

// ---------------------------------------------------------------------------
// Per-user OAuth (Slack flow)
// ---------------------------------------------------------------------------

/**
 * Drop expired pending-connect entries. Called lazily on each access so the
 * Map cannot grow unbounded from abandoned connect attempts.
 */
function pruneExpiredConnects() {
  const now = Date.now();
  for (const [nonce, entry] of _pendingConnects) {
    if (entry.expiresAt <= now) _pendingConnects.delete(nonce);
  }
}

/**
 * Generate a Google consent URL for a specific user.
 *
 * The `state` parameter carries an unguessable single-use NONCE, not the raw
 * userId. The real userId is held server-side in _pendingConnects, keyed by
 * that nonce. This prevents an attacker from hitting the public callback with
 * state=<victim userId> to bind a victim's Slack identity to their own Google
 * account (account fixation).
 *
 * @param {string} userId - Slack user ID.
 * @returns {string} The consent URL to send the user.
 */
export function generateAuthUrl(userId) {
  if (!isConfigured()) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set to connect a calendar.'
    );
  }
  if (!userId) {
    throw new Error('generateAuthUrl requires a userId.');
  }

  pruneExpiredConnects();

  const nonce = randomBytes(32).toString('hex');
  _pendingConnects.set(nonce, { userId, expiresAt: Date.now() + CONNECT_TTL_MS });

  const oauth2Client = createOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: CALENDAR_SCOPE,
    state: nonce,
  });
}

/**
 * Handle the OAuth redirect callback: validate the single-use state nonce,
 * resolve the real userId, then exchange the code and save the token to that
 * user's per-user path.
 *
 * @param {string} code  - The authorization code from the query string.
 * @param {string} state - The single-use nonce carried through the consent flow.
 * @returns {Promise<string>} The resolved userId whose token was saved.
 */
export async function handleOAuthCallback(code, state) {
  if (!isConfigured()) {
    throw new Error('Google Calendar credentials are not configured.');
  }
  if (!code) throw new Error('Missing OAuth authorization code.');
  if (!state) throw new Error('Missing OAuth state.');

  pruneExpiredConnects();

  // Validate and consume the nonce. Missing/expired/replayed -> reject.
  const entry = _pendingConnects.get(state);
  if (!entry || entry.expiresAt <= Date.now()) {
    _pendingConnects.delete(state);
    throw new Error('Invalid or expired calendar connect link. Send /connect-calendar again.');
  }
  // Single use: consume immediately so a replayed code can't reuse this nonce.
  _pendingConnects.delete(state);

  const userId = entry.userId;
  const oauth2Client = createOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  // sanitizeUserId is applied inside tokenPathFor/cacheKeyFor (defense in depth).
  const tokenPath = tokenPathFor(userId);
  saveToken(tokenPath, tokens);

  // Refresh the cache so the new token takes effect immediately.
  const key = cacheKeyFor(userId);
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', (refreshed) => {
    const merged = { ...tokens, ...refreshed };
    saveToken(tokenPath, merged);
  });
  _clientCache.set(key, oauth2Client);

  console.log(`[calendar] Calendar connected for user ${sanitizeUserId(userId)}`);
  return userId;
}

// ---------------------------------------------------------------------------
// First-time authorization (host CLI)
// ---------------------------------------------------------------------------

/**
 * Run the OAuth flow in a local HTTP server on the redirect port.
 * Prints an auth URL to stdout and waits for the browser redirect.
 * Saves the LEGACY global token. Call once: node calendar-client.js --auth
 */
export async function authorize() {
  if (!isConfigured()) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set to authorize.\n' +
      'See the Google Calendar setup instructions in CLAUDE.md.'
    );
  }

  const oauth2Client = createOAuthClient();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: CALENDAR_SCOPE,
    prompt: 'consent',
  });

  console.log('\nOpen this URL in your browser to authorize Google Calendar access:\n');
  console.log(authUrl);
  console.log('\nWaiting for authorization...');

  const code = await waitForAuthCode();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  saveToken(GLOBAL_TOKEN_PATH, tokens);
  _clientCache.set(GLOBAL_CACHE_KEY, oauth2Client);

  console.log(`\nAuthorization complete. Token saved to ${GLOBAL_TOKEN_PATH}`);
}

function waitForAuthCode() {
  return new Promise((resolve, reject) => {
    const port = parseInt(new URL(REDIRECT_URI).port || '3852', 10);
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Authorization complete. You can close this tab.</h2>');
        server.close();
        resolve(code);
      } else {
        res.writeHead(400);
        res.end('Missing code parameter');
        reject(new Error('Missing code in OAuth callback'));
      }
    });
    server.listen(port, () => {
      console.log(`Listening for OAuth callback on port ${port}...`);
    });
    server.on('error', reject);
    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Authorization timed out after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

// ---------------------------------------------------------------------------
// Calendar data fetching
// ---------------------------------------------------------------------------

/**
 * Fetch upcoming calendar events for the next LOOKAHEAD_DAYS days for a user.
 * Returns an array of formatted event strings, or empty array if unavailable.
 *
 * @param {string} [userId] - Slack user ID. Falsy uses the legacy global token.
 * @returns {Promise<string[]>}
 */
export async function getUpcomingEvents(userId) {
  const auth = await getAuthClient(userId);
  if (!auth) return [];

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + LOOKAHEAD_DAYS);

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      maxResults: MAX_EVENTS,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];
    return events.map(formatEvent).filter(Boolean);
  } catch (err) {
    console.warn('[calendar] Failed to fetch events:', err.message);
    return [];
  }
}

function formatEvent(event) {
  const summary = event.summary || '(No title)';
  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date;
  if (!start) return null;

  const startDate = new Date(start);
  const isAllDay = !event.start?.dateTime;

  const dateStr = startDate.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  let timeStr = '';
  if (!isAllDay) {
    const endDate = new Date(end);
    timeStr = ` ${startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` +
              ` - ${endDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }

  const attendees = (event.attendees || [])
    .filter((a) => !a.self && !a.resource)
    .map((a) => a.displayName || a.email)
    .slice(0, 4);

  const attendeeStr = attendees.length > 0 ? ` (with ${attendees.join(', ')})` : '';
  const location = event.location ? ` @ ${event.location}` : '';

  return `${dateStr}${timeStr}: ${summary}${attendeeStr}${location}`;
}

// ---------------------------------------------------------------------------
// Context block for Claude prompt
// ---------------------------------------------------------------------------

/**
 * Build a formatted calendar context block to inject into the Claude prompt.
 * Returns empty string if the user's Calendar is not connected or has no events.
 *
 * @param {string} [userId] - Slack user ID. Falsy uses the legacy global token.
 * @returns {Promise<string>}
 */
export async function buildCalendarContext(userId) {
  const events = await getUpcomingEvents(userId);
  if (events.length === 0) return '';

  const lines = ['## Upcoming Calendar Events'];
  for (const e of events) {
    lines.push(`- ${e}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Check whether a user's Google Calendar is configured and connected.
 *
 * @param {string} [userId] - Slack user ID. Falsy checks the legacy global token.
 * @returns {boolean}
 */
export function isCalendarConfigured(userId) {
  return isConfigured() && existsSync(tokenPathFor(userId));
}


// ---------------------------------------------------------------------------
// Event creation
// ---------------------------------------------------------------------------

/**
 * Create a calendar event on a user's primary calendar.
 *
 * @param {string} userId - Slack user ID. Falsy uses the legacy global token.
 * @param {object} opts
 * @param {string} opts.title          - Event title
 * @param {string} opts.start_datetime - Start datetime (ISO 8601)
 * @param {string} [opts.end_datetime] - End datetime (defaults to +1h)
 * @param {string[]} [opts.attendees]  - Attendee email addresses
 * @param {string} [opts.description]  - Event description
 * @param {string} [opts.location]     - Event location
 * @returns {Promise<object>} Created event summary fields
 */
export async function createEvent(userId, { title, start_datetime, end_datetime, attendees = [], description, location }) {
  const auth = await getAuthClient(userId);
  if (!auth) {
    throw new Error('Google Calendar not connected. Connect it with /connect-calendar.');
  }

  const calendar = google.calendar({ version: 'v3', auth });

  const startDt = new Date(start_datetime);
  const endDt = end_datetime
    ? new Date(end_datetime)
    : new Date(startDt.getTime() + 60 * 60 * 1000);

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const eventBody = {
    summary: title,
    start: { dateTime: startDt.toISOString(), timeZone },
    end: { dateTime: endDt.toISOString(), timeZone },
  };

  if (description) eventBody.description = description;
  if (location) eventBody.location = location;
  if (attendees.length > 0) {
    eventBody.attendees = attendees.map((email) => ({ email }));
  }

  const response = await calendar.events.insert({
    calendarId: 'primary',
    resource: eventBody,
    sendUpdates: attendees.length > 0 ? 'all' : 'none',
  });

  console.log(`[calendar] Event created: ${response.data.summary}`);
  return {
    id: response.data.id,
    htmlLink: response.data.htmlLink,
    summary: response.data.summary,
    start: response.data.start,
    end: response.data.end,
  };
}
// ---------------------------------------------------------------------------
// CLI: node calendar-client.js --auth
// ---------------------------------------------------------------------------

if (process.argv[1]?.endsWith('calendar-client.js') && process.argv.includes('--auth')) {
  authorize().catch((err) => {
    console.error('Authorization failed:', err.message);
    process.exit(1);
  });
}

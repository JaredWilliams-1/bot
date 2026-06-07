/**
 * Google Calendar Client
 *
 * Fetches upcoming events for the authenticated user and formats them
 * as a context block to inject into the Claude prompt, alongside memory context.
 *
 * Auth flow:
 *   - First run: opens a browser for OAuth consent, saves token to GOOGLE_TOKEN_PATH
 *   - Subsequent runs: refreshes the token automatically
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID       - OAuth client ID from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET   - OAuth client secret
 *   GOOGLE_REDIRECT_URI    - Must match what's set in GCP (default: http://localhost:3852/oauth2callback)
 *   GOOGLE_TOKEN_PATH      - Where to persist the token (default: ~/.claudia/google-token.json)
 */

import { google } from 'googleapis';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';
import 'dotenv/config';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3852/oauth2callback';
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || `${homedir()}/.claudia/google-token.json`;

// How many days ahead to fetch events
const LOOKAHEAD_DAYS = parseInt(process.env.CALENDAR_LOOKAHEAD_DAYS || '7', 10);
// Max events to include in context
const MAX_EVENTS = parseInt(process.env.CALENDAR_MAX_EVENTS || '10', 10);

let _cachedClient = null;

// ---------------------------------------------------------------------------
// OAuth client setup
// ---------------------------------------------------------------------------

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

function createOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function loadSavedToken() {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveToken(token) {
  const dir = dirname(TOKEN_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
}

/**
 * Get an authenticated OAuth2 client.
 * Uses cached client if already authorized, otherwise loads saved token.
 * Returns null if credentials are not configured.
 */
async function getAuthClient() {
  if (!isConfigured()) return null;
  if (_cachedClient) return _cachedClient;

  const oauth2Client = createOAuthClient();
  const saved = loadSavedToken();

  if (saved) {
    oauth2Client.setCredentials(saved);
    // Persist refreshed tokens automatically
    oauth2Client.on('tokens', (tokens) => {
      const merged = { ...saved, ...tokens };
      saveToken(merged);
    });
    _cachedClient = oauth2Client;
    return oauth2Client;
  }

  return null;
}

// ---------------------------------------------------------------------------
// First-time authorization
// ---------------------------------------------------------------------------

/**
 * Run the OAuth flow in a local HTTP server on port 3852.
 * Prints an auth URL to stdout and waits for the browser redirect.
 * Call this once from the command line: node calendar-client.js --auth
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
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent',
  });

  console.log('\nOpen this URL in your browser to authorize Google Calendar access:\n');
  console.log(authUrl);
  console.log('\nWaiting for authorization...');

  const code = await waitForAuthCode();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  saveToken(tokens);
  _cachedClient = oauth2Client;

  console.log(`\nAuthorization complete. Token saved to ${TOKEN_PATH}`);
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
 * Fetch upcoming calendar events for the next LOOKAHEAD_DAYS days.
 * Returns an array of formatted event strings, or empty array if unavailable.
 */
export async function getUpcomingEvents() {
  const auth = await getAuthClient();
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
 * Returns empty string if Google Calendar is not configured or has no events.
 */
export async function buildCalendarContext() {
  const events = await getUpcomingEvents();
  if (events.length === 0) return '';

  const lines = ['## Upcoming Calendar Events'];
  for (const e of events) {
    lines.push(`- ${e}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Check whether Google Calendar is configured and authorized.
 */
export function isCalendarConfigured() {
  return isConfigured() && existsSync(TOKEN_PATH);
}


// ---------------------------------------------------------------------------
// Event creation
// ---------------------------------------------------------------------------

export async function createEvent({ title, start_datetime, end_datetime, attendees = [], description, location }) {
  const auth = await getAuthClient();
  if (!auth) throw new Error('Google Calendar not authorized. Run: node calendar-client.js --auth');

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

if (process.argv[1].endsWith('calendar-client.js') && process.argv.includes('--auth')) {
  authorize().catch((err) => {
    console.error('Authorization failed:', err.message);
    process.exit(1);
  });
}


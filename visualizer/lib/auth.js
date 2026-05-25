/**
 * Authentication middleware for the Claudia Brain Visualizer.
 *
 * Supports two modes:
 *   1. JWT-based session auth (issued after Slack OAuth)
 *   2. Static API key auth (for programmatic access, optional)
 *
 * JWT tokens are signed with AUTH_SECRET and carry a minimal payload:
 *   { sub: slackUserId, name: displayName, iat, exp }
 *
 * Slack OAuth flow:
 *   GET /api/auth/slack         - Redirect to Slack authorize URL
 *   GET /api/auth/slack/callback - Exchange code for token, issue JWT, redirect
 *   GET /api/auth/me             - Return current session info
 *   POST /api/auth/logout        - Clear session cookie
 *
 * When AUTH_DISABLED=true (development default), all requests are treated
 * as authenticated with a synthetic "local" user so the visualizer works
 * out-of-the-box without setting up Slack OAuth.
 */

import crypto from 'crypto';
import { createHmac, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = join(__dirname, '..', 'auth-config.json');

// ---------------------------------------------------------------------------
// Persisted config (written by the setup UI)
// ---------------------------------------------------------------------------

function loadPersistedConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function savePersistedConfig(update) {
  const current = loadPersistedConfig();
  const next = { ...current, ...update };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true';
const AUTH_SECRET = process.env.AUTH_SECRET || generateDevSecret();
const APP_URL = process.env.APP_URL || 'http://localhost:3849';
const JWT_EXPIRY_SECONDS = parseInt(process.env.JWT_EXPIRY_SECONDS || '86400', 10); // 24 h
const COOKIE_NAME = 'claudia_session';

// Credentials: env vars take precedence, then persisted config file
function getSlackCredentials() {
  const persisted = loadPersistedConfig();
  return {
    clientId: process.env.SLACK_CLIENT_ID || persisted.slackClientId || '',
    clientSecret: process.env.SLACK_CLIENT_SECRET || persisted.slackClientSecret || '',
  };
}

export function isSlackConfigured() {
  const { clientId, clientSecret } = getSlackCredentials();
  return !!(clientId && clientSecret);
}

function generateDevSecret() {
  const secret = crypto.randomBytes(32).toString('hex');
  if (process.env.NODE_ENV !== 'test') {
    console.warn(
      '[auth] AUTH_SECRET not set. Using a random secret for this session only.\n' +
      '[auth] Sessions will not survive restarts. Set AUTH_SECRET in .env for production.'
    );
  }
  return secret;
}

// ---------------------------------------------------------------------------
// Minimal JWT implementation (no external dependency)
//
// Uses HMAC-SHA256. We avoid adding jsonwebtoken as a dep to keep the
// visualizer package lean. This is intentionally simple: HS256, standard
// claims, no refresh tokens.
// ---------------------------------------------------------------------------

function base64url(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlEncode(obj) {
  return base64url(Buffer.from(JSON.stringify(obj)));
}

/**
 * Issue a signed JWT.
 * @param {object} payload - Claims to encode (sub, name, etc.)
 * @returns {string} Signed token string
 */
export function issueToken(payload) {
  const header = base64urlEncode({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const claims = base64urlEncode({
    iat: now,
    exp: now + JWT_EXPIRY_SECONDS,
    ...payload,
  });
  const sig = base64url(
    createHmac('sha256', AUTH_SECRET)
      .update(`${header}.${claims}`)
      .digest()
  );
  return `${header}.${claims}.${sig}`;
}

/**
 * Verify and decode a JWT. Returns the payload or null on failure.
 * @param {string} token
 * @returns {object|null}
 */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, claims, sig] = parts;
  const expectedSig = base64url(
    createHmac('sha256', AUTH_SECRET)
      .update(`${header}.${claims}`)
      .digest()
  );

  // Constant-time comparison to prevent timing attacks
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(claims, 'base64url').toString());
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return null;

  return payload;
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/**
 * requireAuth middleware.
 *
 * Reads the JWT from:
 *   1. Authorization: Bearer <token> header
 *   2. claudia_session cookie
 *
 * In development (AUTH_DISABLED=true), always passes through with a synthetic
 * local user so the visualizer works without Slack credentials.
 */
export function requireAuth(req, res, next) {
  if (AUTH_DISABLED) {
    req.user = { sub: 'local', name: 'Local User', role: 'admin' };
    return next();
  }

  // Try Authorization header first, then cookie
  let token = null;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.cookies?.[COOKIE_NAME]) {
    token = req.cookies[COOKIE_NAME];
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required', authUrl: '/api/auth/slack' });
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.clearCookie(COOKIE_NAME);
    return res.status(401).json({ error: 'Invalid or expired session', authUrl: '/api/auth/slack' });
  }

  req.user = payload;
  next();
}

// ---------------------------------------------------------------------------
// Slack OAuth helpers
// ---------------------------------------------------------------------------

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';
const SLACK_SCOPES = ['identity.basic', 'identity.email'].join(',');

/**
 * Build the Slack OAuth authorization URL.
 * State is a HMAC of a timestamp to prevent CSRF.
 */
export function buildSlackAuthUrl() {
  const { clientId } = getSlackCredentials();
  const state = createHmac('sha256', AUTH_SECRET)
    .update(String(Date.now()))
    .digest('hex')
    .slice(0, 16);

  const params = new URLSearchParams({
    client_id: clientId,
    scope: SLACK_SCOPES,
    redirect_uri: `${APP_URL}/api/auth/slack/callback`,
    state,
  });

  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange a Slack OAuth code for user identity.
 * Returns { userId, name, email } or throws on failure.
 */
export async function exchangeSlackCode(code) {
  const { clientId, clientSecret } = getSlackCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('SLACK_CLIENT_ID and SLACK_CLIENT_SECRET must be set for Slack OAuth');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: `${APP_URL}/api/auth/slack/callback`,
  });

  const response = await globalThis.fetch(`${SLACK_TOKEN_URL}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Slack token exchange HTTP error: ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack OAuth error: ${data.error}`);
  }

  // Use the identity scopes to get the user's profile
  const userId = data.authed_user?.id || data.user?.id;
  const name = data.authed_user?.name || data.user?.name || userId;
  const email = data.authed_user?.email || '';

  if (!userId) {
    throw new Error('Slack OAuth response missing user ID');
  }

  return { userId, name, email };
}

// ---------------------------------------------------------------------------
// Auth route handler factory
//
// Call mountAuthRoutes(app) in server.js to register all auth endpoints.
// ---------------------------------------------------------------------------

/**
 * Register auth endpoints on an Express app.
 * Must be called before requireAuth is applied to other routes.
 *
 * @param {import('express').Application} app
 */
export function mountAuthRoutes(app) {
  // Parse cookies (lightweight, no cookie-parser dependency)
  app.use((req, _res, next) => {
    req.cookies = {};
    const cookieHeader = req.headers.cookie || '';
    for (const part of cookieHeader.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k) req.cookies[k.trim()] = decodeURIComponent(v.join('=').trim());
    }
    next();
  });

  // POST /api/auth/setup - Save Slack credentials via the UI (no restart needed)
  app.post('/api/auth/setup', (req, res) => {
    if (AUTH_DISABLED) {
      return res.json({ success: true, message: 'Auth is disabled; no setup needed.' });
    }
    const { slackClientId, slackClientSecret } = req.body;
    if (!slackClientId || !slackClientSecret) {
      return res.status(400).json({ error: 'slackClientId and slackClientSecret are required' });
    }
    try {
      savePersistedConfig({ slackClientId, slackClientSecret });
      res.json({ success: true, message: 'Slack credentials saved. You can now sign in.' });
    } catch (err) {
      res.status(500).json({ error: `Failed to save config: ${err.message}` });
    }
  });

  // GET /api/auth/status - Let the frontend know if Slack is configured
  app.get('/api/auth/status', (_req, res) => {
    res.json({
      authDisabled: AUTH_DISABLED,
      slackConfigured: AUTH_DISABLED || isSlackConfigured(),
    });
  });

  // GET /api/auth/slack - Initiate Slack OAuth flow
  app.get('/api/auth/slack', (_req, res) => {
    if (AUTH_DISABLED) {
      return res.redirect('/');
    }
    if (!isSlackConfigured()) {
      return res.status(503).json({
        error: 'Slack OAuth not configured',
        hint: 'Use the setup form to enter your Slack Client ID and Secret.',
        setupRequired: true,
      });
    }
    res.redirect(buildSlackAuthUrl());
  });

  // GET /api/auth/slack/callback - Handle OAuth callback
  app.get('/api/auth/slack/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
      return res.status(400).send(`Slack OAuth denied: ${error}`);
    }
    if (!code) {
      return res.status(400).send('Missing OAuth code');
    }

    try {
      const { userId, name, email } = await exchangeSlackCode(code);
      const token = issueToken({ sub: userId, name, email });

      // Set as HttpOnly cookie (30 day max age to match JWT expiry default)
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${JWT_EXPIRY_SECONDS}`
      );

      res.redirect('/');
    } catch (err) {
      console.error('[auth] Slack OAuth callback error:', err.message);
      res.status(500).send(`Authentication failed: ${err.message}`);
    }
  });

  // GET /api/auth/me - Return current user info (used by frontend)
  app.get('/api/auth/me', (req, res) => {
    if (AUTH_DISABLED) {
      return res.json({ authenticated: true, user: { sub: 'local', name: 'Local User' } });
    }

    let token = null;
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else {
      const cookieHeader = req.headers.cookie || '';
      for (const part of cookieHeader.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k.trim() === COOKIE_NAME) {
          token = decodeURIComponent(v.join('=').trim());
          break;
        }
      }
    }

    if (!token) {
      return res.json({ authenticated: false });
    }

    const payload = verifyToken(token);
    if (!payload) {
      return res.json({ authenticated: false });
    }

    res.json({ authenticated: true, user: { sub: payload.sub, name: payload.name } });
  });

  // POST /api/auth/logout - Clear session
  app.post('/api/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
    res.json({ success: true });
  });
}

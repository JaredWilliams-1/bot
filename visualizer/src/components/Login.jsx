/**
 * Login page component.
 *
 * Shown when the user is not authenticated. Offers Slack OAuth SSO.
 * If Slack credentials haven't been configured yet, shows a setup form
 * so the user can enter them without touching .env.
 */

import { useEffect, useState } from 'react';

/**
 * @param {object} props
 * @param {Function} props.onAuthenticated - Called when auth is confirmed
 */
export function Login({ onAuthenticated }) {
  const [checking, setChecking] = useState(true);
  const [status, setStatus] = useState(null); // { authDisabled, slackConfigured }
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // Check if we already have a valid session
        const meRes = await fetch('/api/auth/me');
        if (!meRes.ok) throw new Error(`HTTP ${meRes.status}`);
        const meData = await meRes.json();
        if (!cancelled && meData.authenticated) {
          onAuthenticated(meData.user);
          return;
        }

        // Check auth configuration status
        const statusRes = await fetch('/api/auth/status');
        if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status}`);
        const statusData = await statusRes.json();
        if (!cancelled) setStatus(statusData);
      } catch (err) {
        if (!cancelled) setError('Could not reach the server.');
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    init();
    return () => { cancelled = true; };
  }, [onAuthenticated]);

  if (checking) {
    return (
      <div className="login-page">
        <div className="login-card">
          <LoginLogo />
          <p className="login-status">Checking session...</p>
        </div>
      </div>
    );
  }

  // Need to configure Slack first
  if (status && !status.slackConfigured) {
    return <SetupForm onConfigured={() => setStatus(s => ({ ...s, slackConfigured: true }))} />;
  }

  // Slack is configured (or auth disabled) - show normal login
  return (
    <div className="login-page">
      <div className="login-card">
        <LoginLogo />
        <h1 className="login-title">Claudia Brain</h1>
        <p className="login-subtitle">
          3D memory graph explorer. Sign in to view your knowledge graph.
        </p>

        {error && <p className="login-error">{error}</p>}

        <button className="login-btn login-btn--slack" onClick={() => { window.location.href = '/api/auth/slack'; }}>
          <SlackIcon />
          Sign in with Slack
        </button>

        <p className="login-note">
          Your memory data stays on your machine. Slack is used for identity only.
        </p>
      </div>

      <style>{LOGIN_STYLES}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup form - collect Slack credentials once, persisted server-side
// ---------------------------------------------------------------------------

function SetupForm({ onConfigured }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [showSecret, setShowSecret] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!clientId.trim() || !clientSecret.trim()) {
      setError('Both fields are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slackClientId: clientId.trim(), slackClientSecret: clientSecret.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Setup failed');
      onConfigured();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card login-card--wide">
        <LoginLogo />
        <h1 className="login-title">Connect Slack</h1>
        <p className="login-subtitle">
          Enter your Slack app credentials once. They'll be saved locally so you don't need to edit any files.
        </p>

        <div className="setup-help">
          <strong>Where to find these:</strong>
          <ol>
            <li>Go to <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">api.slack.com/apps</a></li>
            <li>Create or select your app</li>
            <li>Under <em>Basic Information</em> → <em>App Credentials</em></li>
            <li>Also add <code>http://localhost:3849/api/auth/slack/callback</code> to <em>OAuth &amp; Permissions → Redirect URLs</em></li>
          </ol>
        </div>

        {error && <p className="login-error">{error}</p>}

        <form onSubmit={handleSubmit} className="setup-form">
          <label className="setup-field">
            <span>Client ID</span>
            <input
              type="text"
              value={clientId}
              onChange={e => setClientId(e.target.value)}
              placeholder="1234567890.123456789012"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="setup-field">
            <span>Client Secret</span>
            <div className="secret-input-wrap">
              <input
                type={showSecret ? 'text' : 'password'}
                value={clientSecret}
                onChange={e => setClientSecret(e.target.value)}
                placeholder="••••••••••••••••••••••••••••••••"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="secret-toggle" onClick={() => setShowSecret(v => !v)}>
                {showSecret ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          <button className="login-btn login-btn--primary" type="submit" disabled={saving}>
            {saving ? 'Saving...' : 'Save & Continue'}
          </button>
        </form>
      </div>

      <style>{LOGIN_STYLES}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LoginLogo() {
  return (
    <pre className="login-logo" aria-hidden="true">{`
      ▓▓▓▓▓▓▓▓▒▒
▓▓██████████▒▒
▓▓██  ██  ██▓▓
  ██████████
    ▒▒▒▒▒▒
  ▒▒▒▒▒▒▒▒▒▒
    ██  ██
    `.trim()}</pre>
  );
}

function SlackIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 54 54"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ marginRight: '8px', flexShrink: 0 }}
    >
      <g fill="none" fillRule="evenodd">
        <path d="M19.712.133a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386h5.376V5.52A5.381 5.381 0 0 0 19.712.133m0 14.365H5.376A5.381 5.381 0 0 0 0 19.884a5.381 5.381 0 0 0 5.376 5.387h14.336a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386" fill="#36C5F0"/>
        <path d="M53.76 19.884a5.381 5.381 0 0 0-5.376-5.386 5.381 5.381 0 0 0-5.376 5.386v5.387h5.376a5.381 5.381 0 0 0 5.376-5.387m-14.336 0V5.52A5.381 5.381 0 0 0 34.048.133a5.381 5.381 0 0 0-5.376 5.387v14.364a5.381 5.381 0 0 0 5.376 5.387 5.381 5.381 0 0 0 5.376-5.387" fill="#2EB67D"/>
        <path d="M34.048 54a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386h-5.376v5.386A5.381 5.381 0 0 0 34.048 54m0-14.365h14.336a5.381 5.381 0 0 0 5.376-5.386 5.381 5.381 0 0 0-5.376-5.387H34.048a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386" fill="#ECB22E"/>
        <path d="M0 34.249a5.381 5.381 0 0 0 5.376 5.386 5.381 5.381 0 0 0 5.376-5.386v-5.387H5.376A5.381 5.381 0 0 0 0 34.249m14.336 0v14.364A5.381 5.381 0 0 0 19.712 54a5.381 5.381 0 0 0 5.376-5.387V34.249a5.381 5.381 0 0 0-5.376-5.387 5.381 5.381 0 0 0-5.376 5.387" fill="#E01E5A"/>
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Scoped styles
// ---------------------------------------------------------------------------

const LOGIN_STYLES = `
  .login-page {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0d1117;
    z-index: 9999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  .login-card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 12px;
    padding: 40px 48px;
    max-width: 420px;
    width: 100%;
    text-align: center;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  }

  .login-card--wide {
    max-width: 520px;
    text-align: left;
  }

  .login-card--wide .login-logo {
    display: block;
    text-align: left;
  }

  .login-card--wide .login-title,
  .login-card--wide .login-subtitle {
    text-align: left;
  }

  .login-logo {
    font-size: 11px;
    line-height: 1.3;
    color: #8b949e;
    margin: 0 0 20px 0;
    font-family: monospace;
    display: inline-block;
    text-align: left;
  }

  .login-title {
    font-size: 24px;
    font-weight: 600;
    color: #e6edf3;
    margin: 0 0 8px 0;
  }

  .login-subtitle {
    font-size: 14px;
    color: #8b949e;
    margin: 0 0 24px 0;
    line-height: 1.5;
  }

  .setup-help {
    font-size: 13px;
    color: #8b949e;
    background: #0d1117;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 14px 16px;
    margin-bottom: 24px;
    line-height: 1.6;
  }

  .setup-help strong {
    color: #c9d1d9;
    display: block;
    margin-bottom: 6px;
  }

  .setup-help ol {
    margin: 0;
    padding-left: 18px;
  }

  .setup-help a {
    color: #58a6ff;
    text-decoration: none;
  }

  .setup-help a:hover { text-decoration: underline; }

  .setup-help code {
    background: #21262d;
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 12px;
    word-break: break-all;
  }

  .setup-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .setup-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .setup-field span {
    font-size: 13px;
    font-weight: 500;
    color: #c9d1d9;
  }

  .setup-field input {
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #e6edf3;
    font-size: 14px;
    padding: 9px 12px;
    width: 100%;
    box-sizing: border-box;
    outline: none;
    transition: border-color 0.15s;
  }

  .setup-field input:focus {
    border-color: #58a6ff;
  }

  .secret-input-wrap {
    position: relative;
    display: flex;
  }

  .secret-input-wrap input {
    padding-right: 56px;
  }

  .secret-toggle {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: #58a6ff;
    font-size: 12px;
    cursor: pointer;
    padding: 2px 4px;
  }

  .secret-toggle:hover { text-decoration: underline; }

  .login-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 12px 24px;
    border-radius: 8px;
    border: none;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s, transform 0.1s;
    width: 100%;
    margin-bottom: 16px;
  }

  .login-btn:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
  .login-btn:active:not(:disabled) { transform: translateY(0); }
  .login-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .login-btn--slack {
    background: #fff;
    color: #1d1c1d;
  }

  .login-btn--primary {
    background: #238636;
    color: #fff;
    margin-top: 8px;
    margin-bottom: 0;
  }

  .login-status {
    color: #8b949e;
    font-size: 14px;
  }

  .login-error {
    color: #f85149;
    font-size: 13px;
    margin-bottom: 16px;
    padding: 8px 12px;
    background: rgba(248,81,73,0.1);
    border-radius: 6px;
    border: 1px solid rgba(248,81,73,0.3);
  }

  .login-note {
    font-size: 12px;
    color: #6e7681;
    margin-top: 8px;
    line-height: 1.4;
  }
`;

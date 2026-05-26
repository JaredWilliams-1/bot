/**
 * Login page component.
 *
 * Shown when the user is not authenticated. Offers Slack OAuth SSO.
 * Polls /api/auth/me to check session state and calls onAuthenticated()
 * when login is confirmed.
 */

import { useEffect, useState } from 'react';

/**
 * @param {object} props
 * @param {Function} props.onAuthenticated - Called when auth is confirmed
 */
export function Login({ onAuthenticated }) {
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState(null);

  // On mount, check if we already have a valid session (e.g. page reload
  // after a cookie was set by the OAuth callback).
  useEffect(() => {
    let cancelled = false;

    async function checkSession() {
      try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled && data.authenticated) {
          onAuthenticated(data.user);
        }
      } catch (err) {
        if (!cancelled) setError('Could not check session status.');
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    checkSession();
    return () => { cancelled = true; };
  }, [onAuthenticated]);

  function handleSlackLogin() {
    window.location.href = '/api/auth/slack';
  }

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

  return (
    <div className="login-page">
      <div className="login-card">
        <LoginLogo />
        <h1 className="login-title">Claudia Brain</h1>
        <p className="login-subtitle">
          3D memory graph explorer. Sign in to view your knowledge graph.
        </p>

        {error && <p className="login-error">{error}</p>}

        <button className="login-btn login-btn--slack" onClick={handleSlackLogin}>
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

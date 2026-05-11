/**
 * Dashboard component.
 *
 * A three-panel summary view showing:
 *   - Active commitments (from /api/commitments/active)
 *   - People (entity type=person from /api/stats)
 *   - Activity timeline (recent events from /api/timeline)
 *
 * Rendered as an overlay panel that can be toggled from the TopHudBar.
 * When open it sits on top of the 3D graph, giving a quick text-based
 * summary before diving into the visualization.
 */

import { useEffect, useState, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * @param {object} props
 * @param {boolean} props.open         - Whether the dashboard is visible
 * @param {Function} props.onClose     - Called when the user dismisses it
 * @param {object} [props.user]        - Authenticated user { sub, name }
 */
export function Dashboard({ open, onClose, user }) {
  const [commitments, setCommitments] = useState([]);
  const [people, setPeople] = useState([]);
  const [activity, setActivity] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cmtRes, statsRes, tlRes] = await Promise.all([
        fetch('/api/commitments/active?limit=10').then(r => r.json()),
        fetch('/api/stats').then(r => r.json()),
        fetch('/api/timeline?start=2020-01-01').then(r => r.json()),
      ]);

      setCommitments(cmtRes.commitments || cmtRes || []);
      setStats(statsRes);

      // Extract people entities from graph stats
      const personType = (statsRes.entityTypes || []).find(t => t.type === 'person');
      if (personType && personType.count > 0) {
        // Fetch a quick entity list via search (empty query returns top entities)
        try {
          const searchRes = await fetch('/api/search?q=&limit=20').then(r => r.json());
          const persons = (searchRes.nodes || []).filter(n => n.type === 'person').slice(0, 12);
          setPeople(persons);
        } catch {
          setPeople([]);
        }
      }

      // Take the 15 most recent timeline events
      const sorted = Array.isArray(tlRes)
        ? [...tlRes].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 15)
        : [];
      setActivity(sorted);
    } catch (err) {
      setError('Failed to load dashboard data. Is the memory daemon running?');
      console.error('[Dashboard] load error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload whenever the dashboard is opened
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  if (!open) return null;

  return (
    <div className="dashboard-overlay" role="dialog" aria-label="Dashboard">
      <div className="dashboard-backdrop" onClick={onClose} />
      <div className="dashboard-panel">
        <DashboardHeader user={user} onClose={onClose} onRefresh={load} loading={loading} />

        {error && <div className="dashboard-error">{error}</div>}

        {stats && <StatsBar stats={stats} />}

        <div className="dashboard-grid">
          <CommitmentsPanel commitments={commitments} loading={loading} />
          <PeoplePanel people={people} loading={loading} />
          <ActivityPanel activity={activity} loading={loading} />
        </div>
      </div>

      <style>{DASHBOARD_STYLES}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function DashboardHeader({ user, onClose, onRefresh, loading }) {
  return (
    <div className="dashboard-header">
      <div className="dashboard-header-left">
        <h2 className="dashboard-title">Dashboard</h2>
        {user && <span className="dashboard-user">{user.name}</span>}
      </div>
      <div className="dashboard-header-actions">
        <button
          className="dashboard-btn dashboard-btn--icon"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh dashboard"
        >
          {loading ? '...' : '↻'}
        </button>
        <button
          className="dashboard-btn dashboard-btn--icon"
          onClick={onClose}
          title="Close"
          aria-label="Close dashboard"
        >
          ×
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats bar
// ---------------------------------------------------------------------------

function StatsBar({ stats }) {
  const items = [
    { label: 'Entities', value: stats.entities },
    { label: 'Memories', value: stats.memories },
    { label: 'Relationships', value: stats.relationships },
    { label: 'Patterns', value: stats.patterns },
    { label: 'Commitments', value: stats.commitments },
    { label: 'Today', value: stats.recentActivity },
  ];

  return (
    <div className="stats-bar">
      {items.map(({ label, value }) => (
        <div key={label} className="stats-item">
          <span className="stats-value">{value ?? 0}</span>
          <span className="stats-label">{label}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commitments panel
// ---------------------------------------------------------------------------

function CommitmentsPanel({ commitments, loading }) {
  return (
    <section className="dash-panel">
      <h3 className="dash-panel-title">Active Commitments</h3>
      {loading && commitments.length === 0 ? (
        <Skeleton rows={4} />
      ) : commitments.length === 0 ? (
        <EmptyState message="No active commitments." />
      ) : (
        <ul className="dash-list">
          {commitments.map((c, i) => (
            <CommitmentItem key={c.id || i} commitment={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CommitmentItem({ commitment }) {
  const text = commitment.content || commitment.label || String(commitment);
  const isOverdue = commitment.due_date && new Date(commitment.due_date) < new Date();

  return (
    <li className={`dash-list-item ${isOverdue ? 'dash-list-item--overdue' : ''}`}>
      <span className="commitment-dot">{isOverdue ? '⚠️' : '○'}</span>
      <span className="commitment-text">{text}</span>
      {commitment.due_date && (
        <span className="commitment-due">
          {formatDate(commitment.due_date)}
        </span>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// People panel
// ---------------------------------------------------------------------------

function PeoplePanel({ people, loading }) {
  return (
    <section className="dash-panel">
      <h3 className="dash-panel-title">People</h3>
      {loading && people.length === 0 ? (
        <Skeleton rows={5} />
      ) : people.length === 0 ? (
        <EmptyState message="No people tracked yet." />
      ) : (
        <ul className="dash-list">
          {people.map((p, i) => (
            <PersonItem key={p.id || i} person={p} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PersonItem({ person }) {
  const name = person.name || person.label || 'Unknown';
  const memCount = person.memory_count || person.memoryCount || 0;

  return (
    <li className="dash-list-item dash-list-item--person">
      <span className="person-avatar" aria-hidden="true">
        {name[0]?.toUpperCase() || '?'}
      </span>
      <span className="person-name">{name}</span>
      {memCount > 0 && (
        <span className="person-count">{memCount} mem</span>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Activity panel
// ---------------------------------------------------------------------------

function ActivityPanel({ activity, loading }) {
  return (
    <section className="dash-panel">
      <h3 className="dash-panel-title">Recent Activity</h3>
      {loading && activity.length === 0 ? (
        <Skeleton rows={6} />
      ) : activity.length === 0 ? (
        <EmptyState message="No recent activity." />
      ) : (
        <ul className="dash-list">
          {activity.map((event, i) => (
            <ActivityItem key={`${event.event_type}-${event.id}-${i}`} event={event} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityItem({ event }) {
  const icons = {
    memory: '📝',
    entity: '👤',
    relationship: '🔗',
    pattern: '🔍',
  };

  const icon = icons[event.event_type] || '•';
  const label = truncate(event.label || event.event_type, 60);

  return (
    <li className="dash-list-item">
      <span className="activity-icon" aria-hidden="true">{icon}</span>
      <span className="activity-label">{label}</span>
      <span className="activity-time">{formatDate(event.timestamp)}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function Skeleton({ rows = 4 }) {
  return (
    <ul className="dash-list dash-list--skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="dash-list-item skeleton-item" />
      ))}
    </ul>
  );
}

function EmptyState({ message }) {
  return <p className="dash-empty">{message}</p>;
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const DASHBOARD_STYLES = `
  .dashboard-overlay {
    position: fixed;
    inset: 0;
    z-index: 800;
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    padding: 16px;
    pointer-events: none;
  }

  .dashboard-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.4);
    pointer-events: all;
  }

  .dashboard-panel {
    position: relative;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 12px;
    width: min(95vw, 900px);
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    padding: 24px;
    pointer-events: all;
    box-shadow: 0 12px 48px rgba(0,0,0,0.6);
    margin-top: 48px;
  }

  .dashboard-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  .dashboard-header-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .dashboard-title {
    font-size: 18px;
    font-weight: 600;
    color: #e6edf3;
    margin: 0;
  }

  .dashboard-user {
    font-size: 13px;
    color: #8b949e;
    background: #21262d;
    padding: 2px 8px;
    border-radius: 12px;
  }

  .dashboard-header-actions {
    display: flex;
    gap: 8px;
  }

  .dashboard-btn {
    background: none;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #8b949e;
    cursor: pointer;
    padding: 4px 10px;
    font-size: 16px;
    line-height: 1.5;
    transition: background 0.15s, color 0.15s;
  }

  .dashboard-btn:hover { background: #21262d; color: #e6edf3; }
  .dashboard-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .dashboard-error {
    background: rgba(248,81,73,0.1);
    border: 1px solid rgba(248,81,73,0.3);
    border-radius: 6px;
    color: #f85149;
    padding: 10px 14px;
    font-size: 13px;
    margin-bottom: 20px;
  }

  .stats-bar {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 24px;
    padding: 16px;
    background: #0d1117;
    border-radius: 8px;
    border: 1px solid #21262d;
  }

  .stats-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
    min-width: 60px;
  }

  .stats-value {
    font-size: 22px;
    font-weight: 700;
    color: #58a6ff;
    line-height: 1;
  }

  .stats-label {
    font-size: 11px;
    color: #8b949e;
    margin-top: 3px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .dashboard-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 20px;
  }

  .dash-panel {
    background: #0d1117;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 16px;
  }

  .dash-panel-title {
    font-size: 13px;
    font-weight: 600;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0 0 12px 0;
  }

  .dash-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .dash-list-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: #c9d1d9;
    padding: 6px 8px;
    border-radius: 6px;
    background: #161b22;
    min-height: 32px;
  }

  .dash-list-item--overdue {
    background: rgba(248,81,73,0.08);
    border: 1px solid rgba(248,81,73,0.2);
  }

  .commitment-dot { flex-shrink: 0; }
  .commitment-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commitment-due { font-size: 11px; color: #8b949e; flex-shrink: 0; }

  .person-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #388bfd22;
    border: 1px solid #388bfd44;
    color: #58a6ff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
  }

  .person-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .person-count { font-size: 11px; color: #8b949e; flex-shrink: 0; }

  .activity-icon { flex-shrink: 0; font-size: 12px; }
  .activity-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .activity-time { font-size: 11px; color: #8b949e; flex-shrink: 0; }

  .dash-empty {
    font-size: 13px;
    color: #484f58;
    text-align: center;
    padding: 20px 0;
    margin: 0;
  }

  .skeleton-item {
    background: linear-gradient(90deg, #21262d 25%, #2d333b 50%, #21262d 75%);
    background-size: 400% 100%;
    animation: shimmer 1.4s infinite;
    height: 32px;
    border: none;
  }

  @keyframes shimmer {
    0% { background-position: 100% 0; }
    100% { background-position: -100% 0; }
  }
`;

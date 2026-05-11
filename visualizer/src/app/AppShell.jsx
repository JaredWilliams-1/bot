import { useEffect, useState, useCallback } from 'react';
import { BottomTimeline } from '../components/BottomTimeline.jsx';
import { GraphViewport } from '../components/GraphViewport.jsx';
import { LeftSidebar } from '../components/LeftSidebar.jsx';
import { RightInspector } from '../components/RightInspector.jsx';
import { SearchPalette } from '../components/SearchPalette.jsx';
import { TopHudBar } from '../components/TopHudBar.jsx';
import { Login } from '../components/Login.jsx';
import { Dashboard } from '../components/Dashboard.jsx';
import { applyThemeToDocument } from '../lib/theme.js';
import { useGraphStore } from '../store/useGraphStore.js';

export function AppShell() {
  const [timelineRange, setTimelineRange] = useState({ min: null, max: null });
  // Auth state: null = checking, false = unauthenticated, object = user info
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [dashboardOpen, setDashboardOpen] = useState(false);

  const init = useGraphStore((state) => state.init);
  const searchQuery = useGraphStore((state) => state.searchQuery);
  const runSearch = useGraphStore((state) => state.runSearch);
  const setSearchOpen = useGraphStore((state) => state.setSearchOpen);
  const setSettingsOpen = useGraphStore((state) => state.setSettingsOpen);
  const themeId = useGraphStore((state) => state.themeId);
  const leftPanelOpen = useGraphStore((state) => state.leftPanelOpen);
  const inspectorOpen = useGraphStore((state) => state.inspectorOpen);
  const bottomPanelOpen = useGraphStore((state) => state.bottomPanelOpen);

  // Check auth state on mount. /api/auth/me returns { authenticated, user }.
  // AUTH_DISABLED=true makes this return authenticated:true immediately.
  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => {
        setUser(data.authenticated ? data.user : false);
      })
      .catch(() => {
        // If the endpoint 404s (no auth module), treat as authenticated local dev
        setUser({ sub: 'local', name: 'Local' });
      })
      .finally(() => setAuthChecked(true));
  }, []);

  const handleAuthenticated = useCallback((authUser) => {
    setUser(authUser);
  }, []);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      runSearch(searchQuery);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [runSearch, searchQuery]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      }
      if (event.key === 'Escape') {
        setSearchOpen(false);
        setSettingsOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setSearchOpen, setSettingsOpen]);

  useEffect(() => {
    applyThemeToDocument(themeId);
  }, [themeId]);

  // Show login screen if not authenticated (and auth check is done)
  if (authChecked && user === false) {
    return <Login onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div className={`app-shell ${leftPanelOpen ? '' : 'left-collapsed'} ${inspectorOpen ? '' : 'right-collapsed'} ${bottomPanelOpen ? '' : 'bottom-collapsed'}`.trim()}>
      <GraphViewport onTimelineRange={setTimelineRange} />
      <TopHudBar onDashboardOpen={() => setDashboardOpen(true)} />
      {leftPanelOpen ? <LeftSidebar /> : null}
      {inspectorOpen ? <RightInspector /> : null}
      {bottomPanelOpen ? <BottomTimeline timelineRange={timelineRange} /> : null}
      <SearchPalette />
      <Dashboard
        open={dashboardOpen}
        onClose={() => setDashboardOpen(false)}
        user={user || undefined}
      />
    </div>
  );
}

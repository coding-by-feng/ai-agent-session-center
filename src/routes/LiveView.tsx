/**
 * LiveView — Main dashboard view showing active sessions in 3D Cyberdrome.
 * When 3D is disabled, shows a flat view instead to save CPU/GPU: on desktop
 * a board of session cards (or a "no sessions yet" card), on phones the agent
 * list sidebar. On desktop the LIVE tab and the board's cards open the
 * session panel (lib/liveSession.ts), whose rail lists the sessions.
 */
import { lazy, Suspense, Component, useEffect, useMemo, useState } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import type { Session } from '@/types';
import { useSettingsStore } from '@/stores/settingsStore';
import RobotListSidebar from '@/components/3d/RobotListSidebar';
import SceneOverlay from '@/components/3d/SceneOverlay';
import LiveBoard from '@/components/live/LiveBoard';
import LiveEmptyState from '@/components/live/LiveEmptyState';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { useLiveFlatState } from '@/hooks/useLiveBoard';
import { boardSessions } from '@/lib/liveBoard';
import { useIsMobile } from '@/lib/platform';
import styles from '@/styles/modules/LiveView.module.css';

const CyberdromeScene = lazy(() => import('@/components/3d/CyberdromeScene'));

// #57: Error boundary to catch 3D scene crashes gracefully
class SceneErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: string }
> {
  state = { hasError: false, error: '' };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('3D Scene crashed:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          background: '#0e0c1a',
          color: '#ff4444',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          letterSpacing: 1,
          gap: 16,
        }}>
          <div>3D SCENE ERROR</div>
          <div style={{ color: '#888', maxWidth: 400, textAlign: 'center' }}>
            {this.state.error}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: '' })}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--accent-cyan)',
              color: 'var(--accent-cyan)',
              padding: '8px 16px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 11,
            }}
          >
            RETRY
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** How long the page may sit empty while loading before it says why. */
const LOADING_NOTE_DELAY_MS = 2000;

/**
 * Nothing at first, so a normal load never flashes a message; then one line
 * saying why the page is still empty — otherwise a dead server, or a remote
 * device the server refuses, leaves a blank page with only the HUD on it.
 */
function LoadingNote() {
  const connected = useWsStore((s) => s.connected);
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), LOADING_NOTE_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!late) return null;
  return (
    <p className={styles.loadingNote} role="status">
      {connected ? 'Loading sessions…' : 'Connecting to the session server…'}
    </p>
  );
}

/** What a desktop shows in the flat view: the board, the "no sessions yet"
 *  card, or (while the session list is still loading) at most a short note. */
function DesktopFlatContent({ sessions }: { sessions: ReadonlyMap<string, Session> }) {
  const board = useMemo(() => boardSessions(sessions.values()), [sessions]);
  const state = useLiveFlatState();
  if (state === 'board' && board.length > 0) return <LiveBoard sessions={board} />;
  if (state === 'empty') return <LiveEmptyState />;
  return <LoadingNote />;
}

/**
 * Flat view shown when 3D is disabled (the default) — no WebGL.
 *
 * Desktop: the session board, or the "no sessions yet" card (lib/liveBoard.ts
 * decides, and waits for the first snapshot so neither flashes). Phone: the
 * agent list (RobotListSidebar) is the page, as before.
 */
function FlatView() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeCount = Array.from(sessions.values()).filter(
    (s) => s.status !== 'ended',
  ).length;
  // Board and empty state are not a phone workflow — the phone's own list is
  // the page there — so they are unmounted, not hidden (lib/platform.ts, rule 3).
  const isMobile = useIsMobile();
  // RobotListSidebar renders null with zero sessions (`hasAnySessions` in that
  // file). The mobile rule below hides this placeholder ONLY when the sidebar
  // has content to replace it with — hiding it unconditionally would leave a
  // phone with no active sessions looking at a blank page.
  const sidebarShown = isMobile && sessions.size > 0;

  return (
    <div className={styles.flatRoot}>
      {isMobile ? (
        <div className={`${styles.scenePaused} ${sidebarShown ? styles.scenePausedHasSidebar : ''}`}>
          3D Scene Paused
        </div>
      ) : (
        <DesktopFlatContent sessions={sessions} />
      )}
      <SceneOverlay sessionCount={activeCount} />
      <RobotListSidebar />
    </div>
  );
}

export default function LiveView() {
  const scene3dEnabled = useSettingsStore((s) => s.scene3dEnabled);

  if (!scene3dEnabled) {
    return (
      <div style={{ position: 'absolute', inset: 0 }}>
        <FlatView />
      </div>
    );
  }

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <SceneErrorBoundary>
        <Suspense fallback={
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            background: 'var(--bg-primary)',
            color: 'var(--accent-cyan)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            letterSpacing: 2,
          }}>
            INITIALIZING CYBERDROME...
          </div>
        }>
          <CyberdromeScene />
        </Suspense>
      </SceneErrorBoundary>
    </div>
  );
}

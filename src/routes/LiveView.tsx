/**
 * LiveView — Main dashboard view showing active sessions in 3D Cyberdrome.
 * When 3D is disabled, shows a flat view instead to save CPU/GPU. The agent
 * list sidebar appears on phones only; on desktop the LIVE tab opens the
 * session panel (lib/liveSession.ts), whose rail lists the sessions.
 */
import { lazy, Suspense, Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import RobotListSidebar from '@/components/3d/RobotListSidebar';
import SceneOverlay from '@/components/3d/SceneOverlay';
import { useSessionStore } from '@/stores/sessionStore';
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

/** Flat view shown when 3D is disabled — just sidebar + overlay, no WebGL. */
function FlatView() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeCount = Array.from(sessions.values()).filter(
    (s) => s.status !== 'ended',
  ).length;
  // RobotListSidebar renders null with zero sessions (`hasAnySessions` in that
  // file). The mobile rule below hides this placeholder ONLY when the sidebar
  // has content to replace it with — hiding it unconditionally would leave a
  // phone with no active sessions looking at a blank page. The sidebar also
  // renders only on a phone now (see RobotListSidebar), so on desktop there
  // is nothing to replace the placeholder and it must stay.
  const isMobile = useIsMobile();
  const sidebarShown = isMobile && sessions.size > 0;

  return (
    <div className={styles.flatRoot}>
      <div className={`${styles.scenePaused} ${sidebarShown ? styles.scenePausedHasSidebar : ''}`}>
        3D Scene Paused
      </div>
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

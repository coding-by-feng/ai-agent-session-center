/**
 * LiveView — Main dashboard view showing active sessions in 3D Cyberdrome.
 * When 3D is disabled, shows a flat list view with sidebar to save CPU/GPU.
 */
import { lazy, Suspense, Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import RobotListSidebar from '@/components/3d/RobotListSidebar';
import SceneOverlay from '@/components/3d/SceneOverlay';
import { useSessionStore } from '@/stores/sessionStore';

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
              background: '#1a1a2e',
              border: '1px solid #00f0ff',
              color: '#00f0ff',
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

  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--bg-primary, #0a0a1a)' }}>
      <div style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'rgba(255,255,255,0.06)',
        fontFamily: "'Share Tech Mono', 'JetBrains Mono', monospace",
        fontSize: 14,
        letterSpacing: 4,
        textTransform: 'uppercase',
        userSelect: 'none',
      }}>
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
            background: '#0e0c1a',
            color: '#00f0ff',
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

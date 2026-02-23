/**
 * LiveView — Main dashboard view showing active sessions in 3D Cyberdrome.
 */
import { lazy, Suspense, Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';

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

export default function LiveView() {
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

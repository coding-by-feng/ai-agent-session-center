/**
 * LiveView — Main dashboard view showing active sessions in 3D Cyberdrome.
 */
import { lazy, Suspense } from 'react';

const CyberdromeScene = lazy(() => import('@/components/3d/CyberdromeScene'));

export default function LiveView() {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
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
    </div>
  );
}

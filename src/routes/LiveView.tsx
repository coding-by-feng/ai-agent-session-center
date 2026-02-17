/**
 * LiveView — Main dashboard view showing active sessions.
 * Toggles between flat grid and grouped layout.
 */
import { useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useGroupStore } from '@/stores/groupStore';
import SessionGrid from '@/components/session/SessionGrid';
import SessionGroupView from '@/components/session/SessionGroupView';
import styles from '@/styles/modules/ActivityFeed.module.css';

export default function LiveView() {
  const sessions = useSessionStore((s) => s.sessions);
  const groups = useGroupStore((s) => s.groups);
  const [globalMuted, setGlobalMuted] = useState(false);
  const [useGroups, setUseGroups] = useState(() => groups.length > 0);

  // Empty state
  if (sessions.size === 0) {
    return (
      <div className={styles.emptyState} style={{ height: '100%' }}>
        <div className={styles.emptyIcon}>&#x1F916;</div>
        <h2>No Active Sessions</h2>
        <p>Start a Claude Code / Gemini CLI / Codex session to see it here</p>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      {/* Toggle bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 24px',
          fontSize: '10px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-dim)',
        }}
      >
        <button
          onClick={() => setUseGroups(!useGroups)}
          style={{
            padding: '3px 10px',
            background: useGroups ? 'rgba(0, 229, 255, 0.12)' : 'transparent',
            border: `1px solid ${useGroups ? 'var(--accent-cyan)' : 'var(--border-subtle)'}`,
            borderRadius: '4px',
            color: useGroups ? 'var(--accent-cyan)' : 'var(--text-dim)',
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            letterSpacing: '1px',
            cursor: 'pointer',
          }}
        >
          {useGroups ? 'GROUPED' : 'FLAT'}
        </button>

        <button
          onClick={() => setGlobalMuted(!globalMuted)}
          style={{
            padding: '3px 10px',
            background: globalMuted ? 'rgba(255, 51, 85, 0.12)' : 'transparent',
            border: `1px solid ${globalMuted ? 'var(--accent-red)' : 'var(--border-subtle)'}`,
            borderRadius: '4px',
            color: globalMuted ? 'var(--accent-red)' : 'var(--text-dim)',
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            letterSpacing: '1px',
            cursor: 'pointer',
          }}
        >
          {globalMuted ? 'MUTED' : 'SOUND'}
        </button>
      </div>

      {useGroups ? (
        <SessionGroupView globalMuted={globalMuted} />
      ) : (
        <SessionGrid globalMuted={globalMuted} />
      )}
    </div>
  );
}

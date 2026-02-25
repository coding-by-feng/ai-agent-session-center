/**
 * DetailPanel is the slide-in panel from the right showing session details.
 * Uses ResizablePanel for width adjustment.
 * Ported from public/js/detailPanel.js.
 */
import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useWsStore } from '@/stores/wsStore';
import ResizablePanel from '@/components/ui/ResizablePanel';
import DetailTabs from './DetailTabs';
import PromptHistory from './PromptHistory';
import ActivityLog from './ActivityLog';
import NotesTab from './NotesTab';
import SummaryTab from './SummaryTab';
import QueueTab from './QueueTab';
import ProjectTab from './ProjectTab';
import SessionControlBar from './SessionControlBar';
import KillConfirmModal, { KILL_MODAL_ID } from './KillConfirmModal';
import AlertModal, { ALERT_MODAL_ID } from './AlertModal';
import SummarizeModal, { SUMMARIZE_MODAL_ID } from './SummarizeModal';
import TerminalContainer from '@/components/terminal/TerminalContainer';
import type { RobotModelType } from '@/lib/robot3DModels';
import { getModelLabel } from '@/lib/robot3DModels';
import { PALETTE } from '@/lib/robot3DGeometry';
import { formatDuration, getStatusLabel } from '@/lib/format';
import styles from '@/styles/modules/DetailPanel.module.css';

// ---------------------------------------------------------------------------
// LazyModal — only mounts children when the modal is active.
// Prevents zustand subscriptions in KillConfirmModal/AlertModal/SummarizeModal
// from firing during the initial DetailPanel mount.
// ---------------------------------------------------------------------------

function LazyModal({ modalId, children }: { modalId: string; children: ReactNode }) {
  const activeModal = useUiStore((s) => s.activeModal);
  if (activeModal !== modalId) return null;
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Terminal content wrapper (accesses WsClient from store)
// ---------------------------------------------------------------------------

function TerminalContent({ session }: { session: Session }) {
  const client = useWsStore((s) => s.client);
  const ws = useMemo(() => client?.getRawSocket() ?? null, [client]);
  const isSSH = session.source === 'ssh';
  const showReconnect = isSSH && session.status === 'ended';

  const handleReconnect = useCallback(() => {
    fetch(`/api/sessions/${session.sessionId}/reconnect-terminal`, { method: 'POST' })
      .catch(() => {});
  }, [session.sessionId]);

  return (
    <div className={styles.terminalWithQueue}>
      <div className={styles.terminalSection}>
        <TerminalContainer
          terminalId={session.terminalId}
          ws={ws}
          showReconnect={showReconnect}
          onReconnect={isSSH ? handleReconnect : undefined}
        />
      </div>
      <QueueTab
        sessionId={session.sessionId}
        sessionStatus={session.status}
        terminalId={session.terminalId}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DetailPanel() {
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const deselectSession = useSessionStore((s) => s.deselectSession);

  const session: Session | undefined = selectedSessionId
    ? sessions.get(selectedSessionId)
    : undefined;

  // #10: Close on Escape — depend on sessionId (stable) not full session object
  useEffect(() => {
    if (!selectedSessionId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('.xterm')) {
        deselectSession();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedSessionId, deselectSession]);

  // Persist selection
  useEffect(() => {
    if (selectedSessionId) {
      try {
        localStorage.setItem('selected-session', selectedSessionId);
      } catch {
        // ignore
      }
    } else {
      try {
        localStorage.removeItem('selected-session');
      } catch {
        // ignore
      }
    }
  }, [selectedSessionId]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) deselectSession();
    },
    [deselectSession],
  );

  if (!session) return null;

  const durText = formatDuration(Date.now() - session.startedAt);
  const statusLabel = getStatusLabel(session.status);
  const isDisconnected = session.status === 'ended';
  const modelType = (session.characterModel || 'robot').toLowerCase() as RobotModelType;
  const neonColor = session.accentColor || PALETTE[(session.colorIndex ?? 0) % PALETTE.length];
  const modelLabel = getModelLabel(modelType);
  const statusColor: Record<string, string> = {
    idle: '#00ff88', prompting: '#00e5ff', working: '#ff9100',
    waiting: '#00e5ff', approval: '#ffdd00', input: '#aa66ff',
    ended: '#ff4444', connecting: '#666',
  };

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <ResizablePanel
        initialWidth={480}
        minWidth={320}
        maxWidth={Math.round(window.innerWidth * 0.95)}
        side="right"
      >
        {/* Close button */}
        <button
          className={styles.closeBtn}
          onClick={deselectSession}
          title="Close"
        >
          &times;
        </button>

        {/* Header */}
        <div className={styles.header}>
          {/* #55: 2D robot badge preview (avoids WebGL context exhaustion from per-panel Canvas) */}
          <div className={styles.charPreview} style={{
            width: 64,
            height: 80,
            borderRadius: 6,
            border: `1px solid ${statusColor[session.status] ?? '#666'}40`,
            background: `${statusColor[session.status] ?? '#666'}10`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
          }}>
            <div style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: `${neonColor}30`,
              border: `2px solid ${neonColor}`,
              boxShadow: `0 0 8px ${neonColor}40`,
            }} />
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: 0.5,
              color: neonColor,
              textTransform: 'uppercase',
              opacity: 0.8,
            }}>
              {modelLabel}
            </span>
          </div>

          <div className={styles.headerText}>
            <div className={styles.headerTop}>
              <div className={styles.headerTitles}>
                <h3>{session.projectName}</h3>
                {session.title && (
                  <div className={styles.titleRow}>
                    <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                      {session.title}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className={styles.meta}>
              <span
                className={`${styles.detailStatusBadge} ${isDisconnected ? 'disconnected' : session.status}`}
              >
                {statusLabel}
              </span>
              {session.model && (
                <span className={styles.detailModel}>{session.model}</span>
              )}
              {durText && (
                <span className={styles.detailDuration}>{durText}</span>
              )}
            </div>
          </div>
        </div>

        {/* Session controls */}
        <SessionControlBar session={session} />

        {/* Tabs and content */}
        <DetailTabs
          terminalContent={
            <TerminalContent session={session} />
          }
          promptsContent={
            <PromptHistory
              prompts={session.promptHistory || []}
              previousSessions={session.previousSessions}
            />
          }
          notesContent={<NotesTab sessionId={session.sessionId} />}
          activityContent={
            <ActivityLog
              events={session.events || []}
              toolLog={session.toolLog || []}
              responseLog={session.responseLog || []}
            />
          }
          summaryContent={<SummaryTab summary={session.summary} />}
          queueContent={
            <QueueTab
              sessionId={session.sessionId}
              sessionStatus={session.status}
              terminalId={session.terminalId}
            />
          }
          projectContent={
            session.projectPath
              ? <ProjectTab projectPath={session.projectPath} />
              : <div className={styles.tabEmpty}>No project path detected for this session</div>
          }
        />

        {/* Modals — only mount when their modal is active to avoid unnecessary
            zustand subscriptions during DetailPanel mount (reduces cascading re-renders). */}
        <LazyModal modalId={KILL_MODAL_ID}><KillConfirmModal /></LazyModal>
        <LazyModal modalId={ALERT_MODAL_ID}><AlertModal /></LazyModal>
        <LazyModal modalId={SUMMARIZE_MODAL_ID}><SummarizeModal /></LazyModal>
      </ResizablePanel>
    </div>
  );
}

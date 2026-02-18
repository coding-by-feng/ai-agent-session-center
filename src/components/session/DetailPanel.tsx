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
import SessionControlBar from './SessionControlBar';
import KillConfirmModal, { KILL_MODAL_ID } from './KillConfirmModal';
import AlertModal, { ALERT_MODAL_ID } from './AlertModal';
import SummarizeModal, { SUMMARIZE_MODAL_ID } from './SummarizeModal';
import TerminalContainer from '@/components/terminal/TerminalContainer';
import { getModelLabel, type RobotModelType } from '@/lib/robot3DModels';
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
  const showReconnect = session.source === 'ssh' && session.status === 'ended';

  const handleReconnect = useCallback(() => {
    fetch(`/api/sessions/${session.sessionId}/reconnect-terminal`, { method: 'POST' })
      .catch(() => {});
  }, [session.sessionId]);

  return (
    <TerminalContainer
      terminalId={session.terminalId}
      ws={ws}
      showReconnect={showReconnect}
      onReconnect={handleReconnect}
    />
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

  // Close on Escape
  useEffect(() => {
    if (!session) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') deselectSession();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [session, deselectSession]);

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
          {/* Mini robot icon */}
          <div className={styles.charPreview} style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 48,
            height: 48,
            borderRadius: 6,
            border: `1px solid ${statusColor[session.status] ?? '#666'}40`,
            background: `${statusColor[session.status] ?? '#666'}10`,
          }}>
            <span style={{
              fontSize: 20,
              color: statusColor[session.status] ?? '#666',
              fontFamily: "'Orbitron', sans-serif",
              fontWeight: 700,
            }}>
              {getModelLabel(modelType).charAt(0)}
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

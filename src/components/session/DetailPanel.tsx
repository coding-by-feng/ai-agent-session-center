/**
 * DetailPanel is the slide-in panel from the right showing session details.
 * Uses ResizablePanel for width adjustment.
 * Ported from public/js/detailPanel.js.
 */
import { useState, useCallback, useEffect, useMemo, memo, type ReactNode } from 'react';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useWsStore } from '@/stores/wsStore';
import ResizablePanel from '@/components/ui/ResizablePanel';
import DetailTabs from './DetailTabs';
import PromptHistory from './PromptHistory';
import ActivityLog from './ActivityLog';
import NotesTab from './NotesTab';
import QueueTab from './QueueTab';
import ProjectTabContainer from './ProjectTabContainer';
import SessionControlBar from './SessionControlBar';
import SessionSwitcher from './SessionSwitcher';
import KillConfirmModal, { KILL_MODAL_ID } from './KillConfirmModal';
import AlertModal, { ALERT_MODAL_ID } from './AlertModal';
import TerminalContainer from '@/components/terminal/TerminalContainer';
import type { RobotModelType } from '@/lib/robot3DModels';
import { getModelLabel } from '@/lib/robot3DModels';
import { PALETTE } from '@/lib/robot3DGeometry';
import { formatDuration, getStatusLabel } from '@/lib/format';
import styles from '@/styles/modules/DetailPanel.module.css';

// ---------------------------------------------------------------------------
// LazyModal — only mounts children when the modal is active.
// Prevents zustand subscriptions in KillConfirmModal/AlertModal
// from firing during the initial DetailPanel mount.
// ---------------------------------------------------------------------------

function LazyModal({ modalId, children }: { modalId: string; children: ReactNode }) {
  const activeModal = useUiStore((s) => s.activeModal);
  if (activeModal !== modalId) return null;
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Terminal content wrapper (accesses WsClient from store)
// IMPORTANT: Defined outside DetailPanel to avoid React treating it as a new
// component type on every render (which would unmount/remount the terminal
// and queue subtree, tearing down xterm and losing local component state).
// ---------------------------------------------------------------------------

interface TerminalContentProps {
  sessionId: string;
  terminalId: string | null;
  source: string;
  status: string;
  projectPath?: string;
}

const TerminalContent = memo(function TerminalContent({
  sessionId,
  terminalId,
  source,
  status,
  projectPath,
}: TerminalContentProps) {
  const client = useWsStore((s) => s.client);
  const ws = useMemo(() => client?.getRawSocket() ?? null, [client]);
  const isSSH = source === 'ssh';
  const showReconnect = isSSH && status === 'ended' && !terminalId;
  const [bookmarkTarget, setBookmarkTarget] = useState<HTMLDivElement | null>(null);

  const handleReconnect = useCallback(() => {
    fetch(`/api/sessions/${sessionId}/reconnect-terminal`, { method: 'POST' })
      .catch(() => {});
  }, [sessionId]);

  return (
    <div className={styles.terminalWithQueue}>
      <div className={styles.terminalSection}>
        <TerminalContainer
          terminalId={terminalId}
          ws={ws}
          showReconnect={showReconnect}
          onReconnect={isSSH ? handleReconnect : undefined}
          bookmarkPortalTarget={bookmarkTarget}
          projectPath={projectPath}
        />
      </div>
      <div className={styles.bottomRow}>
        <QueueTab
          sessionId={sessionId}
          sessionStatus={status}
          terminalId={terminalId}
        />
        <div ref={setBookmarkTarget} className={styles.bookmarkPortal} />
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DetailPanel() {
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const deselectSession = useSessionStore((s) => s.deselectSession);
  const selectSession = useSessionStore((s) => s.selectSession);

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

  const [headerCollapsed, setHeaderCollapsed] = useState(() => {
    try { return localStorage.getItem('detail-header-collapsed') !== '0'; } catch { return true; }
  });
  const [activeTab, setActiveTab] = useState<string>(() => {
    try { return localStorage.getItem('active-tab') || 'terminal'; } catch { return 'terminal'; }
  });

  // Switch to project tab when a file link is clicked in the terminal
  const pendingFileOpen = useUiStore((s) => s.pendingFileOpen);
  const [externalTab, setExternalTab] = useState<string | null>(null);
  useEffect(() => {
    if (pendingFileOpen) {
      setExternalTab('project');
      // Clear after a tick so the tab switch takes effect
      const id = setTimeout(() => setExternalTab(null), 50);
      return () => clearTimeout(id);
    }
  }, [pendingFileOpen]);

  if (!session) return null;

  const durText = formatDuration(Date.now() - session.startedAt);
  const statusLabel = getStatusLabel(session.status);
  const isDisconnected = session.status === 'ended';
  const modelType = (session.characterModel || 'robot').toLowerCase() as RobotModelType;
  const neonColor = session.accentColor || PALETTE[(session.colorIndex ?? 0) % PALETTE.length];
  const modelLabel = getModelLabel(modelType);
  const statusColor: Record<string, string> = {
    idle: 'var(--accent-green)', prompting: 'var(--accent-cyan)', working: 'var(--accent-orange)',
    waiting: 'var(--accent-cyan)', approval: 'var(--accent-orange)', input: 'var(--accent-purple)',
    ended: 'var(--accent-red)', connecting: 'var(--text-dim)',
  };

  return (
    <div className={styles.overlay}>
      <ResizablePanel fullscreen>
        {/* Session switcher (merged with compact header when collapsed) */}
        <SessionSwitcher
          currentSession={session}
          sessions={sessions}
          onSwitch={selectSession}
          statusLabel={statusLabel}
          duration={durText}
          isDisconnected={isDisconnected}
          onClose={deselectSession}
          headerCollapsed={headerCollapsed}
          onToggleCollapse={() => setHeaderCollapsed(prev => {
            const next = !prev;
            try { localStorage.setItem('detail-header-collapsed', next ? '1' : '0'); } catch { /* ignore */ }
            return next;
          })}
        />

        {/* Collapsible header + controls */}
        {!headerCollapsed && (
          <>
            {/* Header */}
            <div className={styles.header}>
              <div className={styles.charPreview} style={{
                width: 64,
                height: 80,
                borderRadius: 6,
                border: `1px solid color-mix(in srgb, ${statusColor[session.status] ?? 'var(--text-dim)'} 25%, transparent)`,
                background: `color-mix(in srgb, ${statusColor[session.status] ?? 'var(--text-dim)'} 6%, transparent)`,
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
          </>
        )}

        {/* Tabs and content */}
        <DetailTabs
          terminalContent={
            <TerminalContent
              sessionId={session.sessionId}
              terminalId={session.terminalId}
              source={session.source}
              status={session.status}
              projectPath={session.projectPath}
            />
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
          queueContent={
            <QueueTab
              sessionId={session.sessionId}
              sessionStatus={session.status}
              terminalId={session.terminalId}
            />
          }
          projectContent={
            session.projectPath
              ? <ProjectTabContainer projectPath={session.projectPath} />
              : <div className={styles.tabEmpty}>No project path detected for this session</div>
          }
          onTabChange={setActiveTab}
          sessionId={session.sessionId}
          externalActiveTab={externalTab}
        />

        {/* Modals — only mount when their modal is active to avoid unnecessary
            zustand subscriptions during DetailPanel mount (reduces cascading re-renders). */}
        <LazyModal modalId={KILL_MODAL_ID}><KillConfirmModal /></LazyModal>
        <LazyModal modalId={ALERT_MODAL_ID}><AlertModal /></LazyModal>
      </ResizablePanel>
    </div>
  );
}

/**
 * DetailPanel is the slide-in panel from the right showing session details.
 * Uses ResizablePanel for width adjustment.
 * Ported from public/js/detailPanel.js.
 */
import { useState, useCallback, useEffect, useMemo, useRef, memo, type ReactNode } from 'react';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useWsStore } from '@/stores/wsStore';
import { useRoomStore } from '@/stores/roomStore';
import ResizablePanel from '@/components/ui/ResizablePanel';
import DetailTabs from './DetailTabs';
import PromptHistory from './PromptHistory';
import NotesTab from './NotesTab';
import QueueTab from './QueueTab';
import ProjectTabContainer from './ProjectTabContainer';
import SessionControlBar from './SessionControlBar';
import SessionSwitcher from './SessionSwitcher';
import LabelChips from './LabelChips';
import KillConfirmModal, { KILL_MODAL_ID } from './KillConfirmModal';
import TerminalContainer from '@/components/terminal/TerminalContainer';
import { PALETTE } from '@/lib/robot3DGeometry';
import { formatDuration, getStatusLabel } from '@/lib/format';
import { detectCli } from '@/lib/cliDetect';
import styles from '@/styles/modules/DetailPanel.module.css';

// ---------------------------------------------------------------------------
// LazyModal — only mounts children when the modal is active.
// Prevents zustand subscriptions in KillConfirmModal
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
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const hasStartupCommand = !!session?.startupCommand;
  const canReconnect = isSSH || hasStartupCommand;
  const showReconnect = canReconnect && status === 'ended' && !terminalId;
  const [bookmarkTarget, setBookmarkTarget] = useState<HTMLDivElement | null>(null);

  const isClaudeCode = session ? detectCli(session) === 'claude' : false;

  const handleReconnect = useCallback(() => {
    fetch(`/api/sessions/${sessionId}/reconnect-terminal`, { method: 'POST' })
      .catch(() => {});
  }, [sessionId]);

  const handleFork = useCallback(() => {
    fetch(`/api/sessions/${sessionId}/fork`, { method: 'POST' })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && data.terminalId) {
          useSessionStore.getState().selectSession(data.terminalId);
          const room = useRoomStore.getState().getRoomForSession(sessionId);
          if (room) {
            useRoomStore.getState().addSession(room.id, data.terminalId);
          }
        }
      })
      .catch(() => {});
  }, [sessionId]);

  const handleClone = useCallback(() => {
    fetch(`/api/sessions/${sessionId}/clone`, { method: 'POST' })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && data.terminalId) {
          useSessionStore.getState().selectSession(data.terminalId);
          const room = useRoomStore.getState().getRoomForSession(sessionId);
          if (room) {
            useRoomStore.getState().addSession(room.id, data.terminalId);
          }
        }
      })
      .catch(() => {});
  }, [sessionId]);

  return (
    <div className={styles.terminalWithQueue}>
      <div className={styles.terminalSection}>
        <TerminalContainer
          terminalId={terminalId}
          ws={ws}
          showReconnect={showReconnect}
          onReconnect={canReconnect ? handleReconnect : undefined}
          onFork={isClaudeCode ? handleFork : undefined}
          onClone={handleClone}
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
// Ops terminal content wrapper (for the COMMANDS tab — blank shell)
// ---------------------------------------------------------------------------

interface OpsTerminalContentProps {
  sessionId: string;
  opsTerminalId: string | null;
  projectPath?: string;
}

const OpsTerminalContent = memo(function OpsTerminalContent({
  sessionId,
  opsTerminalId,
  projectPath,
}: OpsTerminalContentProps) {
  const client = useWsStore((s) => s.client);
  const ws = useMemo(() => client?.getRawSocket() ?? null, [client]);
  const [connecting, setConnecting] = useState(false);

  const handleReconnect = useCallback(() => {
    setConnecting(true);
    fetch(`/api/sessions/${sessionId}/reconnect-ops-terminal`, { method: 'POST' })
      .catch(() => {})
      .finally(() => setTimeout(() => setConnecting(false), 2000));
  }, [sessionId]);

  // Reset connecting state when terminal connects
  useEffect(() => {
    if (opsTerminalId) setConnecting(false);
  }, [opsTerminalId]);

  if (!opsTerminalId) {
    return (
      <div className={styles.opsReconnectPlaceholder}>
        <div className={styles.opsReconnectIcon}>&#x2387;</div>
        <div className={styles.opsReconnectLabel}>
          {connecting ? 'Connecting...' : 'No terminal connected'}
        </div>
        <button
          className={styles.opsReconnectBtn}
          onClick={handleReconnect}
          disabled={connecting}
        >
          {connecting ? 'CONNECTING...' : 'CONNECT TERMINAL'}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.terminalSection} style={{ height: '100%' }}>
      <TerminalContainer
        terminalId={opsTerminalId}
        ws={ws}
        showReconnect={false}
        onReconnect={handleReconnect}
        projectPath={projectPath}
      />
    </div>
  );
});

// ---------------------------------------------------------------------------
// EditableTitle — click-to-edit session title
// ---------------------------------------------------------------------------

function EditableTitle({ session }: { session: Session }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const displayTitle = session.title || session.projectName || '(untitled)';

  const startEditing = useCallback(() => {
    setDraft(session.title || '');
    setEditing(true);
  }, [session.title]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = useCallback(() => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === (session.title || '')) return;
    // Optimistic update in the local store
    useSessionStore.getState().updateSession({ ...session, title: trimmed });
    // Persist to server
    fetch(`/api/sessions/${session.sessionId}/title`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: trimmed }),
    }).catch(() => {});
  }, [draft, session]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') setEditing(false);
  }, [save]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={styles.editableTitle}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={handleKeyDown}
        maxLength={500}
      />
    );
  }

  return (
    <h3
      className={styles.clickableTitle}
      onClick={startEditing}
      title="Click to rename"
    >
      {displayTitle}
    </h3>
  );
}

// ---------------------------------------------------------------------------
// Draggable minimized badge
// ---------------------------------------------------------------------------

const MINI_BADGE_POS_KEY = 'mini-badge-pos';

function DraggableMiniBadge({
  title,
  color,
  onRestore,
}: {
  title: string;
  color: string;
  onRestore: () => void;
}) {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = localStorage.getItem(MINI_BADGE_POS_KEY);
      if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return { x: window.innerWidth - 200, y: window.innerHeight - 48 };
  });
  const draggingRef = useRef(false);
  const hasDraggedRef = useRef(false);
  const offsetRef = useRef({ dx: 0, dy: 0 });

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    draggingRef.current = true;
    hasDraggedRef.current = false;
    offsetRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [pos]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    hasDraggedRef.current = true;
    const x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - offsetRef.current.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 32, e.clientY - offsetRef.current.dy));
    setPos({ x, y });
  }, []);

  const handlePointerUp = useCallback(() => {
    draggingRef.current = false;
    // Persist position
    try { localStorage.setItem(MINI_BADGE_POS_KEY, JSON.stringify(pos)); } catch { /* ignore */ }
  }, [pos]);

  const handleClick = useCallback(() => {
    // Only restore if user didn't drag
    if (!hasDraggedRef.current) onRestore();
  }, [onRestore]);

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={handleClick}
      title={`Restore: ${title} (drag to move)`}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        background: 'var(--bg-card)',
        border: `1px solid ${color}`,
        borderRadius: 4,
        color,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12,
        cursor: draggingRef.current ? 'grabbing' : 'grab',
        boxShadow: `0 0 12px ${color}40`,
        userSelect: 'none',
        touchAction: 'none',
      }}
    >
      <span style={{ fontSize: 10 }}>&#x25B2;</span>
      {title}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DetailPanel() {
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  // deselectSession removed from Esc handler — pressing Esc while viewing output
  // would apply display:none, resetting scroll positions to 0.
  const selectSession = useSessionStore((s) => s.selectSession);
  const detailPanelMinimized = useUiStore((s) => s.detailPanelMinimized);
  const minimizeDetailPanel = useUiStore((s) => s.minimizeDetailPanel);
  const restoreDetailPanel = useUiStore((s) => s.restoreDetailPanel);

  const session: Session | undefined = selectedSessionId
    ? sessions.get(selectedSessionId)
    : undefined;

  // Keep last session alive so ProjectTabContainer stays mounted (preserves file state/scroll).
  const lastSessionRef = useRef<Session | undefined>(undefined);
  if (session) lastSessionRef.current = session;
  const displaySession = session ?? lastSessionRef.current;

  // Track all sessions that have been visited so their ProjectTabContainers stay mounted.
  // Each entry maps sessionId → { projectPath, sessionId } for rendering.
  const [visitedProjects, setVisitedProjects] = useState<Map<string, { projectPath: string; sessionId: string }>>(new Map());
  useEffect(() => {
    if (!displaySession?.projectPath || !displaySession?.sessionId) return;
    setVisitedProjects((prev) => {
      if (prev.has(displaySession.sessionId)) return prev;
      const next = new Map(prev);

      // When session is re-keyed (e.g. after /clear), migrate localStorage keys
      // from old sessionId to new so file tabs and project sub-tabs are preserved.
      const oldId = displaySession.replacesId;
      if (oldId && prev.has(oldId)) {
        next.delete(oldId);
        // Migrate project-tabs localStorage
        const oldProjKey = `agent-manager:project-tabs:session:${oldId}`;
        const newProjKey = `agent-manager:project-tabs:session:${displaySession.sessionId}`;
        try {
          const projRaw = localStorage.getItem(oldProjKey);
          if (projRaw) {
            localStorage.setItem(newProjKey, projRaw);
            localStorage.removeItem(oldProjKey);
            // Migrate file-tabs localStorage for each sub-tab
            const parsed = JSON.parse(projRaw);
            if (Array.isArray(parsed.tabs)) {
              for (const tab of parsed.tabs) {
                const oldFileKey = `agent-manager:file-tabs:${oldId}:${tab.id}`;
                const newFileKey = `agent-manager:file-tabs:${displaySession.sessionId}:${tab.id}`;
                const fileRaw = localStorage.getItem(oldFileKey);
                if (fileRaw) {
                  localStorage.setItem(newFileKey, fileRaw);
                  localStorage.removeItem(oldFileKey);
                }
              }
            }
          }
        } catch { /* ignore migration errors */ }
      }

      next.set(displaySession.sessionId, {
        projectPath: displaySession.projectPath!,
        sessionId: displaySession.sessionId,
      });
      return next;
    });
  }, [displaySession?.sessionId, displaySession?.projectPath, displaySession?.replacesId]);

  // ---- Panel search state ----
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    // Focus input on next tick so it's mounted/visible
    setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchMatchIndex(0);
    document.querySelectorAll('.search-highlight-active').forEach((el) =>
      el.classList.remove('search-highlight-active'),
    );
  }, []);

  // Listen for the custom event dispatched by the keyboard shortcut handler
  useEffect(() => {
    const handler = () => openSearch();
    document.addEventListener('detail-panel:find', handler);
    return () => document.removeEventListener('detail-panel:find', handler);
  }, [openSearch]);

  // Reset match index when query changes
  useEffect(() => { setSearchMatchIndex(0); }, [searchQuery]);

  // Close search when session changes
  useEffect(() => { closeSearch(); }, [selectedSessionId, closeSearch]);

  // Compute match count (conversation tab only)
  const searchMatchCount = useMemo(() => {
    if (!displaySession || !searchQuery) return 0;
    const q = searchQuery.toLowerCase();
    let count = 0;
    for (const p of displaySession.promptHistory ?? []) {
      if (p.text.toLowerCase().includes(q)) count++;
    }
    return count;
  }, [displaySession, searchQuery]);

  // navigateMatch is defined below, after activeTab/setExternalTab are declared

  // #10: Close on Escape — close search first, restore if minimized
  useEffect(() => {
    if (!selectedSessionId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('.xterm')) {
        if (searchOpen) {
          closeSearch();
        } else if (detailPanelMinimized) {
          restoreDetailPanel();
        }
        // No deselect — pressing Esc while viewing output would reset scroll position
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedSessionId, searchOpen, closeSearch, detailPanelMinimized, restoreDetailPanel]);

  // Reset minimized state when a new session is selected
  useEffect(() => {
    if (selectedSessionId) restoreDetailPanel();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId]);

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

  const headerCollapsed = useUiStore((s) => s.detailHeaderCollapsed);
  const toggleDetailHeader = useUiStore((s) => s.toggleDetailHeader);
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

  // Keyboard shortcuts dispatch detailTabs:switchTab to jump between tabs
  useEffect(() => {
    let clearId: ReturnType<typeof setTimeout> | null = null;
    const handler = (e: Event) => {
      const tabId = (e as CustomEvent<{ tabId?: string }>).detail?.tabId;
      if (!tabId) return;
      setExternalTab(tabId);
      if (clearId) clearTimeout(clearId);
      clearId = setTimeout(() => setExternalTab(null), 50);
    };
    document.addEventListener('detailTabs:switchTab', handler);
    return () => {
      document.removeEventListener('detailTabs:switchTab', handler);
      if (clearId) clearTimeout(clearId);
    };
  }, []);

  // Track active tab accurately (ref avoids stale closure in navigateMatch)
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // Navigate to prev/next highlighted match — auto-switches to conversation tab when needed
  const navigateMatch = useCallback((direction: 'prev' | 'next') => {
    if (searchMatchCount === 0) return;

    setSearchMatchIndex((prev) => {
      const next = direction === 'next'
        ? (prev + 1) % searchMatchCount
        : (prev - 1 + searchMatchCount) % searchMatchCount;

      const scrollToHighlight = () => {
        requestAnimationFrame(() => {
          const highlights = Array.from(
            document.querySelectorAll<HTMLElement>('.search-highlight'),
          );
          document.querySelectorAll('.search-highlight-active').forEach((el) =>
            el.classList.remove('search-highlight-active'),
          );
          const el = highlights[next];
          el?.classList.add('search-highlight-active');
          el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      };

      if (activeTabRef.current !== 'conversation') {
        setActiveTab('conversation');
        activeTabRef.current = 'conversation';
        setExternalTab('conversation');
        setTimeout(() => {
          setExternalTab(null);
          scrollToHighlight();
        }, 80);
      } else {
        scrollToHighlight();
      }

      return next;
    });
  }, [searchMatchCount]);

  if (!displaySession) return null;

  const durText = formatDuration(Date.now() - displaySession.startedAt);
  const statusLabel = getStatusLabel(displaySession.status);
  const isDisconnected = displaySession.status === 'ended';
  const neonColor = displaySession.accentColor || PALETTE[(displaySession.colorIndex ?? 0) % PALETTE.length];
  const statusColor: Record<string, string> = {
    idle: 'var(--accent-green)', prompting: 'var(--accent-cyan)', working: 'var(--accent-orange)',
    waiting: 'var(--accent-cyan)', approval: 'var(--accent-yellow)', input: 'var(--accent-purple)',
    ended: 'var(--accent-red)', connecting: 'var(--text-dim)',
  };

  if (detailPanelMinimized) {
    return (
      <DraggableMiniBadge
        title={displaySession.title || 'Unnamed'}
        color={neonColor}
        onRestore={restoreDetailPanel}
      />
    );
  }

  return (
    <div className={styles.overlay} style={!session ? { display: 'none' } : undefined}>
      <ResizablePanel fullscreen>
        {/* Session switcher (merged with compact header when collapsed) */}
        <SessionSwitcher
          currentSession={displaySession}
          sessions={sessions}
          onSwitch={selectSession}
          statusLabel={statusLabel}
          duration={durText}
          isDisconnected={isDisconnected}
          onClose={minimizeDetailPanel}
          headerCollapsed={headerCollapsed}
          onToggleCollapse={toggleDetailHeader}
        />

        {/* Collapsible header — robot icon, title, meta, controls */}
        {!headerCollapsed && (
          <div className={styles.header}>
            <div className={styles.headerInfo}>
              <div className={styles.headerText}>
                <div className={styles.headerTop}>
                  <div className={styles.headerTitles}>
                    <EditableTitle session={displaySession} />
                    {displaySession.title && displaySession.projectName && displaySession.title !== displaySession.projectName && (
                      <div className={styles.titleRow}>
                        <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                          {displaySession.projectName}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className={styles.meta}>
                  <span
                    className={`${styles.detailStatusBadge} ${isDisconnected ? 'disconnected' : displaySession.status}`}
                  >
                    {statusLabel}
                  </span>
                  {displaySession.model && (
                    <span className={styles.detailModel}>{displaySession.model}</span>
                  )}
                </div>
              </div>
            </div>

            <SessionControlBar
              session={displaySession}
              labelChips={
                <LabelChips
                  sessionId={displaySession.sessionId}
                  currentLabel={displaySession.label || ''}
                />
              }
            />
          </div>
        )}

        {/* Tabs and content */}
        <DetailTabs
          terminalContent={
            <TerminalContent
              sessionId={displaySession.sessionId}
              terminalId={displaySession.terminalId}
              source={displaySession.source}
              status={displaySession.status}
              projectPath={displaySession.projectPath}
            />
          }
          promptsContent={
            <PromptHistory
              prompts={displaySession.promptHistory || []}
              previousSessions={displaySession.previousSessions}
              searchQuery={searchQuery}
              projectPath={displaySession.projectPath}
            />
          }
          notesContent={<NotesTab sessionId={displaySession.sessionId} projectPath={displaySession.projectPath} />}
          queueContent={
            <QueueTab
              sessionId={displaySession.sessionId}
              sessionStatus={displaySession.status}
              terminalId={displaySession.terminalId}
            />
          }
          projectContent={
            displaySession.projectPath
              ? <div style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', height: '100%' }}>
                  {Array.from(visitedProjects.entries()).map(([sid, info]) => {
                    const isActive = sid === displaySession.sessionId;
                    return (
                      <div key={sid} style={{
                        position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                        visibility: isActive ? 'visible' : 'hidden',
                        pointerEvents: isActive ? 'auto' : 'none',
                        zIndex: isActive ? 1 : 0,
                        display: 'flex', flexDirection: 'column',
                      }}>
                        <ProjectTabContainer projectPath={info.projectPath} sessionId={info.sessionId} />
                      </div>
                    );
                  })}
                </div>
              : <div className={styles.tabEmpty}>No project path detected for this session</div>
          }
          commandsContent={
            (displaySession.opsTerminalId || displaySession.hadOpsTerminal) ? (
              <OpsTerminalContent
                sessionId={displaySession.sessionId}
                opsTerminalId={displaySession.opsTerminalId ?? null}
                projectPath={displaySession.projectPath}
              />
            ) : undefined
          }
          onTabChange={setActiveTab}
          sessionId={displaySession.sessionId}
          externalActiveTab={externalTab}
          searchQuery={searchQuery}
          searchOpen={searchOpen}
          searchMatchCount={searchMatchCount}
          searchMatchIndex={searchMatchIndex}
          onSearchChange={setSearchQuery}
          onSearchClose={closeSearch}
          onSearchPrev={() => navigateMatch('prev')}
          onSearchNext={() => navigateMatch('next')}
          searchInputRef={searchInputRef}
        />

        {/* Modals — only mount when their modal is active to avoid unnecessary
            zustand subscriptions during DetailPanel mount (reduces cascading re-renders). */}
        <LazyModal modalId={KILL_MODAL_ID}><KillConfirmModal /></LazyModal>
      </ResizablePanel>
    </div>
  );
}

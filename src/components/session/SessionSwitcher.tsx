/**
 * SessionSwitcher — bar at the top of the DetailPanel.
 * Top row: current session name + status badge + duration + display toggle + minimize button.
 * Below: always-visible horizontal tab strip showing all other active sessions
 *        as mini robot cards (icon + title + project name + label).
 */
import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useRoomStore, type Room } from '@/stores/roomStore';
import styles from '@/styles/modules/DetailPanel.module.css';

const STATUS_COLORS: Record<string, string> = {
  idle: 'var(--accent-green)',
  prompting: 'var(--accent-cyan)',
  working: 'var(--accent-orange)',
  waiting: 'var(--accent-cyan)',
  approval: 'var(--accent-yellow)',
  input: 'var(--accent-purple)',
  ended: 'var(--accent-red)',
  connecting: 'var(--text-dim)',
};

const STATUS_ORDER: Record<string, number> = {
  working: 0, prompting: 1, approval: 2, input: 2,
  waiting: 3, idle: 4, connecting: 5, ended: 6,
};

// Ordered status → human label for the colour-legend popover. Order follows
// STATUS_ORDER; each swatch is drawn from STATUS_COLORS, so the legend always
// reflects the active theme's accent palette (body[data-theme]).
const STATUS_LEGEND: ReadonlyArray<{ status: string; label: string }> = [
  { status: 'working', label: 'Working' },
  { status: 'prompting', label: 'Prompting' },
  { status: 'approval', label: 'Approval needed' },
  { status: 'input', label: 'Waiting for input' },
  { status: 'waiting', label: 'Waiting' },
  { status: 'idle', label: 'Idle' },
  { status: 'connecting', label: 'Connecting' },
  { status: 'ended', label: 'Disconnected' },
];

// One color per room slot — cycles if more than 8 rooms exist.
// Must match the palette in HeaderAgentStrip so colors agree across the UI.
const ROOM_COLOR_PALETTE = [
  'var(--accent-orange)',
  '#4a9eff',
  'var(--accent-green)',
  'var(--accent-purple)',
  'var(--accent-yellow)',
  '#ff69b4',
  'var(--accent-cyan)',
  '#ff7043',
];

function getRoomColor(room: Room): string {
  const index = ((room.roomIndex ?? 0) % ROOM_COLOR_PALETTE.length + ROOM_COLOR_PALETTE.length) % ROOM_COLOR_PALETTE.length;
  return ROOM_COLOR_PALETTE[index];
}

type TabRenderItem =
  | { type: 'session'; session: Session }
  | { type: 'room'; room: Room; sessions: Session[]; color: string };

/** Detect CLI tool from session command */
function getCliBadge(session: Session): string | null {
  const cmd = (session.sshCommand || session.sshConfig?.command || '').toLowerCase();
  if (cmd.startsWith('claude') || cmd.includes('/claude')) return 'CLAUDE';
  if (cmd.startsWith('codex') || cmd.includes('/codex')) return 'CODEX';
  if (cmd.startsWith('gemini') || cmd.includes('/gemini')) return 'GEMINI';
  if (cmd.startsWith('aider') || cmd.includes('/aider')) return 'AIDER';
  if (session.backendType) {
    const bt = session.backendType.toLowerCase();
    if (bt.includes('claude')) return 'CLAUDE';
    if (bt.includes('codex')) return 'CODEX';
    if (bt.includes('gemini')) return 'GEMINI';
    if (bt.includes('aider')) return 'AIDER';
  }
  return null;
}

/** Room filter funnel icon */
function RoomFilterIcon({ active }: { active: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M1 2h10L7 6.5V10.5L5 9.5V6.5L1 2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill={active ? 'currentColor' : 'none'}
        fillOpacity={active ? 0.3 : 0}
      />
    </svg>
  );
}

/** Pencil icon — hints that the title can be clicked to rename */
function EditIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M8.5 1.5l2 2L4 10l-2.5.5L2 8l6.5-6.5Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Two-column grid icon — shown in compact mode; click to switch to detailed */
function DetailedModeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** Horizontal list icon — shown in detailed mode; click to switch to compact */
function CompactModeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="2" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1" y="9" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** Legend / key icon — opens the status-colour legend popover */
function LegendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="3" cy="3" r="1.5" fill="currentColor" />
      <circle cx="3" cy="7" r="1.5" fill="currentColor" />
      <circle cx="3" cy="11" r="1.5" fill="currentColor" />
      <path d="M6.5 3H12M6.5 7H12M6.5 11H12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** Panel-with-left-rail icon — shown when nav is on top; click to dock it left */
function DockLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1" y="1" width="4.5" height="12" rx="1.5" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

/** Panel-with-top-bar icon — shown when nav is on left; click to dock it top */
function DockTopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1" y="1" width="12" height="4.5" rx="1.5" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

/** Expand-to-corners icon — maximize the detail panel (hide its session strip) */
function MaximizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 5V2.5A.5.5 0 0 1 2.5 2H5M9 2h2.5a.5.5 0 0 1 .5.5V5M12 9v2.5a.5.5 0 0 1-.5.5H9M5 12H2.5a.5.5 0 0 1-.5-.5V9"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Contract-from-corners icon — restore the detail panel's session strip */
function RestoreSizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 2v2.5a.5.5 0 0 1-.5.5H2M9 2v2.5a.5.5 0 0 0 .5.5H12M12 9H9.5a.5.5 0 0 0-.5.5V12M2 9h2.5a.5.5 0 0 1 .5.5V12"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

interface Props {
  currentSession: Session;
  sessions: Map<string, Session>;
  onSwitch: (sessionId: string) => void;
  statusLabel?: string;
  duration?: string;
  isDisconnected?: boolean;
  onClose?: () => void;
  controls?: React.ReactNode;
  model?: string;
}

export default function SessionSwitcher({
  currentSession, sessions, onSwitch,
  statusLabel, duration, isDisconnected,
  onClose,
  controls, model,
}: Props) {
  // Track sessions that finished work (transitioned to "waiting") but haven't been viewed
  const [attentionIds, setAttentionIds] = useState<Set<string>>(new Set());
  const prevStatusRef = useRef(new Map<string, string>());

  useEffect(() => {
    let changed = false;
    const next = new Set(attentionIds);
    sessions.forEach((s) => {
      const prev = prevStatusRef.current.get(s.sessionId);
      // Detect transition TO "waiting" from any non-terminal status.
      // `idle` is included because Codex (legacy `notify`-only mode) jumps
      // straight from idle to waiting on agent-turn-complete — no working/
      // prompting intermediate — and we still want the red ! to appear.
      if (prev && prev !== 'waiting' && prev !== 'ended' && s.status === 'waiting') {
        // Don't mark the currently selected session
        if (s.sessionId !== currentSession.sessionId) {
          next.add(s.sessionId);
          changed = true;
        }
      }
      prevStatusRef.current.set(s.sessionId, s.status);
    });
    if (changed) setAttentionIds(next);
  }, [sessions, currentSession.sessionId, attentionIds]);

  const handleSwitch = useCallback((id: string) => {
    setAttentionIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    onSwitch(id);
  }, [onSwitch]);
  const cardDisplayMode = useUiStore((s) => s.cardDisplayMode);
  const toggleCardDisplayMode = useUiStore((s) => s.toggleCardDisplayMode);
  const navPosition = useUiStore((s) => s.navPosition);
  const toggleNavPosition = useUiStore((s) => s.toggleNavPosition);
  const maximized = useUiStore((s) => s.maximized);
  const toggleMaximized = useUiStore((s) => s.toggleMaximized);
  // Vertical rail only when docked-left AND not maximized
  // (maximizing always collapses the nav to the slim top bar).
  const isVertical = navPosition === 'left' && !maximized;
  const rooms = useRoomStore((s) => s.rooms);

  const selectedRoomIds = useUiStore((s) => s.selectedRoomIds);
  const toggleRoomFilter = useUiStore((s) => s.toggleRoomFilter);
  const clearRoomFilter = useUiStore((s) => s.clearRoomFilter);
  const [roomDropdownOpen, setRoomDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!roomDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setRoomDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [roomDropdownOpen]);

  // Status-colour legend popover (hint for what each session colour means)
  const [legendOpen, setLegendOpen] = useState(false);
  const legendRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!legendOpen) return;
    const handler = (e: MouseEvent) => {
      if (legendRef.current && !legendRef.current.contains(e.target as Node)) {
        setLegendOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [legendOpen]);

  // Derive a stable content signature from `sessions`. The Map reference changes
  // on every session update (pattern `new Map(...)`), but if the visible fields
  // haven't changed the downstream memos don't need to rerun.  This moves the
  // O(N) sort + filter off the hot path for ~95% of session-update events.
  const sessionsSignature = useMemo(() => {
    const parts: string[] = [];
    sessions.forEach((s) => {
      parts.push(`${s.sessionId}|${s.status}|${s.pinned ? 1 : 0}|${s.title ?? ''}|${s.projectName ?? ''}|${s.colorIndex ?? ''}|${s.accentColor ?? ''}|${s.terminalId ?? ''}`);
    });
    parts.sort();
    return parts.join('\n');
  }, [sessions]);

  // Build globally indexed session list (all active, sorted), then split out "others"
  const { sortedSessions, sessionIndexMap, currentIndex } = useMemo(() => {
    const allActive = [...sessions.values()]
      .filter((s) => s.status !== 'ended')
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        const oa = STATUS_ORDER[a.status] ?? 5;
        const ob = STATUS_ORDER[b.status] ?? 5;
        if (oa !== ob) return oa - ob;
        return (a.title || a.projectName || '').localeCompare(b.title || b.projectName || '');
      });
    const indexMap = new Map<string, number>();
    let curIdx = -1;
    allActive.forEach((s, i) => {
      indexMap.set(s.sessionId, i + 1);
      if (s.sessionId === currentSession.sessionId) curIdx = i + 1;
    });
    const others = allActive.filter((s) => s.sessionId !== currentSession.sessionId);
    return { sortedSessions: others, sessionIndexMap: indexMap, currentIndex: curIdx };
    // `sessionsSignature` covers field changes; `sessions` ref is intentionally
    // excluded so unchanged-content re-renders skip the sort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsSignature, currentSession.sessionId]);

  // Rooms that have at least one session in the current active list
  const activeSessionIds = useMemo(() => {
    const ids = new Set<string>();
    sessions.forEach((s) => { if (s.status !== 'ended') ids.add(s.sessionId); });
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsSignature]);
  const availableRooms = useMemo(
    () => rooms.filter((r) => r.sessionIds.some((id) => activeSessionIds.has(id))),
    [rooms, activeSessionIds],
  );

  // Apply room filter to the tab strip (current session is never filtered out)
  const filteredSessions = useMemo(() => {
    if (selectedRoomIds.size === 0) return sortedSessions;
    const allowedIds = new Set<string>();
    for (const roomId of selectedRoomIds) {
      const room = rooms.find((r) => r.id === roomId);
      if (room) room.sessionIds.forEach((id) => allowedIds.add(id));
    }
    return sortedSessions.filter((s) => allowedIds.has(s.sessionId));
  }, [sortedSessions, selectedRoomIds, rooms]);

  // Group same-room sessions into a room-colored frame. Room frames appear in
  // a stable order (sorted by roomIndex) so they don't shuffle when session
  // statuses change. Orphan sessions (no room) render after room frames.
  const tabRenderItems = useMemo((): TabRenderItem[] => {
    const sessionToRoom = new Map<string, Room>();
    for (const room of rooms) {
      for (const sid of room.sessionIds) {
        sessionToRoom.set(sid, room);
      }
    }

    const items: TabRenderItem[] = [];

    const orderedRooms = [...rooms].sort(
      (a, b) => (a.roomIndex ?? Number.MAX_SAFE_INTEGER) - (b.roomIndex ?? Number.MAX_SAFE_INTEGER),
    );

    for (const room of orderedRooms) {
      const roomSessions = filteredSessions.filter((s) =>
        room.sessionIds.includes(s.sessionId),
      );
      if (roomSessions.length === 0) continue;
      items.push({ type: 'room', room, sessions: roomSessions, color: getRoomColor(room) });
    }

    for (const session of filteredSessions) {
      if (sessionToRoom.has(session.sessionId)) continue;
      items.push({ type: 'session', session });
    }

    return items;
  }, [filteredSessions, rooms]);

  const selectedRoomNames = useMemo(() => {
    if (selectedRoomIds.size === 0) return '';
    return [...selectedRoomIds]
      .map((id) => rooms.find((r) => r.id === id)?.name)
      .filter(Boolean)
      .join(', ');
  }, [selectedRoomIds, rooms]);

  const toggleRoom = useCallback((roomId: string) => {
    toggleRoomFilter(roomId);
  }, [toggleRoomFilter]);

  const primaryName = currentSession.title || currentSession.projectName || '(untitled)';
  const secondaryName = currentSession.title && currentSession.projectName && currentSession.title !== currentSession.projectName
    ? currentSession.projectName
    : null;
  const currentColor = STATUS_COLORS[currentSession.status] ?? 'var(--text-dim)';
  const isCompact = cardDisplayMode === 'compact';

  // ---- Inline rename for the header title (currentSession) ----
  const [headerEditing, setHeaderEditing] = useState(false);
  const [headerDraft, setHeaderDraft] = useState(primaryName);
  const headerInputRef = useRef<HTMLInputElement | null>(null);

  const beginHeaderEdit = useCallback(() => {
    setHeaderDraft(currentSession.title || currentSession.projectName || '');
    setHeaderEditing(true);
  }, [currentSession.title, currentSession.projectName]);

  const commitHeaderEdit = useCallback(() => {
    const trimmed = headerDraft.trim();
    if (trimmed && trimmed !== currentSession.title) {
      useSessionStore.getState().setSessionTitle(currentSession.sessionId, trimmed);
    }
    setHeaderEditing(false);
  }, [headerDraft, currentSession.sessionId, currentSession.title]);

  const cancelHeaderEdit = useCallback(() => {
    setHeaderEditing(false);
  }, []);

  useEffect(() => {
    if (headerEditing && headerInputRef.current) {
      headerInputRef.current.focus();
      headerInputRef.current.select();
    }
  }, [headerEditing]);

  // Exit edit mode if user switches sessions mid-edit
  useEffect(() => {
    setHeaderEditing(false);
  }, [currentSession.sessionId]);

  return (
    <div className={`${styles.switcherBar}${isVertical ? ` ${styles.switcherBarVertical}` : ''}`}>
      {/* ── Top row: current session name + meta controls ── */}
      <div className={styles.switcherToggle}>
        <div className={styles.switcherNameDisplay}>
          <span
            className={styles.switcherDot}
            style={{ background: currentColor, boxShadow: `0 0 6px ${currentColor}` }}
          />
          {currentIndex > 0 && (
            <span className={styles.switcherIndex}>{currentIndex}</span>
          )}
          {headerEditing ? (
            <input
              ref={headerInputRef}
              className={styles.switcherNameInput}
              value={headerDraft}
              onChange={(e) => setHeaderDraft(e.target.value)}
              onBlur={commitHeaderEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitHeaderEdit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelHeaderEdit();
                }
              }}
              aria-label="Session title"
              maxLength={200}
            />
          ) : (
            <span
              className={styles.switcherName}
              onDoubleClick={beginHeaderEdit}
            >
              <span className={styles.switcherNameText}>{primaryName}</span>
              <button
                type="button"
                className={styles.switcherEditHint}
                onClick={beginHeaderEdit}
                title="Rename session"
                aria-label="Rename session"
              >
                <EditIcon />
              </button>
            </span>
          )}
          {secondaryName && (
            <span className={styles.switcherProject}>{secondaryName}</span>
          )}
        </div>

        {/* Right side: status + duration + display toggle + minimize */}
        <div className={styles.switcherMeta}>
          {statusLabel && (
            <span
              className={`${styles.detailStatusBadge} ${isDisconnected ? 'disconnected' : currentSession.status}`}
            >
              {statusLabel}
            </span>
          )}
          {model && (
            <span className={styles.detailModel}>{model}</span>
          )}
          {duration && (
            <span className={styles.detailDuration}>{duration}</span>
          )}
          {controls && (
            <span className={styles.switcherControls}>{controls}</span>
          )}
          {/* Room filter dropdown (multi-select) */}
          {availableRooms.length > 0 && (
            <div className={styles.roomFilterWrap} ref={dropdownRef}>
              <button
                className={`${styles.displayModeToggle}${selectedRoomIds.size > 0 ? ` ${styles.roomFilterActive}` : ''}`}
                onClick={() => setRoomDropdownOpen((o) => !o)}
                title={selectedRoomIds.size > 0 ? `Filtering: ${selectedRoomNames}` : 'Filter by room'}
                type="button"
              >
                <RoomFilterIcon active={selectedRoomIds.size > 0} />
              </button>
              {roomDropdownOpen && (
                <div className={styles.roomFilterDropdown}>
                  <button
                    className={`${styles.roomFilterOption}${selectedRoomIds.size === 0 ? ` ${styles.roomFilterOptionActive}` : ''}`}
                    onClick={() => { clearRoomFilter(); setRoomDropdownOpen(false); }}
                    type="button"
                  >
                    All rooms
                  </button>
                  {availableRooms.map((r) => (
                    <button
                      key={r.id}
                      className={`${styles.roomFilterOption}${selectedRoomIds.has(r.id) ? ` ${styles.roomFilterOptionActive}` : ''}`}
                      onClick={() => toggleRoom(r.id)}
                      type="button"
                    >
                      {selectedRoomIds.has(r.id) && <span className={styles.roomFilterCheck}>&#x2713;</span>}
                      {r.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Status-colour legend — hint for what each session-title/badge colour
              means under the currently selected theme */}
          <div className={styles.roomFilterWrap} ref={legendRef}>
            <button
              className={`${styles.displayModeToggle}${legendOpen ? ` ${styles.roomFilterActive}` : ''}`}
              onClick={() => setLegendOpen((o) => !o)}
              title="Status colour legend"
              aria-label="Status colour legend"
              aria-expanded={legendOpen}
              type="button"
            >
              <LegendIcon />
            </button>
            {legendOpen && (
              <div className={styles.statusLegendDropdown} role="group" aria-label="Session status colours">
                <div className={styles.statusLegendTitle}>STATUS COLOURS</div>
                {STATUS_LEGEND.map(({ status, label }) => {
                  const c = STATUS_COLORS[status] ?? 'var(--text-dim)';
                  return (
                    <div key={status} className={styles.statusLegendRow}>
                      <span
                        className={styles.statusLegendSwatch}
                        style={{ background: c, boxShadow: `0 0 5px ${c}` }}
                        aria-hidden="true"
                      />
                      <span className={styles.statusLegendLabel}>{label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <button
            className={styles.displayModeToggle}
            onClick={toggleCardDisplayMode}
            title={isCompact ? 'Detailed view' : 'Compact view'}
            type="button"
          >
            {isCompact ? <DetailedModeIcon /> : <CompactModeIcon />}
          </button>
          {/* Dock the session nav bar on top (default) or as a left rail */}
          <button
            className={`${styles.displayModeToggle}${navPosition === 'left' ? ` ${styles.roomFilterActive}` : ''}`}
            onClick={toggleNavPosition}
            title={navPosition === 'left' ? 'Dock session bar on top' : 'Dock session bar on left'}
            aria-label={navPosition === 'left' ? 'Dock session bar on top' : 'Dock session bar on left'}
            type="button"
          >
            {navPosition === 'left' ? <DockTopIcon /> : <DockLeftIcon />}
          </button>
          {/* Maximize — collapses the panel's own session strip for more terminal
              space. The global dashboard header (+ NEW, tabs) always stays pinned. */}
          <button
            className={`${styles.displayModeToggle}${maximized ? ` ${styles.roomFilterActive}` : ''}`}
            onClick={toggleMaximized}
            title={maximized ? 'Restore session strip (Esc)' : 'Maximize — hide session strip for more space'}
            aria-label={maximized ? 'Restore session strip' : 'Maximize'}
            type="button"
          >
            {maximized ? <RestoreSizeIcon /> : <MaximizeIcon />}
          </button>
          {onClose && (
            <button
              className={styles.switcherIconBtn}
              onClick={onClose}
              title="Minimize"
              type="button"
            >
              &#x2012;
            </button>
          )}
        </div>
      </div>

      {/* ── Session tab strip ── (hidden when the panel is maximized) */}
      {!maximized && filteredSessions.length > 0 && (
        <div className={styles.sessionTabStrip}>
          {tabRenderItems.map((item) => {
            if (item.type === 'room') {
              return (
                <div
                  key={item.room.id}
                  className={styles.sessionTabRoomGroup}
                  style={{ '--room-color': item.color } as React.CSSProperties}
                  title={item.room.name}
                >
                  <span className={styles.sessionTabRoomGroupLabel}>{item.room.name}</span>
                  {item.sessions.map((s) => (
                    <SessionTabCard
                      key={s.sessionId}
                      session={s}
                      onSwitch={handleSwitch}
                      isCompact={isCompact}
                      index={sessionIndexMap.get(s.sessionId) ?? 0}
                      needsAttention={attentionIds.has(s.sessionId)}
                    />
                  ))}
                </div>
              );
            }
            return (
              <SessionTabCard
                key={item.session.sessionId}
                session={item.session}
                onSwitch={handleSwitch}
                isCompact={isCompact}
                index={sessionIndexMap.get(item.session.sessionId) ?? 0}
                needsAttention={attentionIds.has(item.session.sessionId)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function SessionTabCard({
  session,
  onSwitch,
  isCompact,
  index,
  needsAttention,
}: {
  session: Session;
  onSwitch: (id: string) => void;
  isCompact: boolean;
  index: number;
  needsAttention?: boolean;
}) {
  const color = STATUS_COLORS[session.status] ?? 'var(--text-dim)';
  const title = session.title || session.projectName || '(untitled)';
  const showProject = session.projectName && session.projectName !== session.title;
  const badge = getCliBadge(session);

  const handlePinClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useSessionStore.getState().togglePin(session.sessionId);
  }, [session.sessionId]);

  // ---- Inline rename state ----
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const beginEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(session.title || session.projectName || '');
    setEditing(true);
  }, [session.title, session.projectName]);

  const commitEdit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== session.title) {
      useSessionStore.getState().setSessionTitle(session.sessionId, trimmed);
    }
    setEditing(false);
  }, [draft, session.sessionId, session.title]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  return (
    <button
      className={`${styles.sessionTabCard}${isCompact ? ` ${styles.sessionTabCardCompact}` : ''}${needsAttention ? ` ${styles.sessionTabAttention}` : ''}`}
      data-status={session.status}
      style={{ '--robot-color': color } as React.CSSProperties}
      onClick={() => onSwitch(session.sessionId)}
      title={[title, session.projectName, session.status].filter(Boolean).join(' · ')}
      type="button"
    >
      {/* Pin icon */}
      <span
        className={`${styles.sessionTabPin}${session.pinned ? ` ${styles.pinned}` : ''}`}
        onClick={handlePinClick}
        title={session.pinned ? 'Unpin' : 'Pin'}
      >
        &#x1F4CC;
      </span>

      {/* Attention badge — finished work, needs review */}
      {needsAttention && (
        <span
          className={styles.sessionTabAttentionBadge}
          aria-label="Finished — needs attention"
          title="Finished — needs attention"
        >
          !
        </span>
      )}

      {!isCompact && (
        <>
          {/* Mini robot face */}
          <div className={styles.switcherMiniRobotFace}>
            <div className={styles.switcherMiniRobotEyes}>
              <div className={styles.switcherMiniRobotEye} />
              <div className={styles.switcherMiniRobotEye} />
            </div>
            <div className={styles.switcherMiniRobotMouth} />
          </div>
          {/* Status dot */}
          <div className={styles.switcherMiniRobotDot} />
        </>
      )}

      {/* Sequence badge */}
      {index > 0 && <span className={styles.sessionTabIndex}>{index}</span>}

      {/* Text info */}
      {editing ? (
        <input
          ref={inputRef}
          className={styles.sessionTabTitleInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitEdit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelEdit();
            }
          }}
          aria-label="Session title"
          maxLength={200}
        />
      ) : (
        <div
          className={styles.sessionTabTitle}
          onDoubleClick={beginEdit}
          title="Double-click to rename"
        >
          {title}
        </div>
      )}
      {!isCompact && showProject && (
        <div className={styles.sessionTabProject}>{session.projectName}</div>
      )}
      {!isCompact && badge && (
        <div className={styles.sessionTabBadge}>{badge}</div>
      )}
    </button>
  );
}

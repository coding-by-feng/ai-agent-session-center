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
import { useLabelStore } from '@/stores/labelStore';
import { useDropdownFlipX } from '@/hooks/useDropdownFlipX';
import { sortSessionsByActivity } from '@/lib/sessionSort';
import LabelPicker, { LabelChip } from './LabelPicker';
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

/** Shared SVG props for the stroked status glyphs — hoisted to module scope so
 *  it isn't re-allocated on every card render. */
const GLYPH_PROPS = {
  width: 10,
  height: 10,
  viewBox: '0 0 14 14',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/**
 * Distinct glyph per session status so completed / approval / input / working
 * etc. are tellable apart at a glance — not by colour alone (waiting and
 * prompting even share cyan, and accent colours repeat across themes). The
 * glyph inherits the badge colour via `currentColor`.
 *
 * The status→glyph mapping is backend-agnostic: status is derived identically
 * for Claude and Codex (same hook events → same status in sessionStore), so a
 * Codex session and a Claude session in the same real-world state show the
 * same icon.
 */
function StatusGlyph({ status }: { status: string }) {
  switch (status) {
    case 'waiting': // completed — finished its turn, ready for review
      return <svg {...GLYPH_PROPS}><polyline points="3,7.4 6,10.2 11,4.2" /></svg>;
    case 'approval': // needs you to approve a tool — "!"
      return (
        <svg {...GLYPH_PROPS}>
          <line x1="7" y1="2.8" x2="7" y2="8.4" />
          <circle cx="7" cy="11" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'input': // needs you to answer a question — "?"
      return (
        <svg {...GLYPH_PROPS}>
          <path d="M4.9 4.7a2.1 2.1 0 1 1 3.5 1.7c-.9.8-1.4 1.1-1.4 2.1" />
          <circle cx="7" cy="11" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'working': // tool running — spinner
      return (
        <svg {...GLYPH_PROPS}>
          <path d="M12 7a5 5 0 1 1-1.6-3.7" />
          <polyline points="11.9,1.7 11.9,4 9.6,4" />
        </svg>
      );
    case 'prompting': // prompt submitted — up arrow
      return (
        <svg {...GLYPH_PROPS}>
          <line x1="7" y1="11.2" x2="7" y2="3.3" />
          <polyline points="3.9,6.4 7,3.3 10.1,6.4" />
        </svg>
      );
    case 'ended': // disconnected — ✕
      return (
        <svg {...GLYPH_PROPS}>
          <line x1="3.9" y1="3.9" x2="10.1" y2="10.1" />
          <line x1="10.1" y1="3.9" x2="3.9" y2="10.1" />
        </svg>
      );
    case 'connecting': // handshaking — ellipsis
      return (
        <svg width="10" height="10" viewBox="0 0 14 14" fill="currentColor">
          <circle cx="3.3" cy="7" r="1.05" />
          <circle cx="7" cy="7" r="1.05" />
          <circle cx="10.7" cy="7" r="1.05" />
        </svg>
      );
    case 'idle': // available, doing nothing — pause bars
    default:
      return (
        <svg {...GLYPH_PROPS}>
          <line x1="5.2" y1="3.8" x2="5.2" y2="10.2" />
          <line x1="8.8" y1="3.8" x2="8.8" y2="10.2" />
        </svg>
      );
  }
}

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
    <svg width="13" height="13" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
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

/** Tag icon — opens the label picker for the current session */
function TagIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M1.5 1.5h4l5 5-4 4-5-5v-4Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <circle cx="3.6" cy="3.6" r="0.8" fill="currentColor" />
    </svg>
  );
}

/** Skull glyph — "kill all sessions in this room". Unambiguously destructive;
 *  rendered dim and turned red on hover by `.roomKillToggle`. */
function KillRoomIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {/* cranium + jaw */}
      <path
        d="M8 1.6c-3 0-5 2-5 4.7 0 1.6.8 2.7 1.7 3.3v1.5c0 .5.4.9.9.9h4.8c.5 0 .9-.4.9-.9v-1.5c.9-.6 1.7-1.7 1.7-3.3 0-2.7-2-4.7-5-4.7Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* eye sockets */}
      <circle cx="6" cy="6.4" r="1.2" fill="currentColor" />
      <circle cx="10" cy="6.4" r="1.2" fill="currentColor" />
      {/* nasal cavity */}
      <path d="M8 8.1l-.7 1.3h1.4L8 8.1Z" fill="currentColor" />
      {/* teeth */}
      <path d="M6.2 12v1.4M8 12v1.4M9.8 12v1.4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

/** Note glyph — the entry point for the progress remark. A lined page, distinct
 *  from the pencil (rename) and tag (label) it sits beside. */
function NoteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M2.5 1.5h7v9h-7v-9Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path
        d="M4.2 4h3.6M4.2 6h3.6M4.2 8h2.2"
        stroke="currentColor"
        strokeWidth="1.1"
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

/** Descending bars + down arrow — toggles the flat "most recently active first"
 *  ordering (rooms off) */
function SortByActivityIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M1 3.5H8M1 7H6M1 10.5H4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M11 2.5V11M9.2 9.2L11 11L12.8 9.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

/** Double-chevron-left icon — fold the left session rail to a thin strip */
function CollapseRailIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polyline points="8 3 4 7 8 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="11.5 3 7.5 7 11.5 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Double-chevron-right icon — unfold the collapsed left session rail */
function ExpandRailIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polyline points="6 3 10 7 6 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="2.5 3 6.5 7 2.5 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
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
  const navRailCollapsed = useUiStore((s) => s.navRailCollapsed);
  const toggleNavRailCollapsed = useUiStore((s) => s.toggleNavRailCollapsed);
  const sessionSortMode = useUiStore((s) => s.sessionSortMode);
  const toggleSessionSortMode = useUiStore((s) => s.toggleSessionSortMode);
  const openRoomKill = useUiStore((s) => s.openRoomKill);
  const sortByActivity = sessionSortMode === 'activity';
  // Vertical rail only when docked-left AND not maximized
  // (maximizing always collapses the nav to the slim top bar).
  const isVertical = navPosition === 'left' && !maximized;
  // Folded-to-a-sliver state only applies to the left rail.
  const isRailCollapsed = isVertical && navRailCollapsed;
  const rooms = useRoomStore((s) => s.rooms);
  const toggleRoomCollapse = useRoomStore((s) => s.toggleCollapse);

  const selectedRoomIds = useUiStore((s) => s.selectedRoomIds);
  const toggleRoomFilter = useUiStore((s) => s.toggleRoomFilter);
  const clearRoomFilter = useUiStore((s) => s.clearRoomFilter);
  const [roomDropdownOpen, setRoomDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Menu element (inside the wrap) — measured to keep it inside the viewport.
  const roomMenuRef = useRef<HTMLDivElement>(null);
  useDropdownFlipX(roomDropdownOpen, roomMenuRef);

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
  const legendMenuRef = useRef<HTMLDivElement>(null);
  useDropdownFlipX(legendOpen, legendMenuRef);
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
  //
  // `lastActivityAt` is only part of the signature in activity-sort mode: it
  // ticks on every hook event, so including it always would defeat the gating
  // above — but leaving it out in activity mode would freeze the list, since
  // nothing else changes when a session merely stays busy.
  const sessionsSignature = useMemo(() => {
    const parts: string[] = [];
    sessions.forEach((s) => {
      const activity = sortByActivity ? `|${s.lastActivityAt ?? 0}` : '';
      parts.push(`${s.sessionId}|${s.status}|${s.pinned ? 1 : 0}|${s.title ?? ''}|${s.projectName ?? ''}|${s.colorIndex ?? ''}|${s.accentColor ?? ''}|${s.terminalId ?? ''}${activity}`);
    });
    parts.sort();
    return parts.join('\n');
  }, [sessions, sortByActivity]);

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
    // The index map is always built from the status ordering above, never from
    // the activity ordering: these numbers are the session's identity in the
    // strip (and in keyboard switching), so flat mode must reorder rows without
    // renumbering them.
    const indexMap = new Map<string, number>();
    let curIdx = -1;
    allActive.forEach((s, i) => {
      indexMap.set(s.sessionId, i + 1);
      if (s.sessionId === currentSession.sessionId) curIdx = i + 1;
    });
    const others = allActive.filter((s) => s.sessionId !== currentSession.sessionId);
    return {
      sortedSessions: sortByActivity ? sortSessionsByActivity(others) : others,
      sessionIndexMap: indexMap,
      currentIndex: curIdx,
    };
    // `sessionsSignature` covers field changes; `sessions` ref is intentionally
    // excluded so unchanged-content re-renders skip the sort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsSignature, currentSession.sessionId, sortByActivity]);

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
  //
  // Activity-sort mode skips grouping entirely: room frames would fight the
  // ordering, since a room can only sit in one place while its sessions belong
  // all over a recency-ranked list.
  const tabRenderItems = useMemo((): TabRenderItem[] => {
    if (sortByActivity) {
      return filteredSessions.map((session) => ({ type: 'session', session }));
    }

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
  }, [filteredSessions, rooms, sortByActivity]);

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

  // ---- Progress remark (inline, under the title) ----
  const [remarkEditing, setRemarkEditing] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState('');
  const remarkInputRef = useRef<HTMLInputElement | null>(null);
  const currentRemark = currentSession.remark ?? '';

  const beginRemarkEdit = useCallback(() => {
    setRemarkDraft(currentSession.remark ?? '');
    setRemarkEditing(true);
  }, [currentSession.remark]);

  const commitRemarkEdit = useCallback(() => {
    // No trimmed-truthy guard: clearing the remark is a legitimate edit.
    useSessionStore.getState().setSessionRemark(currentSession.sessionId, remarkDraft);
    setRemarkEditing(false);
  }, [remarkDraft, currentSession.sessionId]);

  const cancelRemarkEdit = useCallback(() => {
    setRemarkEditing(false);
  }, []);

  // Note-icon toggle. Closing this way SAVES (same as clicking away) rather than
  // discarding — Esc is the only discard path, so a user who types and reaches
  // for the icon to "finish" cannot silently lose the text.
  //
  // The button suppresses mousedown (see `onMouseDown` at the call site) so the
  // open input never blurs. Without that, blur→commit would flip `remarkEditing`
  // to false BEFORE this click ran, and the toggle would immediately re-open the
  // editor it was meant to close.
  const toggleRemarkEdit = useCallback(() => {
    if (remarkEditing) commitRemarkEdit();
    else beginRemarkEdit();
  }, [remarkEditing, commitRemarkEdit, beginRemarkEdit]);

  useEffect(() => {
    if (remarkEditing && remarkInputRef.current) {
      remarkInputRef.current.focus();
      remarkInputRef.current.select();
    }
  }, [remarkEditing]);

  // Abandon an open editor when the user switches session — otherwise the draft
  // for session A would commit onto session B.
  useEffect(() => {
    setRemarkEditing(false);
  }, [currentSession.sessionId]);

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

  // ---- Label picker (client-only session labels) ----
  const currentLabel = useLabelStore((s) => s.labels[currentSession.sessionId]);
  const labelColor = useLabelStore((s) => s.labelColor);
  const [labelAnchor, setLabelAnchor] = useState<{ x: number; y: number } | null>(null);

  const openLabelPicker = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setLabelAnchor({ x: rect.left, y: rect.bottom });
  }, []);

  const closeLabelPicker = useCallback(() => setLabelAnchor(null), []);

  // Close the picker if the user switches sessions while it is open.
  useEffect(() => {
    setLabelAnchor(null);
  }, [currentSession.sessionId]);

  // ── Folded left rail: a thin strip with just the expand affordance + count ──
  if (isRailCollapsed) {
    const activeCount = activeSessionIds.size;
    return (
      <div className={`${styles.switcherBar} ${styles.switcherBarVertical} ${styles.switcherBarCollapsed}`}>
        <button
          type="button"
          className={styles.displayModeToggle}
          onClick={toggleNavRailCollapsed}
          title="Expand session panel"
          aria-label="Expand session panel"
        >
          <ExpandRailIcon />
        </button>
        {activeCount > 0 && (
          <span
            className={styles.railCollapsedCount}
            title={`${activeCount} active session${activeCount === 1 ? '' : 's'}`}
            aria-label={`${activeCount} active session${activeCount === 1 ? '' : 's'}`}
          >
            {activeCount}
          </span>
        )}
      </div>
    );
  }

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
              <button
                type="button"
                className={`${styles.switcherEditHint}${labelAnchor ? ` ${styles.switcherHintActive}` : ''}`}
                onClick={openLabelPicker}
                // The parent .switcherName renames on double-click. `dblclick`
                // is a separate bubbling event that stopPropagation on `click`
                // does NOT stop — without this, double-clicking this icon (whose
                // click does NOT rename) still opens the rename editor.
                onDoubleClick={(e) => e.stopPropagation()}
                title={currentLabel ? `Label: ${currentLabel}` : 'Add label'}
                aria-label="Set session label"
              >
                <TagIcon />
              </button>
              {/* Remark entry point. Stays lit whenever this session carries a
                  remark, so the bar shows at a glance that a note exists even
                  while the row below is scrolled/ellipsized. */}
              <button
                type="button"
                className={`${styles.switcherEditHint}${remarkEditing || currentRemark ? ` ${styles.switcherHintActive}` : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={toggleRemarkEdit}
                // See the tag button: block the parent's double-click-to-rename
                // so a double-click here can't overwrite the session title.
                onDoubleClick={(e) => e.stopPropagation()}
                title={currentRemark ? `Remark: ${currentRemark}` : 'Add a remark'}
                aria-label={currentRemark ? `Edit session remark: ${currentRemark}` : 'Add a session remark'}
                aria-expanded={remarkEditing}
              >
                <NoteIcon />
              </button>
            </span>
          )}
          {currentLabel && (
            <LabelChip name={currentLabel} color={labelColor(currentLabel)} />
          )}
          {secondaryName && (
            <span className={styles.switcherProject}>{secondaryName}</span>
          )}
        </div>

        {/* ── Progress remark — under the title, above the controls ──
            Rendered only when there is something to show: an existing remark, or
            an open editor. The empty state lives in the note icon above instead
            of a placeholder row, so the 38px bar never grows a second line for
            the sessions (most of them) that carry no remark. `flex-basis:100%`
            gives it its own line in the top bar; the rail stacks it naturally. */}
        {remarkEditing ? (
          <input
            ref={remarkInputRef}
            className={styles.switcherRemarkInput}
            value={remarkDraft}
            onChange={(e) => setRemarkDraft(e.target.value)}
            onBlur={commitRemarkEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRemarkEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelRemarkEdit();
              }
            }}
            placeholder="What's happening in this session?"
            aria-label="Session remark"
            maxLength={200}
          />
        ) : currentRemark ? (
          <button
            type="button"
            className={styles.switcherRemark}
            onClick={beginRemarkEdit}
            title={currentRemark}
            aria-label={`Remark: ${currentRemark}. Click to edit.`}
          >
            {currentRemark}
          </button>
        ) : null}

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
                <div className={styles.roomFilterDropdown} ref={roomMenuRef}>
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

          {/* Sort by recent activity — flattens the room frames into a single
              list, most recently active first */}
          <button
            className={`${styles.displayModeToggle}${sortByActivity ? ` ${styles.roomFilterActive}` : ''}`}
            onClick={toggleSessionSortMode}
            title={sortByActivity ? 'Group by room' : 'Sort by recent activity (flat list)'}
            aria-label={sortByActivity ? 'Group by room' : 'Sort by recent activity'}
            type="button"
          >
            <SortByActivityIcon />
          </button>

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
              <div
                className={styles.statusLegendDropdown}
                ref={legendMenuRef}
                role="group"
                aria-label="Session status colours"
              >
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
          {/* Fold — collapse the left rail to a thin strip (left dock only).
              In top-dock mode there's no rail to fold, so it's hidden. */}
          {isVertical && (
            <button
              className={styles.displayModeToggle}
              onClick={toggleNavRailCollapsed}
              title="Collapse session panel"
              aria-label="Collapse session panel"
              type="button"
            >
              <CollapseRailIcon />
            </button>
          )}
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

      {labelAnchor && (
        <LabelPicker
          sessionId={currentSession.sessionId}
          anchor={labelAnchor}
          onClose={closeLabelPicker}
        />
      )}

      {/* ── Session tab strip ── (hidden when the panel is maximized) */}
      {!maximized && filteredSessions.length > 0 && (
        <div className={styles.sessionTabStrip}>
          {tabRenderItems.map((item) => {
            if (item.type === 'room') {
              const collapsed = item.room.collapsed;
              // Live (killable) sessions in this room, independent of the room
              // filter — ended cards and dropped ids don't count. The kill icon
              // is hidden when there's nothing to kill.
              const roomLiveCount = item.room.sessionIds.reduce((n, id) => {
                const s = sessions.get(id);
                return s && s.status !== 'ended' ? n + 1 : n;
              }, 0);
              return (
                <div
                  key={item.room.id}
                  className={`${styles.sessionTabRoomGroup}${collapsed ? ` ${styles.sessionTabRoomGroupCollapsed}` : ''}`}
                  style={{ '--room-color': item.color } as React.CSSProperties}
                  title={item.room.name}
                >
                  <span className={styles.sessionTabRoomGroupLabel}>{item.room.name}</span>
                  <button
                    type="button"
                    className={styles.roomCollapseToggle}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRoomCollapse(item.room.id);
                    }}
                    title={collapsed ? `Expand ${item.room.name}` : `Collapse ${item.room.name}`}
                    aria-label={collapsed ? `Expand room ${item.room.name}` : `Collapse room ${item.room.name}`}
                    aria-expanded={!collapsed}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s ease' }}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  {roomLiveCount > 0 && (
                    <button
                      type="button"
                      className={styles.roomKillToggle}
                      onClick={(e) => {
                        e.stopPropagation();
                        openRoomKill(item.room.id);
                      }}
                      title={`Kill all ${roomLiveCount} session${roomLiveCount === 1 ? '' : 's'} in ${item.room.name}`}
                      aria-label={`Kill all ${roomLiveCount} session${roomLiveCount === 1 ? '' : 's'} in room ${item.room.name}`}
                    >
                      <KillRoomIcon />
                    </button>
                  )}
                  {collapsed ? (
                    <span className={styles.roomCollapsedCount}>{item.sessions.length}</span>
                  ) : (
                    item.sessions.map((s) => (
                      <SessionTabCard
                        key={s.sessionId}
                        session={s}
                        onSwitch={handleSwitch}
                        isCompact={isCompact}
                        index={sessionIndexMap.get(s.sessionId) ?? 0}
                        needsAttention={attentionIds.has(s.sessionId)}
                      />
                    ))
                  )}
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
  const statusTitle = STATUS_LEGEND.find((s) => s.status === session.status)?.label ?? session.status;
  const title = session.title || session.projectName || '(untitled)';
  const showProject = session.projectName && session.projectName !== session.title;
  const badge = getCliBadge(session);
  const label = useLabelStore((s) => s.labels[session.sessionId]);
  const labelColor = useLabelStore((s) => s.labelColor);

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
      className={`${styles.sessionTabCard}${isCompact ? ` ${styles.sessionTabCardCompact}` : ''}`}
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

      {/* Top-right corner badge. When the session has just finished work it
          shows the green ✓ "completed" badge; otherwise it shows a distinct
          per-status glyph (approval "!", input "?", working spinner, etc.) so
          statuses are tellable apart by icon, not colour alone. */}
      {needsAttention ? (
        <span
          className={styles.sessionTabAttentionBadge}
          aria-label="Completed — ready for review"
          title="Completed — ready for review"
        >
          ✓
        </span>
      ) : (
        <span
          className={styles.sessionTabStatusBadge}
          aria-label={statusTitle}
          title={statusTitle}
        >
          <StatusGlyph status={session.status} />
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
      {label && isCompact && (
        <span
          className={styles.sessionTabLabelDot}
          style={{ background: labelColor(label), boxShadow: `0 0 4px ${labelColor(label)}` }}
          title={`Label: ${label}`}
          aria-label={`Label: ${label}`}
        />
      )}
      {label && !isCompact && (
        <LabelChip name={label} color={labelColor(label)} small />
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

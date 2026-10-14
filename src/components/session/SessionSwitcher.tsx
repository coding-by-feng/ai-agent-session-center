/**
 * SessionSwitcher — bar at the top of the DetailPanel.
 * Top row: current session name + status badge + duration + display toggle + minimize button
 *          + the new-session / recent-directories icons (the app's only launchers while a session exists).
 * Below: always-visible horizontal tab strip showing all other active sessions
 *        as mini robot cards (icon + title + project name + label).
 */
import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useLabelStore } from '@/stores/labelStore';
import { useQueueStore } from '@/stores/queueStore';
import { useRoomDragReorder } from '@/hooks/useRoomDragReorder';
import type { RoomDragRect } from '@/lib/roomDragReorder';
import { sortSessionsByActivity, numberedSessions } from '@/lib/sessionSort';
import { pickRecentSessions, RECENT_TICK_MS, RECENT_WINDOW_MS } from '@/lib/recentSessions';
import { groupSessionsByProject, type ProjectGroup } from '@/lib/projectGroups';
import { ROOM_COLOR_PALETTE, roomColor } from '@/lib/roomColor';
import LabelPicker, { LabelChip } from './LabelPicker';
import PlanUsageChip from './PlanUsageChip';
import SessionRuntimeChip from './SessionRuntimeChip';
import { resolveRuntimeDisplay } from '@/lib/sessionRuntime';
import ProjectFrameHeader from './ProjectFrameHeader';
import SessionViewMenu from './SessionViewMenu';
import { FrameCollapseIcon } from './SessionFrameIcons';
import DetachIcon from '@/components/ui/DetachIcon';
import IconButton from '@/components/ui/IconButton';
import {
  CollapseRailIcon,
  EditIcon,
  ExpandRailIcon,
  MinimizeIcon,
  MoveRoomDownIcon,
  MoveRoomUpIcon,
  NewSessionIcon,
  NoteIcon,
  PinIcon,
  QueueBadgeIcon,
  RoomDragHandleIcon,
  SkullIcon,
  TagIcon,
} from '@/components/ui/icons';
import { KILL_MODAL_ID } from './KillConfirmModal';
import { useShortcutStore } from '@/stores/shortcutStore';
import { keyComboToString } from '@/lib/shortcutKeys';
import buttonStyles from '@/styles/modules/Button.module.css';
import chipStyles from '@/styles/modules/Chip.module.css';
import Tooltip from '@/components/ui/Tooltip';
import { tooltips } from '@/lib/tooltips';
import { justCompleted, completionStillApplies } from '@/lib/sessionAttention';
import { STATUS_COLORS, STATUS_LEGEND } from '@/lib/sessionStatusStyle';
import StatusGlyph from './StatusGlyph';
import StatusBadge from './StatusBadge';
import WorkdirLauncher from '@/components/layout/WorkdirLauncher';
import { isPopoutWindow } from '@/lib/windowRole';
import styles from '@/styles/modules/DetailPanel.module.css';

type TabRenderItem =
  | { type: 'session'; session: Session }
  | { type: 'room'; room: Room; sessions: Session[]; color: string }
  // The built-in RECENT frame. Not a Room: nothing stores it, and it is not
  // part of room reordering (visibleRoomIds keeps only type 'room').
  | { type: 'recent'; sessions: Session[] }
  // One project's frame (Projects view). Worked out from the sessions' paths,
  // so, like RECENT, it is not a Room and takes no part in room reordering.
  | { type: 'project'; group: ProjectGroup; color: string };

const RECENT_FRAME_KEY = 'builtin:recent';
const RECENT_FRAME_TITLE =
  `Recent: sessions with activity in the last ${RECENT_WINDOW_MS / 60_000} min. Each is also listed in its own room.`;

/** Detect CLI tool from session command */
function getCliBadge(session: Session): string | null {
  const cmd = (session.sshCommand || session.sshConfig?.command || '').toLowerCase();
  if (cmd.startsWith('claude') || cmd.includes('/claude')) return 'CLAUDE';
  if (cmd.startsWith('codex') || cmd.includes('/codex')) return 'CODEX';
  if (cmd.startsWith('aider') || cmd.includes('/aider')) return 'AIDER';
  if (session.backendType) {
    const bt = session.backendType.toLowerCase();
    if (bt.includes('claude')) return 'CLAUDE';
    if (bt.includes('codex')) return 'CODEX';
    if (bt.includes('aider')) return 'AIDER';
  }
  return null;
}

/** The recent-directories trigger is drawn as the row's IconButtons (WorkdirLauncher
 *  renders its own button, so it takes the kit's classes). Open = the pressed look,
 *  from the kit's `[aria-expanded='true']` rule. */
const dirsTriggerClass = (): string => `${buttonStyles.iconButton} ${buttonStyles.iconSm}`;

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
      if (justCompleted(prev, s.status)) {
        // Don't mark the currently selected session
        if (s.sessionId !== currentSession.sessionId) {
          next.add(s.sessionId);
          changed = true;
        }
      }
      // The ✓ outranks the status glyph on the card, so it must not outlive the completion:
      // a session that is busy again, needs approval, is resuming or has ended shows that
      // instead — without waiting for a click. (`idle` keeps it: see sessionAttention.ts.)
      if (next.has(s.sessionId) && !completionStillApplies(s.status)) {
        next.delete(s.sessionId);
        changed = true;
      }
      prevStatusRef.current.set(s.sessionId, s.status);
    });
    // A session that has left the store takes its flag and its remembered status with it, so it
    // cannot come back later (a restore, a resume under the same id) wearing a stale ✓.
    for (const id of [...next]) {
      if (!sessions.has(id)) {
        next.delete(id);
        changed = true;
      }
    }
    for (const id of [...prevStatusRef.current.keys()]) {
      if (!sessions.has(id)) prevStatusRef.current.delete(id);
    }
    // Viewing a session acknowledges its completion. The strip click path
    // clears it in handleSwitch, but a session can also become current via
    // the sidebar, Cmd+N or Cmd+E — and since the current session is listed
    // too, its stale ✓ would otherwise sit on the current card.
    if (next.delete(currentSession.sessionId)) changed = true;
    if (changed) setAttentionIds(next);
  }, [sessions, currentSession.sessionId, attentionIds]);

  const handleSwitch = useCallback((id: string) => {
    // The current session is listed too. Re-selecting it would record it as
    // its own "previous session" (selectSession stores the outgoing id), which
    // silently breaks the switch-to-previous shortcut — so it is a no-op.
    if (id === currentSession.sessionId) return;
    setAttentionIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    onSwitch(id);
  }, [onSwitch, currentSession.sessionId]);
  const cardDisplayMode = useUiStore((s) => s.cardDisplayMode);
  const toggleCardDisplayMode = useUiStore((s) => s.toggleCardDisplayMode);
  const navPosition = useUiStore((s) => s.navPosition);
  const toggleNavPosition = useUiStore((s) => s.toggleNavPosition);
  const maximized = useUiStore((s) => s.maximized);
  const toggleMaximized = useUiStore((s) => s.toggleMaximized);
  const navRailCollapsed = useUiStore((s) => s.navRailCollapsed);
  const toggleNavRailCollapsed = useUiStore((s) => s.toggleNavRailCollapsed);
  const sessionSortMode = useUiStore((s) => s.sessionSortMode);
  const setSessionSortMode = useUiStore((s) => s.setSessionSortMode);
  const collapsedProjects = useUiStore((s) => s.collapsedProjects);
  const toggleProjectCollapsed = useUiStore((s) => s.toggleProjectCollapsed);
  const recentRoomCollapsed = useUiStore((s) => s.recentRoomCollapsed);
  const toggleRecentRoomCollapsed = useUiStore((s) => s.toggleRecentRoomCollapsed);
  const openRoomKill = useUiStore((s) => s.openRoomKill);
  const openModal = useUiStore((s) => s.openModal);
  const sortByActivity = sessionSortMode === 'activity';
  const projectView = sessionSortMode === 'project';
  // Vertical rail only when docked-left AND not maximized
  // (maximizing always collapses the nav to the slim top bar).
  const isVertical = navPosition === 'left' && !maximized;
  // Folded-to-a-sliver state only applies to the left rail.
  const isRailCollapsed = isVertical && navRailCollapsed;
  const rooms = useRoomStore((s) => s.rooms);
  const toggleRoomCollapse = useRoomStore((s) => s.toggleCollapse);
  const setRoomListOrder = useRoomStore((s) => s.setListOrder);

  const selectedRoomIds = useUiStore((s) => s.selectedRoomIds);
  const toggleRoomFilter = useUiStore((s) => s.toggleRoomFilter);
  const clearRoomFilter = useUiStore((s) => s.clearRoomFilter);
  // The room filter, the view switch, the status legend, density, dock and
  // maximize live in one labelled View menu (SessionViewMenu, AASC-11).

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
      // projectPath and sshHost are what the Projects view groups by; a session
      // whose directory changes (an SSH session follows its hook's cwd) has to
      // move frames without waiting for some other field to change.
      parts.push(`${s.sessionId}|${s.status}|${s.pinned ? 1 : 0}|${s.title ?? ''}|${s.projectName ?? ''}|${s.projectPath ?? ''}|${s.sshHost ?? ''}|${s.colorIndex ?? ''}|${s.accentColor ?? ''}|${s.terminalId ?? ''}${activity}`);
    });
    parts.sort();
    return parts.join('\n');
  }, [sessions, sortByActivity]);

  // Build the globally indexed session list (all active, sorted). The current
  // session stays IN it: dropping it (the strip began as a "switch to another
  // session" list) also removed any room whose only session was the current
  // one, so the room you were working in vanished from the rail.
  const { sortedSessions, sessionIndexMap, currentIndex } = useMemo(() => {
    // The badge numbers. numberedSessions is shared with Alt+⌘+1…9 and the
    // "go to session #" box, so a number typed is the number shown here.
    const allActive = numberedSessions(sessions.values());
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
    return {
      sortedSessions: sortByActivity ? sortSessionsByActivity(allActive) : allActive,
      sessionIndexMap: indexMap,
      currentIndex: curIdx,
    };
    // `sessionsSignature` covers field changes; `sessions` ref is intentionally
    // excluded so unchanged-content re-renders skip the sort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsSignature, currentSession.sessionId, sortByActivity]);

  // How to get back here from the keyboard: the user's own binding for "Switch to
  // session N" (1–9), else "Go to session by number". A string, so the selector is stable.
  const jumpHint = useShortcutStore((st) => {
    const id = currentIndex >= 1 && currentIndex <= 9 ? `switchSession${currentIndex}` : 'jumpToSession';
    const combo = st.bindings.find((b) => b.actionId === id)?.combo ?? null;
    if (!combo) return 'The number its card carries in the list';
    return currentIndex <= 9
      ? `${keyComboToString(combo)} switches here`
      : `${keyComboToString(combo)}, then ${currentIndex}, switches here`;
  });

  // ---- Built-in RECENT frame (Rooms view only: each session is also listed in its own room) ----
  // Membership depends on the clock as well as on updates: a session leaves
  // RECENT when it has been quiet for the whole window, and no update arrives
  // to say so. The tick re-checks once a minute.
  const [recentNow, setRecentNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setRecentNow(Date.now()), RECENT_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // The RECENT ids in order, as one string. It is rebuilt from the fresh
  // `sessions` on every update and tick, but it only changes when a session
  // joins, leaves or moves, so everything downstream stays put otherwise.
  const recentIdsKey = useMemo(() => {
    if (sessionSortMode !== 'room') return '';
    const live = [...sessions.values()].filter((s) => s.status !== 'ended');
    return pickRecentSessions(live, recentNow).map((s) => s.sessionId).join('\n');
  }, [sessions, sessionSortMode, recentNow]);

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

  // Apply the room filter to the tab strip. It treats the current session's
  // card like any other; the header above the strip always shows it.
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
  //
  // The Projects view swaps the room frames for one frame per project
  // directory. Rooms play no part in it (no room frames, no RECENT), though the
  // room filter still narrows `filteredSessions` first. A session with no
  // project path follows the frames as a plain card, like a room-less one does.
  const tabRenderItems = useMemo((): TabRenderItem[] => {
    if (sortByActivity) {
      return filteredSessions.map((session) => ({ type: 'session', session }));
    }

    if (projectView) {
      // Colours are resolved among ALL the strip's projects (`sortedSessions`), not only the ones the
      // room filter lets through: otherwise filtering recolours projects that did not change.
      const { groups, ungrouped } = groupSessionsByProject(
        filteredSessions,
        ROOM_COLOR_PALETTE.length,
        sortedSessions,
      );
      return [
        ...groups.map((group): TabRenderItem => ({ type: 'project', group, color: ROOM_COLOR_PALETTE[group.colorIndex] })),
        ...ungrouped.map((session): TabRenderItem => ({ type: 'session', session })),
      ];
    }

    const sessionToRoom = new Map<string, Room>();
    for (const room of rooms) {
      for (const sid of room.sessionIds) {
        sessionToRoom.set(sid, room);
      }
    }

    const items: TabRenderItem[] = [];

    // RECENT goes first. Its sessions also stay in their own rooms below, and
    // it takes them from filteredSessions, so the room filter narrows it too.
    if (recentIdsKey) {
      const shown = new Map(filteredSessions.map((s) => [s.sessionId, s]));
      const recent = recentIdsKey.split('\n').flatMap((id) => {
        const s = shown.get(id);
        return s ? [s] : [];
      });
      if (recent.length > 0) items.push({ type: 'recent', sessions: recent });
    }

    // listOrder is the LIST's own order, independent of roomIndex (the 3D
    // scene's world-space room slot — reordering here must never touch that,
    // see Room.roomIndex's own comment). Falling back to roomIndex, then
    // array order, means existing rooms keep today's visible order until the
    // user actually drags/clicks a room for the first time.
    const orderedRooms = [...rooms].sort(
      (a, b) =>
        (a.listOrder ?? a.roomIndex ?? Number.MAX_SAFE_INTEGER) -
        (b.listOrder ?? b.roomIndex ?? Number.MAX_SAFE_INTEGER),
    );

    for (const room of orderedRooms) {
      const roomSessions = filteredSessions.filter((s) =>
        room.sessionIds.includes(s.sessionId),
      );
      if (roomSessions.length === 0) continue;
      items.push({ type: 'room', room, sessions: roomSessions, color: roomColor(room) });
    }

    for (const session of filteredSessions) {
      if (sessionToRoom.has(session.sessionId)) continue;
      items.push({ type: 'session', session });
    }

    return items;
  }, [filteredSessions, sortedSessions, rooms, sortByActivity, projectView, recentIdsKey]);

  // ---- Room reorder (drag + ▲/▼) — writes ONLY listOrder, never roomIndex ----
  // Scoped to rooms that actually render a frame right now (a room with no
  // sessions passing the active filter has nothing to grab or drop onto) —
  // "adjacent" must mean visually adjacent, not adjacent in the full rooms
  // array, or a click on ▼ could jump over an invisible room with no
  // observable effect.
  const visibleRoomIds = useMemo(
    () => tabRenderItems.filter((i) => i.type === 'room').map((i) => i.room.id),
    [tabRenderItems],
  );

  const roomElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const registerRoomEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) roomElsRef.current.set(id, el);
    else roomElsRef.current.delete(id);
  }, []);
  const getRoomDragRects = useCallback((): RoomDragRect[] => {
    const out: RoomDragRect[] = [];
    for (const id of visibleRoomIds) {
      const el = roomElsRef.current.get(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      out.push({ id, top: r.top, bottom: r.bottom });
    }
    return out;
  }, [visibleRoomIds]);

  /** Stamp a dense 0..N-1 listOrder across every visible room in `nextIds`'
   *  order. Re-normalizing on every commit (not just patching the two that
   *  moved) means a room's listOrder never depends on a borrowed roomIndex or
   *  MAX_SAFE_INTEGER value from before its first-ever reorder. */
  const commitRoomOrder = useCallback((nextIds: string[]) => {
    nextIds.forEach((id, i) => setRoomListOrder(id, i));
  }, [setRoomListOrder]);

  // The frame the hook writes the carry offset onto and settles on drop.
  const getRoomEl = useCallback((id: string) => roomElsRef.current.get(id), []);

  const roomDrag = useRoomDragReorder(visibleRoomIds, getRoomDragRects, commitRoomOrder, getRoomEl);

  const moveRoom = useCallback((roomId: string, direction: -1 | 1) => {
    const idx = visibleRoomIds.indexOf(roomId);
    const swapIdx = idx + direction;
    if (idx === -1 || swapIdx < 0 || swapIdx >= visibleRoomIds.length) return;
    const next = [...visibleRoomIds];
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    commitRoomOrder(next);
  }, [visibleRoomIds, commitRoomOrder]);

  const toggleRoom = useCallback((roomId: string) => {
    toggleRoomFilter(roomId);
  }, [toggleRoomFilter]);

  const primaryName = currentSession.title || currentSession.projectName || '(untitled)';
  const secondaryName = currentSession.title && currentSession.projectName && currentSession.title !== currentSession.projectName
    ? currentSession.projectName
    : null;
  const pinCopy = currentSession.pinned ? tooltips.sessionUnpin : tooltips.sessionPin;
  const hasRuntimeChip = resolveRuntimeDisplay(currentSession) !== null;
  const isCompact = cardDisplayMode === 'compact';

  // ---- Inline rename for the header title (currentSession) ----
  const [headerEditing, setHeaderEditing] = useState(false);
  const [headerDraft, setHeaderDraft] = useState(primaryName);
  const headerInputRef = useRef<HTMLInputElement | null>(null);

  /** What the rename box was pre-filled with. An untitled session pre-fills
   *  its project name, and saving that untouched would be a manual rename —
   *  which permanently suppresses the automatic title from the first prompt.
   *  So only text the user actually changed is ever saved. */
  const headerEditFrom = useRef('');

  const beginHeaderEdit = useCallback(() => {
    const initial = currentSession.title || currentSession.projectName || '';
    headerEditFrom.current = initial.trim();
    setHeaderDraft(initial);
    setHeaderEditing(true);
  }, [currentSession.title, currentSession.projectName]);

  const commitHeaderEdit = useCallback(() => {
    const trimmed = headerDraft.trim();
    if (trimmed && trimmed !== headerEditFrom.current && trimmed !== currentSession.title) {
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

  // Same togglePin action the other-session tab cards below (their own
  // handlePinClick) and RobotListSidebar already use — one shared session.pinned.
  const handleTogglePin = useCallback(() => {
    useSessionStore.getState().togglePin(currentSession.sessionId);
  }, [currentSession.sessionId]);

  // Pop the whole session out into its own native window. Electron only — the
  // same guard FloatingTerminalPanel uses for its own pop-out button.
  const canPopOutSession = typeof window !== 'undefined' && !!window.electronAPI?.openSessionWindow;
  const handleDetachSession = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const { sessionId, title } = currentSession;
    window.electronAPI
      ?.openSessionWindow?.({ sessionId, label: title || undefined })
      .catch(() => {
        /* ignore — session stays in-app */
      });
  }, [currentSession]);

  // Close the picker if the user switches sessions while it is open.
  useEffect(() => {
    setLabelAnchor(null);
  }, [currentSession.sessionId]);

  // ── Folded left rail: a thin strip with just the expand affordance + count ──
  if (isRailCollapsed) {
    const activeCount = activeSessionIds.size;
    return (
      <div className={`${styles.switcherBar} ${styles.switcherBarVertical} ${styles.switcherBarCollapsed}`}>
        <IconButton size="sm" label="Expand session panel" tooltipPlacement="right" onClick={toggleNavRailCollapsed}>
          <ExpandRailIcon />
        </IconButton>
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
          {/* The CLI's plan limits — first, so it is the top-left corner. Never in
              .switcherMeta below: that row's icon count is what the rail is sized for. */}
          <PlanUsageChip session={currentSession} />
          {/* The session's number — the badge its card carries, and what the switch
              shortcuts use. The status dot that sat beside it repeated the status
              badge below, so it is gone (AASC-11); the number now says what it is. */}
          {currentIndex > 0 && (
            <Tooltip label={`Session #${currentIndex}`} description={jumpHint} placement="bottom">
              <span className={styles.switcherIndex}>
                <span className={chipStyles.srOnly}>Session number </span>
                {currentIndex}
              </span>
            </Tooltip>
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
            <>
              <span
                className={styles.switcherName}
                onDoubleClick={beginHeaderEdit}
              >
                {/* title: the rail clamps a long name to two lines, so hover reads the rest. */}
                <span className={styles.switcherNameText} title={primaryName}>{primaryName}</span>
              </span>
              {/* The title's actions. A sibling of the name, not inside it: in the 213px
                  left rail five buttons beside the name squeezed it to "Exmouth …", so
                  there they take a row of their own under it (the top bar keeps them
                  inline). Being outside the name, a double-click on one can never reach
                  its rename handler. */}
              <span className={styles.switcherTitleActions}>
                {/* Pin leads: Edit/Tag/Note annotate the session, Pin changes its
                    lifecycle. The pinned state is in the glyph (filled), not only
                    in the button's fill. */}
                <IconButton
                  size="sm"
                  label={pinCopy.label}
                  description={pinCopy.description}
                  pressed={!!currentSession.pinned}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handleTogglePin}
                >
                  <PinIcon filled={!!currentSession.pinned} />
                </IconButton>
                <IconButton size="sm" label="Rename session" onClick={beginHeaderEdit}>
                  <EditIcon />
                </IconButton>
                <IconButton
                  size="sm"
                  label={currentLabel ? `Label: ${currentLabel}` : 'Add label'}
                  ariaLabel="Set session label"
                  aria-expanded={!!labelAnchor}
                  onClick={openLabelPicker}
                >
                  <TagIcon />
                </IconButton>
                {/* Remark entry point. Lit whenever the session carries a remark,
                    so the bar shows a note exists even while its row is ellipsized. */}
                <IconButton
                  size="sm"
                  label={currentRemark ? `Remark: ${currentRemark}` : 'Add a remark'}
                  ariaLabel={currentRemark ? `Edit session remark: ${currentRemark}` : 'Add a session remark'}
                  aria-expanded={remarkEditing}
                  className={currentRemark ? styles.titleActionLit : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={toggleRemarkEdit}
                >
                  <NoteIcon />
                </IconButton>
                {/* Pop the whole session into its own native window (Electron only:
                    window.electronAPI is undefined in a browser). */}
                {canPopOutSession && (
                  <IconButton
                    size="sm"
                    label={tooltips.floatSessionPopOut.label}
                    description={tooltips.floatSessionPopOut.description}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleDetachSession}
                  >
                    <DetachIcon size={13} />
                  </IconButton>
                )}
                {/* Kill: destructive, so set apart at the far end of this row and
                    never among the Mute / Share / Alert toggles (AASC-11). Same
                    confirm dialog as before. */}
                {/* The wrapper is the flex item (Tooltip wraps the button in a span). */}
                <span className={styles.titleActionKill}>
                  <IconButton
                    size="sm"
                    tone="danger"
                    label={tooltips.ctrlKill.label}
                    description={tooltips.ctrlKill.description}
                    onClick={() => openModal(KILL_MODAL_ID)}
                  >
                    <SkullIcon />
                  </IconButton>
                </span>
              </span>
            </>
          )}
          {currentLabel && (
            <LabelChip name={currentLabel} color={labelColor(currentLabel)} className={styles.switcherLabelChip} />
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
          {/* The shared status mark — the same glyph and words as the LIVE card (AASC-11). */}
          {statusLabel && (
            <StatusBadge status={isDisconnected ? 'ended' : currentSession.status} className={styles.switcherStatus} />
          )}
          {/* Claude: the model · effort it runs on NOW, following /model and /effort live.
              Others (Codex) report neither, so they keep the launch model as plain text. */}
          {hasRuntimeChip ? (
            <SessionRuntimeChip session={currentSession} />
          ) : model && (
            /* title: the badge is clamped to one ellipsised line (see
               .detailModel), so hover is the only way to read a long id. */
            <span className={styles.detailModel} title={model}>{model}</span>
          )}
          {duration && (
            <span className={styles.detailDuration}>{duration}</span>
          )}
          {controls && (
            <span className={styles.switcherControls}>{controls}</span>
          )}
          {/* One labelled View menu for grouping, rooms shown, card size, dock and
              maximize — six bare icons before (AASC-11). */}
          <SessionViewMenu
            className={styles.switcherViewMenu}
            mode={sessionSortMode}
            onModeChange={setSessionSortMode}
            rooms={availableRooms}
            selectedRoomIds={selectedRoomIds}
            onToggleRoom={toggleRoom}
            onClearRooms={clearRoomFilter}
            compact={isCompact}
            onToggleCompact={toggleCardDisplayMode}
            navPosition={navPosition}
            onToggleNavPosition={toggleNavPosition}
            maximized={maximized}
            onToggleMaximized={toggleMaximized}
          />
          {/* Start a session: + (the new-session form) and the recent-directories
              launcher — the app's one home for both while any session exists. One
              child, so a wrap never splits them. Main window only: a popped-out
              session window does not mount NewSessionModal. */}
          {!isPopoutWindow() && (
            <div className={styles.switcherLaunch}>
              <IconButton size="sm" label="New session" onClick={() => openModal('new-session')}>
                <NewSessionIcon />
              </IconButton>
              <WorkdirLauncher triggerClassName={dirsTriggerClass} />
            </div>
          )}
          {onClose && (
            // switcherMinimizeBtn: the phone breakpoint pulls it to the FRONT of the
            // wrap order (it is how you get back to the session list). On the wrapper:
            // Tooltip wraps the button in a span, and that span is the flex item.
            <span className={styles.switcherMinimizeBtn}>
              <IconButton size="sm" label="Minimize" ariaLabel="Minimize session panel" onClick={onClose}>
                <MinimizeIcon />
              </IconButton>
            </span>
          )}
          {/* Fold the left rail to a thin strip (left dock only). */}
          {isVertical && (
            <span className={styles.switcherCollapseBtn}>
              <IconButton size="sm" label="Collapse session panel" onClick={toggleNavRailCollapsed}>
                <CollapseRailIcon />
              </IconButton>
            </span>
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
        <div className={`${styles.sessionTabStrip}${roomDrag.draggingId ? ` ${styles.roomDragActive}` : ''}`}>
          {tabRenderItems.map((item) => {
            if (item.type === 'recent') {
              return (
                <div
                  key={RECENT_FRAME_KEY}
                  className={`${styles.sessionTabRoomGroup} ${styles.recentRoomGroup}${recentRoomCollapsed ? ` ${styles.sessionTabRoomGroupCollapsed}` : ''}`}
                  title={RECENT_FRAME_TITLE}
                >
                  <span className={styles.sessionTabRoomGroupLabel}>Recent</span>
                  {/* Collapse is the only control. RECENT is worked out from
                      activity, so there is nothing to drag, reorder, rename,
                      or kill as a group. */}
                  <div className={styles.roomHeaderRow}>
                    <button
                      type="button"
                      className={styles.roomCollapseToggle}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleRecentRoomCollapsed();
                      }}
                      title={recentRoomCollapsed ? 'Expand Recent' : 'Collapse Recent'}
                      aria-label={recentRoomCollapsed ? 'Expand Recent' : 'Collapse Recent'}
                      aria-expanded={!recentRoomCollapsed}
                    >
                      <FrameCollapseIcon collapsed={recentRoomCollapsed} />
                    </button>
                    {recentRoomCollapsed && (
                      <span className={styles.roomCollapsedCount}>{item.sessions.length}</span>
                    )}
                  </div>
                  {!recentRoomCollapsed &&
                    item.sessions.map((s) => (
                      <SessionTabCard
                        key={s.sessionId}
                        session={s}
                        isCurrent={s.sessionId === currentSession.sessionId}
                        isRecentCopy
                        onSwitch={handleSwitch}
                        isCompact={isCompact}
                        index={sessionIndexMap.get(s.sessionId) ?? 0}
                        needsAttention={s.sessionId !== currentSession.sessionId && attentionIds.has(s.sessionId)}
                      />
                    ))}
                </div>
              );
            }
            if (item.type === 'project') {
              const { group } = item;
              const collapsed = collapsedProjects.has(group.key);
              return (
                <div
                  key={group.key}
                  className={`${styles.sessionTabRoomGroup} ${styles.projectGroup}${collapsed ? ` ${styles.sessionTabRoomGroupCollapsed}` : ''}`}
                  style={{ '--room-color': item.color } as React.CSSProperties}
                  title={group.local ? group.path : `${group.host}:${group.path}`}
                  role="group"
                  aria-label={`Project ${group.label}`}
                >
                  <span className={styles.sessionTabRoomGroupLabel}>{group.label}</span>
                  <ProjectFrameHeader
                    group={group}
                    collapsed={collapsed}
                    onToggleCollapse={() => toggleProjectCollapsed(group.key)}
                  />
                  {!collapsed &&
                    group.sessions.map((s) => (
                      <SessionTabCard
                        key={s.sessionId}
                        session={s}
                        isCurrent={s.sessionId === currentSession.sessionId}
                        onSwitch={handleSwitch}
                        isCompact={isCompact}
                        index={sessionIndexMap.get(s.sessionId) ?? 0}
                        needsAttention={s.sessionId !== currentSession.sessionId && attentionIds.has(s.sessionId)}
                      />
                    ))}
                </div>
              );
            }
            if (item.type === 'room') {
              const collapsed = item.room.collapsed;
              // Live (killable) sessions in this room, independent of the room
              // filter — ended cards and dropped ids don't count. The kill icon
              // is hidden when there's nothing to kill.
              const roomLiveCount = item.room.sessionIds.reduce((n, id) => {
                const s = sessions.get(id);
                return s && s.status !== 'ended' ? n + 1 : n;
              }, 0);
              const roomVisualIndex = visibleRoomIds.indexOf(item.room.id);
              const isFirstRoom = roomVisualIndex <= 0;
              const isLastRoom = roomVisualIndex === visibleRoomIds.length - 1;
              // How far this frame slides aside while another room is carried
              // past it (the opened slot is the drop indicator — there is no
              // separate caret). Unset outside a drag and for unpassed rooms.
              const roomShift = roomDrag.shifts.get(item.room.id);
              return (
                <div
                  key={item.room.id}
                  ref={(el) => registerRoomEl(item.room.id, el)}
                  className={`${styles.sessionTabRoomGroup}${collapsed ? ` ${styles.sessionTabRoomGroupCollapsed}` : ''}${roomDrag.draggingId === item.room.id ? ` ${styles.roomGroupDragging}` : ''}`}
                  style={{
                    '--room-color': item.color,
                    '--room-shift': roomShift ? `${roomShift}px` : undefined,
                  } as React.CSSProperties}
                  title={item.room.name}
                >
                  <span className={styles.sessionTabRoomGroupLabel}>{item.room.name}</span>
                  {/* Header controls live in one flex row so the drag handle,
                      collapse chevron, ▲▼ reorder buttons and the kill-all
                      skull all stay on the SAME line — in the vertical rail
                      the group itself is a column, which would otherwise
                      stack each icon onto its own row. The session cards
                      render as siblings below and keep their column stacking.
                      Order is deliberate: grab (drag) → structural (collapse)
                      → reorder (▲▼) → destructive (skull) LAST, so the two
                      reorder buttons never sit immediately next to the
                      one-click "kill all" action.
                      The hairline dividers are load-bearing, not decoration:
                      collapse and "move down" were previously two near-
                      identical down-chevrons two slots apart. The glyphs now
                      differ by family (filled triangle vs arrow-with-shaft)
                      AND the dividers separate them into clusters, so the
                      distinction survives even if one of the two is ever
                      restyled back toward the other. */}
                  <div className={styles.roomHeaderRow}>
                    {/* Rail only. In the top bar the rooms sit side by side,
                        but the drop math (computeRoomInsertIndex) compares Y
                        only, so a drag there could never land where it was
                        released — and the carry preview's vertical slides
                        would visibly break the row. ▲▼ still reorder there. */}
                    {isVertical && (
                      <span
                        className={styles.roomDragHandle}
                        title="Drag to reorder this room"
                        aria-hidden="true"
                        onPointerDown={(e) => roomDrag.onPointerDown(e, item.room.id)}
                      >
                        <RoomDragHandleIcon />
                      </span>
                    )}
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
                      <FrameCollapseIcon collapsed={collapsed} />
                    </button>
                    <span className={styles.roomHeaderDivider} aria-hidden="true" />
                    <button
                      type="button"
                      className={styles.roomMoveToggle}
                      disabled={isFirstRoom}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveRoom(item.room.id, -1);
                      }}
                      title={`Move ${item.room.name} up`}
                      aria-label={`Move room ${item.room.name} up`}
                    >
                      <MoveRoomUpIcon />
                    </button>
                    <button
                      type="button"
                      className={styles.roomMoveToggle}
                      disabled={isLastRoom}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveRoom(item.room.id, 1);
                      }}
                      title={`Move ${item.room.name} down`}
                      aria-label={`Move room ${item.room.name} down`}
                    >
                      <MoveRoomDownIcon />
                    </button>
                    {roomLiveCount > 0 && (
                      <>
                      <span className={styles.roomHeaderDivider} aria-hidden="true" />
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
                        <SkullIcon />
                      </button>
                      </>
                    )}
                    {collapsed && (
                      <span className={styles.roomCollapsedCount}>{item.sessions.length}</span>
                    )}
                  </div>
                  {!collapsed &&
                    item.sessions.map((s) => (
                      <SessionTabCard
                        key={s.sessionId}
                        session={s}
                        isCurrent={s.sessionId === currentSession.sessionId}
                        onSwitch={handleSwitch}
                        isCompact={isCompact}
                        index={sessionIndexMap.get(s.sessionId) ?? 0}
                        needsAttention={s.sessionId !== currentSession.sessionId && attentionIds.has(s.sessionId)}
                      />
                    ))}
                </div>
              );
            }
            return (
              <SessionTabCard
                key={item.session.sessionId}
                session={item.session}
                isCurrent={item.session.sessionId === currentSession.sessionId}
                onSwitch={handleSwitch}
                isCompact={isCompact}
                index={sessionIndexMap.get(item.session.sessionId) ?? 0}
                needsAttention={item.session.sessionId !== currentSession.sessionId && attentionIds.has(item.session.sessionId)}
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
  isCurrent = false,
  isRecentCopy = false,
  onSwitch,
  isCompact,
  index,
  needsAttention,
}: {
  session: Session;
  /** The session this panel is showing — listed like the rest, marked apart. */
  isCurrent?: boolean;
  /** This card is the RECENT frame's second listing of the session. It looks
   *  the same, but leaves aria-current to the copy in the session's own room:
   *  one list should announce one current item. */
  isRecentCopy?: boolean;
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
  // Client queueStore is the source of truth for pending prompts — `session.queueCount`
  // is never synced from the client (the update_queue_count WS message is unused).
  const queueLen = useQueueStore((s) => s.queues.get(session.sessionId)?.length ?? 0);

  const handlePinClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useSessionStore.getState().togglePin(session.sessionId);
  }, [session.sessionId]);

  // ---- Inline rename state ----
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Pre-fill of the rename box — see headerEditFrom in SessionSwitcher. */
  const editFrom = useRef('');
  /** Was this card already the current one when the click sequence began?
   *  Its first click switches to it and the card now stays put (the current
   *  session is listed), so the second click's dblclick lands here: that
   *  double-click means "open", not "rename". */
  const currentAtPress = useRef(false);

  const beginEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentAtPress.current) return;
    const initial = session.title || session.projectName || '';
    editFrom.current = initial.trim();
    setDraft(initial);
    setEditing(true);
  }, [session.title, session.projectName]);

  const commitEdit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== editFrom.current && trimmed !== session.title) {
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
      className={`${styles.sessionTabCard}${isCompact ? ` ${styles.sessionTabCardCompact}` : ''}${isCurrent ? ` ${styles.sessionTabCardCurrent}` : ''}`}
      aria-current={isCurrent && !isRecentCopy ? 'true' : undefined}
      data-status={session.status}
      onMouseDown={(e) => {
        if (e.detail === 1) currentAtPress.current = isCurrent;
      }}
      style={{ '--robot-color': color } as React.CSSProperties}
      onClick={() => onSwitch(session.sessionId)}
      title={[title, session.projectName, session.status].filter(Boolean).join(' · ')}
      type="button"
    >
      {/* Pin toggle — sits beside the status badge (top-right). See
          .sessionTabPin: the old top-left placement put it under the opaque
          sequence badge, so it never rendered. */}
      <span
        className={`${styles.sessionTabPin}${session.pinned ? ` ${styles.pinned}` : ''}`}
        onClick={handlePinClick}
        title={session.pinned ? 'Unpin session' : 'Pin session — keeps it at the top of the list'}
        aria-label={session.pinned ? 'Unpin session' : 'Pin session'}
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
          role="img"
          aria-label="Completed — ready for review"
          title="Completed — ready for review"
        >
          ✓
        </span>
      ) : (
        <span
          className={styles.sessionTabStatusBadge}
          role="img"
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
          title={isCurrent ? 'Double-click to rename' : undefined}
        >
          {queueLen > 0 && (
            <span
              className={styles.sessionTabQueueBadge}
              title={`${queueLen} prompt${queueLen === 1 ? '' : 's'} queued`}
              aria-label={`${queueLen} queued prompt${queueLen === 1 ? '' : 's'}`}
            >
              <QueueBadgeIcon />
              {queueLen}
            </span>
          )}
          {session.isExternal && (
            <span
              className={styles.sessionTabExternalBadge}
              title="External session — running outside the dashboard (limited tracking)"
              aria-label="External session"
            >
              ⌁
            </span>
          )}
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

/**
 * SessionsScreen — the Sessions tab's root (AASC-40, design §5.1).
 *
 *   Sessions                               ⌕  ＋
 *   ┌ 🖥 MacBook  ● Online · Home network ┐
 *   │ 12 live · 3 need you   New session › │
 *   └──────────────────────────────────────┘
 *   (All 12) (Needs you 3) (Working 4) (Group: Status ▾)
 *   NEEDS YOU · WORKING · FINISHED · IDLE (folds when long)
 *
 * Ended sessions stay in History. A row opens the session (Chat for Claude Code
 * and Codex, Terminal otherwise) and marks it read here; swipe it for Mark read,
 * Mute and More; hold it for rename, label, remark, room, fork, clone, restart
 * and kill (kill and restart confirm). Group by Room / Project use the desktop
 * strip's grouping and order. Grouped by room (AASC-55) the list is the
 * desktop's room strip on a phone: hold a room's ≡ to reorder rooms, hold a
 * session's ≡ to drag it into another room (tap it for "Move to room…"), tap a
 * room's name to fold it (this phone only), and its ⋯ moves it up or down,
 * renames, recolours, deletes it or kills its sessions (only those shared with
 * this phone). Pull down (or Refresh in the search bar) re-asks the Mac.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { Session } from '@/types';
import { Button, Chip, EmptyState, ListRow, ListSection, Screen, Sheet } from '../kit';
import type { ContextMenuItem, SwipeAction } from '../kit';
import { EllipsisIcon, SessionsTabIcon } from '../kit/kitIcons';
import { CloneIcon, ForkIcon, KillIcon, PlusIcon, RenameIcon, RestartIcon, SpeakerIcon } from '../phoneIcons';
import { SearchIcon } from '../projectIcons';
import { ManageRoomsSheet, RoomIcon } from '../RoomSheets';
import { RoomGroupHeader, RoomGroupSheets } from './RoomGroupParts';
import { useCollapsedRooms } from './useCollapsedRooms';
import { useSessionRoomDrag, type GripHandlers, type SessionDrag } from './useSessionRoomDrag';
import { useIsHostDevice } from '../views/hostAccess';
import SessionListRow from './SessionListRow';
import ConnectionBanner from './ConnectionBanner';
import NewSessionSheet from './NewSessionSheet';
import SessionSheets, { type SessionSheetKind } from './info/SessionSheets';
import { forkBlocker, useSessionActions } from './info/useSessionActions';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { useRoomStore } from '@/stores/roomStore';
import { useLabelStore } from '@/stores/labelStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { usePullToRefresh, type PullPhase } from '@/hooks/usePullToRefresh';
import { showToast } from '@/components/ui/ToastContainer';
import { refreshSessionList } from '@/lib/sessionRefresh';
import { useRoomDragReorder } from '@/hooks/useRoomDragReorder';
import type { RoomDragRect } from '@/lib/roomDragReorder';
import { requestRoomChange, useIsRoomWriter } from '@/lib/roomSync';
import { reorderOpFor, sessionDropOp, type RoomGroupRect } from '@/lib/chat/roomsListModel';
import { defaultSegment, infoPath, sessionPath } from '@/lib/chat/phoneRoutes';
import { detectCli } from '@/lib/cliDetect';
import { restartBlocker } from '@/lib/chat/sessionInfoModel';
import { markSessionRead, readStamp, useSessionReads } from '@/lib/chat/sessionReads';
import { useClock } from '@/lib/chat/clock';
import {
  CONNECTION_WORDS,
  GROUP_BY_OPTIONS,
  IDLE_FOLD_AT,
  SESSIONS_FILTERS,
  connectionPath,
  filterCount,
  groupSessions,
  hostCounts,
  isUnreadFinish,
  type SessionGroup,
  type SessionsFilter,
  type SessionsGroupBy,
} from '@/lib/chat/sessionsModel';
import styles from '@/styles/modules/mobile/Sessions.module.css';
import roomStyles from '@/styles/modules/mobile/SessionRooms.module.css';

const GROUP_KEY = 'aasc.phoneSessionsGroup';
const FIT = ['fit'] as const;

const PULL_WORDS: Record<PullPhase, string> = {
  idle: '',
  pulling: 'Pull to refresh',
  armed: 'Release to refresh',
  refreshing: 'Refreshing…',
};

function readGroupBy(): SessionsGroupBy {
  try {
    const v = localStorage.getItem(GROUP_KEY);
    return v === 'room' || v === 'project' ? v : 'status';
  } catch {
    return 'status';
  }
}

async function refreshOrSay(): Promise<void> {
  const ok = await refreshSessionList();
  if (!ok) showToast('Couldn’t reach your Mac. Still trying to reconnect.', 'error');
}

// ---------------------------------------------------------------------------
// Host card
// ---------------------------------------------------------------------------

function HostCard({ onNew, blocker }: { onNew: () => void; blocker: string | null }) {
  const connected = useWsStore((s) => s.connected);
  const sessions = useSessionStore((s) => s.sessions);
  const macName = usePresenceStore((s) => s.devices.find((d) => d.isLocal)?.label);
  const { live, needYou } = useMemo(() => hostCounts(sessions.values()), [sessions]);
  const path = connectionPath(window.location.hostname);
  return (
    <section className={styles.hostCard} aria-label="Your Mac">
      <div className={styles.hostTop}>
        <span className={styles.hostIcon} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M2 20h20" />
          </svg>
        </span>
        <span className={styles.hostText}>
          <span className={styles.hostName}>{macName || 'Your Mac'}</span>
          <span className={styles.hostState} data-online={connected ? '' : undefined}>
            <span className={styles.dot} aria-hidden="true" />
            {connected ? 'Online' : 'Reconnecting…'} · {CONNECTION_WORDS[path]}
          </span>
        </span>
      </div>
      <div className={styles.hostBottom}>
        <span className={styles.hostCounts}>
          {live} live{needYou > 0 && <> · <strong>{needYou} need{needYou === 1 ? 's' : ''} you</strong></>}
        </span>
        <Button small variant="plain" icon={<PlusIcon width={18} height={18} />} onClick={onNew} disabledReason={blocker ?? undefined}>
          New session here
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// One group (a status section, a room, a project)
// ---------------------------------------------------------------------------

/** What a group grouped by room adds (AASC-55): folding, both drags, the room's menu. */
interface RoomGrouping {
  collapsed: ReadonlySet<string>;
  onToggleRoom: (roomId: string) => void;
  onRoomMenu: (roomId: string) => void;
  onRoomGripDown: (e: PointerEvent, roomId: string) => void;
  /** The room being reordered, and how far each passed room slides aside. */
  liftedRoomId: string | null;
  roomShifts: ReadonlyMap<string, number>;
  registerRoomEl: (roomId: string, el: HTMLElement | null) => void;
  registerGroup: (key: string, roomId: string | null, el: HTMLElement | null) => void;
  gripFor: (sessionId: string, fromRoomId: string | null) => GripHandlers;
  sessionDrag: SessionDrag | null;
}

interface GroupProps {
  group: SessionGroup;
  /** The Idle section may fold (not while a search lists every match). */
  foldable: boolean;
  groupBy: SessionsGroupBy;
  now: number;
  folded: boolean;
  onToggleFold: () => void;
  rowProps: (session: Session) => { swipeActions: SwipeAction[]; menuItems: ContextMenuItem[] };
  onOpen: (session: Session) => void;
  /** Set when grouped by room. */
  rooms?: RoomGrouping;
}

function GroupSection({ group, foldable, groupBy, now, folded, onToggleFold, rowProps, onOpen, rooms }: GroupProps) {
  const count = group.sessions.length;
  const roomId = group.room?.id ?? null;
  const roomFolded = !!(rooms && roomId && rooms.collapsed.has(roomId));
  const groupRef = useCallback((el: HTMLDivElement | null) => {
    if (!rooms) return;
    rooms.registerGroup(group.key, roomId, el);
    if (roomId) rooms.registerRoomEl(roomId, el);
  }, [rooms, group.key, roomId]);
  // The header sits outside the list's region, so the region is named by the
  // group alone ("Needs you"), not by its buttons too.
  const header = rooms && group.room ? (
    <RoomGroupHeader
      room={group.room}
      title={group.title}
      count={count}
      color={group.color}
      collapsed={roomFolded}
      onToggle={rooms.onToggleRoom}
      onMenu={rooms.onRoomMenu}
      onGripDown={rooms.onRoomGripDown}
    />
  ) : (
    <div className={styles.groupHeader}>
      {group.color && <span className={styles.swatch} style={{ '--swatch': group.color } as CSSProperties} aria-hidden="true" />}
      <h2 className={styles.groupTitle}>{group.title} · {count}</h2>
      {foldable && (
        <button type="button" className={styles.groupAction} onClick={onToggleFold} aria-expanded={!folded}>
          {folded ? `Show ${count}` : 'Hide'}
        </button>
      )}
    </div>
  );
  const drag = rooms?.sessionDrag ?? null;
  const roomShift = roomId ? rooms?.roomShifts.get(roomId) : undefined;
  return (
    <div
      ref={groupRef}
      className={`${styles.group} ${rooms ? roomStyles.roomGroup : ''}`}
      data-room-lifted={roomId && rooms?.liftedRoomId === roomId ? '' : undefined}
      data-drop-target={drag && drag.overRoomId === roomId && drag.fromRoomId !== roomId ? '' : undefined}
      style={roomShift ? ({ '--room-shift': `${roomShift}px` } as CSSProperties) : undefined}
      data-testid={rooms ? `room-group-${roomId ?? 'none'}` : undefined}
    >
      {header}
      {roomFolded ? null : (
      <ListSection label={group.title} className={styles.groupList}>
      {count === 0 && rooms ? (
        <li className={roomStyles.emptyRoom}>No sessions. Hold a session’s ≡ and drop it here.</li>
      ) : folded ? (
        <li className={styles.foldedNote}>
          <button type="button" className={styles.foldedButton} onClick={onToggleFold} aria-expanded={false}>
            {count} idle sessions folded · Show them
          </button>
        </li>
      ) : group.sessions.map((s) => (
        <SessionListRow
          key={s.sessionId}
          session={s}
          now={now}
          hideRoom={groupBy === 'room'}
          hideProject={groupBy === 'project'}
          onOpen={onOpen}
          grip={rooms?.gripFor(s.sessionId, roomId)}
          dragY={drag?.sessionId === s.sessionId ? drag.dy : undefined}
          {...rowProps(s)}
        />
      ))}
      </ListSection>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export default function SessionsScreen() {
  const sessions = useSessionStore((s) => s.sessions);
  const snapshotReceived = useWsStore((s) => s.snapshotReceived);
  const connected = useWsStore((s) => s.connected);
  const hiddenCount = useWsStore((s) => s.hiddenCount);
  const rooms = useRoomStore((s) => s.rooms);
  const labels = useLabelStore((s) => s.labels);
  const push = usePhoneNavStore((s) => s.push);
  const reads = useSessionReads();
  const now = useClock();
  const { copy, setNotifications, markRead } = useSessionActions();

  const [filter, setFilter] = useState<SessionsFilter>('all');
  const [groupBy, setGroupByState] = useState<SessionsGroupBy>(readGroupBy);
  const [groupSheet, setGroupSheet] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [idleOpen, setIdleOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SessionSheetKind | null>(null);
  const [roomMenuId, setRoomMenuId] = useState<string | null>(null);
  const [manageRooms, setManageRooms] = useState(false);
  const isHost = useIsHostDevice();
  const isRoomWriter = useIsRoomWriter();
  const { collapsed: collapsedRooms, toggle: toggleRoom } = useCollapsedRooms(rooms);
  const searchRef = useRef<HTMLInputElement>(null);

  const setGroupBy = useCallback((next: SessionsGroupBy) => {
    setGroupByState(next);
    try { localStorage.setItem(GROUP_KEY, next); } catch { /* the choice lasts until reload */ }
  }, []);

  const groups = useMemo(
    () => groupSessions({ sessions: sessions.values(), groupBy, filter, query, labels, rooms, reads }),
    [sessions, groupBy, filter, query, labels, rooms, reads],
  );
  const counts = useMemo(() => ({
    all: filterCount(sessions.values(), 'all'),
    'needs-you': filterCount(sessions.values(), 'needs-you'),
    working: filterCount(sessions.values(), 'working'),
  }), [sessions]);

  const blocker = !connected ? 'Reconnecting to your Mac…' : null;
  const closeNew = useCallback(() => setNewOpen(false), []);
  const openNew = useCallback(() => setNewOpen(true), []);
  const closeGroupSheet = useCallback(() => setGroupSheet(false), []);
  const closeRoomMenu = useCallback(() => setRoomMenuId(null), []);
  const closeManageRooms = useCallback(() => setManageRooms(false), []);
  const openSheet = useCallback((id: string, kind: SessionSheetKind) => {
    setSheetFor(id);
    setSheet(kind);
  }, []);

  const open = useCallback((session: Session) => {
    markSessionRead(session.sessionId, readStamp(session));
    push(sessionPath(session.sessionId, defaultSegment(detectCli(session))));
  }, [push]);

  const rowProps = useCallback((s: Session) => {
    const id = s.sessionId;
    const unread = isUnreadFinish(s, reads);
    const swipeActions: SwipeAction[] = [
      { id: 'read', label: unread ? 'Mark read' : 'Read', tone: 'accent', onAction: () => markRead(s) },
      { id: 'mute', label: s.muted ? 'Unmute' : 'Mute', icon: <SpeakerIcon width={20} height={20} />, onAction: () => setNotifications(s, !!s.muted) },
      { id: 'more', label: 'More', icon: <EllipsisIcon />, onAction: () => openSheet(id, 'actions') },
    ];
    const ended = s.status === 'ended';
    const menuItems: ContextMenuItem[] = [
      { id: 'read', label: 'Mark read', disabledReason: unread ? undefined : 'Nothing new since you read it.', onSelect: () => markRead(s) },
      { id: 'mute', label: s.muted ? 'Turn notifications on' : 'Mute notifications', icon: <SpeakerIcon />, onSelect: () => setNotifications(s, !!s.muted) },
      { id: 'rename', label: 'Rename', icon: <RenameIcon />, onSelect: () => openSheet(id, 'rename') },
      { id: 'label', label: 'Label…', onSelect: () => openSheet(id, 'label') },
      { id: 'remark', label: 'Remark…', onSelect: () => openSheet(id, 'remark') },
      { id: 'room', label: 'Move to room…', icon: <RoomIcon />, onSelect: () => openSheet(id, 'move-room') },
      { id: 'fork', label: 'Fork', icon: <ForkIcon />, disabledReason: forkBlocker(s) ?? undefined, onSelect: () => void copy(id, 'fork') },
      { id: 'clone', label: 'Clone', icon: <CloneIcon />, onSelect: () => void copy(id, 'clone') },
      { id: 'restart', label: 'Restart…', icon: <RestartIcon />, disabledReason: restartBlocker(s) ?? undefined, onSelect: () => openSheet(id, 'restart') },
      { id: 'kill', label: 'Kill…', icon: <KillIcon />, destructive: true, disabledReason: ended ? 'It has already ended.' : undefined, onSelect: () => openSheet(id, 'kill') },
    ];
    return { swipeActions, menuItems };
  }, [reads, markRead, setNotifications, openSheet, copy]);

  const pull = usePullToRefresh<HTMLDivElement>(refreshOrSay);
  const pullHost = useRef<HTMLDivElement>(null);
  const { scrollerRef: pullScrollerRef } = pull;
  useEffect(() => {
    // The Screen's own scroller is the one the pull reads and writes (--pull).
    pullScrollerRef.current = pullHost.current?.parentElement as HTMLDivElement | null;
  });

  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  // ---- Grouped by room (AASC-55) ----
  const byRoom = groupBy === 'room';
  // The room groups on screen, in order: what a room drag and Move up / down reorder.
  const visibleRoomIds = useMemo(
    () => (byRoom ? groups.flatMap((g) => (g.room ? [g.room.id] : [])) : []),
    [byRoom, groups],
  );
  const roomEls = useRef(new Map<string, HTMLElement>());
  const registerRoomEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) roomEls.current.set(id, el);
    else roomEls.current.delete(id);
  }, []);
  const getRoomRects = useCallback((): RoomDragRect[] => visibleRoomIds.flatMap((id) => {
    const el = roomEls.current.get(id);
    if (!el) return [];
    const r = el.getBoundingClientRect();
    return [{ id, top: r.top, bottom: r.bottom }];
  }), [visibleRoomIds]);
  const getRoomEl = useCallback((id: string) => roomEls.current.get(id), []);
  const commitRoomOrder = useCallback((nextIds: string[]) => {
    const op = reorderOpFor(useRoomStore.getState().rooms, nextIds);
    if (!op) return;
    void requestRoomChange(op, isRoomWriter).then((outcome) => {
      if (!outcome.ok) showToast(outcome.message, 'error');
    });
  }, [isRoomWriter]);
  const roomDrag = useRoomDragReorder(visibleRoomIds, getRoomRects, commitRoomOrder, getRoomEl);

  const dropSession = useCallback((sessionId: string, fromRoomId: string | null, target: RoomGroupRect | null) => {
    const op = sessionDropOp(sessionId, fromRoomId, target);
    if (!op || op.type !== 'move') return;
    const name = op.roomId ? useRoomStore.getState().rooms.find((r) => r.id === op.roomId)?.name : null;
    void requestRoomChange(op, isRoomWriter).then((outcome) => {
      if (!outcome.ok) showToast(outcome.message, 'error');
      else showToast(name ? `Moved to ${name}` : 'Taken out of its room', 'info');
    });
  }, [isRoomWriter]);
  const tapGrip = useCallback((sessionId: string) => openSheet(sessionId, 'move-room'), [openSheet]);
  const sessionDrag = useSessionRoomDrag(dropSession, tapGrip);

  const roomGrouping = useMemo<RoomGrouping | undefined>(() => (byRoom ? {
    collapsed: collapsedRooms,
    onToggleRoom: toggleRoom,
    onRoomMenu: setRoomMenuId,
    onRoomGripDown: roomDrag.onPointerDown,
    liftedRoomId: roomDrag.draggingId,
    roomShifts: roomDrag.shifts,
    registerRoomEl,
    registerGroup: sessionDrag.registerGroup,
    gripFor: sessionDrag.gripFor,
    sessionDrag: sessionDrag.drag,
  } : undefined), [byRoom, collapsedRooms, toggleRoom, roomDrag.onPointerDown, roomDrag.draggingId, roomDrag.shifts,
    registerRoomEl, sessionDrag.registerGroup, sessionDrag.gripFor, sessionDrag.drag]);

  const actions = (
    <>
      <button
        type="button"
        className={styles.navAction}
        onClick={() => {
          setSearching((on) => !on);
          if (searching) setQuery('');
        }}
        aria-label="Search"
        aria-pressed={searching}
      >
        <SearchIcon />
      </button>
      <button type="button" className={styles.navAction} onClick={openNew} aria-label="New session" aria-haspopup="dialog">
        <PlusIcon />
      </button>
    </>
  );

  let body;
  if (!snapshotReceived) {
    body = (
      <EmptyState
        live
        title={connected ? 'Loading sessions…' : 'Connecting to your Mac…'}
        message={connected ? undefined : 'If this takes long, check that AASC is open on your Mac and that this phone can reach it.'}
        action={connected ? undefined : <Button onClick={() => void refreshOrSay()}>Try again</Button>}
      />
    );
  } else if (counts.all === 0) {
    body = (
      <EmptyState
        icon={<SessionsTabIcon />}
        title="No sessions here yet"
        message={hiddenCount > 0
          ? `${hiddenCount} ${hiddenCount === 1 ? 'session runs' : 'sessions run'} on your Mac but ${hiddenCount === 1 ? 'isn’t' : 'aren’t'} shared with this phone. On your Mac, share a session with 📡.`
          : 'No sessions shared with this phone yet. On your Mac, share a session with 📡.'}
        action={<Button variant="primary" onClick={openNew} disabledReason={blocker ?? undefined}>Start a session</Button>}
      />
    );
  } else if (groups.length === 0) {
    body = (
      <EmptyState
        title={query ? `Nothing matches “${query}”` : filter === 'needs-you' ? 'Nothing needs you' : 'Nothing is working right now'}
        message={query ? 'Search looks at names, projects, labels and remarks.' : undefined}
        action={<Button onClick={() => { setQuery(''); setFilter('all'); }}>Show all sessions</Button>}
      />
    );
  } else {
    body = groups.map((g) => {
      const foldable = g.section === 'idle' && g.sessions.length > IDLE_FOLD_AT && !query;
      return (
      <GroupSection
        key={g.key}
        group={g}
        foldable={foldable}
        groupBy={groupBy}
        now={now}
        folded={foldable && !idleOpen}
        onToggleFold={() => setIdleOpen((v) => !v)}
        rowProps={rowProps}
        onOpen={open}
        rooms={roomGrouping}
      />
      );
    });
    if (byRoom) {
      body = (
        <div className={roomStyles.roomList} data-room-drag={roomDrag.draggingId ? '' : undefined} data-session-drag={sessionDrag.drag ? '' : undefined}>
          {body}
        </div>
      );
    }
  }

  return (
    <Screen title="Sessions" large banner={<ConnectionBanner />} actions={actions} testId="phone-sessions">
      <div
        ref={pullHost}
        className={styles.pullHost}
        data-pull={pull.phase}
        {...pull.handlers}
      >
        <div className={styles.pull} aria-hidden={pull.phase === 'idle' ? true : undefined}>
          {pull.phase !== 'idle' && (
            <span className={styles.pullInner} role="status">
              <span className={styles.pullSpinner} aria-hidden="true" />
              {PULL_WORDS[pull.phase]}
            </span>
          )}
        </div>
        {searching && (
          <div className={styles.searchRow}>
            <input
              ref={searchRef}
              type="search"
              className={styles.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, project, label or remark"
              aria-label="Search sessions"
              enterKeyHint="search"
            />
            <Button small variant="plain" onClick={() => void pull.refresh()} loading={pull.phase === 'refreshing'} loadingLabel="Refreshing">
              Refresh
            </Button>
          </div>
        )}
        {snapshotReceived && <HostCard onNew={openNew} blocker={blocker} />}
        {snapshotReceived && counts.all > 0 && (
          <div className={styles.chips} role="group" aria-label="Show">
            {SESSIONS_FILTERS.map((f) => (
              <Chip key={f.value} label={f.label} count={counts[f.value]} selected={filter === f.value} onClick={() => setFilter(f.value)} />
            ))}
            <Chip
              label={`By ${GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.label.toLowerCase()}`}
              onClick={() => setGroupSheet(true)}
            />
          </div>
        )}
        {snapshotReceived && counts.all > 0 && byRoom && (
          <div className={roomStyles.roomsBar}>
            <Button small variant="plain" icon={<RoomIcon />} onClick={() => setManageRooms(true)}>
              New or manage rooms
            </Button>
          </div>
        )}
        {body}
      </div>

      <NewSessionSheet open={newOpen} onClose={closeNew} blocker={blocker} />
      <SessionSheets
        sessionId={sheetFor}
        sheet={sheet}
        onSheet={setSheet}
        onOpenInfo={sheetFor ? () => push(infoPath(sheetFor)) : undefined}
      />
      <Sheet open={groupSheet} onClose={closeGroupSheet} title="Group sessions by" detents={FIT} testId="group-by-sheet">
        <ListSection label="Group by" footer="Rooms and projects are listed in your Mac’s order.">
          {GROUP_BY_OPTIONS.map((o) => (
            <ListRow
              key={o.value}
              title={o.label}
              value={groupBy === o.value ? 'Selected' : undefined}
              ariaLabel={`${o.label}${groupBy === o.value ? ', selected' : ''}`}
              onClick={() => {
                setGroupBy(o.value);
                setGroupSheet(false);
              }}
            />
          ))}
        </ListSection>
      </Sheet>
      <RoomGroupSheets menuRoomId={roomMenuId} onCloseMenu={closeRoomMenu} visibleRoomIds={visibleRoomIds} remote={!isHost} />
      <ManageRoomsSheet open={manageRooms} onClose={closeManageRooms} />
    </Screen>
  );
}

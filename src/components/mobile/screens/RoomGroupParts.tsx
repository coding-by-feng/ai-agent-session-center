/**
 * RoomGroupParts — a room group on the phone's Sessions list (AASC-55):
 *
 *   ≡  ▾ ■ MOBILE · 3                                  ⋯
 *
 *  - ≡ hold and drag to reorder rooms (the desktop strip's useRoomDragReorder,
 *    hold-first on touch); the order is the Mac's `listOrder`, shown on every device
 *  - the name folds and unfolds the room on this phone only
 *  - ⋯ opens the room's sheet: Move up / Move down (the one-handed reorder),
 *    Rename, Colour, Delete, and Kill all sessions (after a confirm)
 *
 * Every change goes through `requestRoomChange`: applied on the device that owns
 * the rooms, asked of the Mac anywhere else. Kill-room stops only the sessions
 * shared with this phone (lib/chat/phoneRoomKill.ts).
 */
import { useCallback, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { ConfirmSheet, ListRow, ListSection, Sheet } from '../kit';
import { EllipsisIcon } from '../kit/kitIcons';
import { DeleteRoomConfirm, RoomEditSheet } from '../RoomSheets';
import { showToast } from '@/components/ui/ToastContainer';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { stepRoom } from '@/lib/roomOrder';
import { requestRoomChange, useIsRoomWriter } from '@/lib/roomSync';
import { reorderOpFor } from '@/lib/chat/roomsListModel';
import { killSharedRoomSessions, roomKillSummary, sharedRoomTargets } from '@/lib/chat/phoneRoomKill';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { RECENT_WINDOW_MS } from '@/lib/recentSessions';
import type { RoomOp } from '@/types';
import styles from '@/styles/modules/mobile/SessionRooms.module.css';

const FIT = ['fit'] as const;
const KILL_NAME_CAP = 8;

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={styles.chevron} data-open={open ? '' : undefined}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={styles.recentIcon}>
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  );
}

/** A filled pin, the size of a room swatch: what a pinned card shows (PinIcon), at header scale. */
function PinGlyph() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" fill="currentColor" aria-hidden="true" className={styles.recentIcon}>
      <path d="M6 1.2c-1.6 0-2.8 1.2-2.8 2.7 0 1.2.8 2.2 1.8 2.6L6 10.8l1-4.3c1-.4 1.8-1.4 1.8-2.6 0-1.5-1.2-2.7-2.8-2.7Z" />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

export interface RoomGroupHeaderProps {
  room: Room;
  title: string;
  count: number;
  color?: string;
  collapsed: boolean;
  onToggle: (roomId: string) => void;
  onMenu: (roomId: string) => void;
  /** Starts the room's reorder drag (useRoomDragReorder's onPointerDown). */
  onGripDown: (e: PointerEvent, roomId: string) => void;
}

export function RoomGroupHeader({ room, title, count, color, collapsed, onToggle, onMenu, onGripDown }: RoomGroupHeaderProps) {
  return (
    <div className={styles.header}>
      {/* Not a button: the drag hook ignores presses on buttons. Its keyboard
          and one-handed path is Move up / Move down in the room's ⋯ sheet. */}
      <span
        className={styles.roomGrip}
        aria-hidden="true"
        data-testid={`room-grip-${room.id}`}
        onPointerDown={(e) => onGripDown(e, room.id)}
        // The list's pull-to-refresh listens to touch events: a room carried down
        // from the top must not also pull the list (and shift every measured box).
        onTouchStart={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <GripIcon />
      </span>
      <h2 className={styles.title}>
        <button
          type="button"
          className={styles.toggle}
          onClick={() => onToggle(room.id)}
          aria-expanded={!collapsed}
          aria-label={`${title}, ${count} ${count === 1 ? 'session' : 'sessions'}, ${collapsed ? 'folded' : 'open'}`}
        >
          <ChevronIcon open={!collapsed} />
          {color && <span className={styles.swatch} style={{ '--swatch': color } as CSSProperties} aria-hidden="true" />}
          <span className={styles.titleText}>{title} · {count}</span>
        </button>
      </h2>
      <button
        type="button"
        className={styles.menuButton}
        onClick={() => onMenu(room.id)}
        aria-label={`Actions for the room ${title}`}
        aria-haspopup="dialog"
      >
        <EllipsisIcon />
      </button>
    </div>
  );
}

/**
 * The built-in Recent group's header (By room, Oct 20 2026): the desktop rail's
 * RECENT frame. It folds like a room but is not one, so no ≡ and no ⋯; the space
 * where ≡ sits keeps its title in line with the rooms' titles.
 */
export function RecentGroupHeader({ count, collapsed, onToggle }: { count: number; collapsed: boolean; onToggle: () => void }) {
  const minutes = RECENT_WINDOW_MS / 60_000;
  return (
    <BuiltinGroupHeader
      title="Recent"
      icon={<ClockIcon />}
      count={count}
      collapsed={collapsed}
      onToggle={onToggle}
      describe={`active in the last ${minutes} minutes`}
    />
  );
}

/** The built-in Pinned group's header (By room, Oct 22 2026): the desktop rail's PINNED frame, the same way. */
export function PinnedGroupHeader({ count, collapsed, onToggle }: { count: number; collapsed: boolean; onToggle: () => void }) {
  return <BuiltinGroupHeader title="Pinned" icon={<PinGlyph />} count={count} collapsed={collapsed} onToggle={onToggle} describe="pinned" />;
}

function BuiltinGroupHeader({ title, icon, count, collapsed, onToggle, describe }: {
  title: string;
  icon: ReactNode;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** What its sessions have in common, for the spoken name ("pinned"). */
  describe: string;
}) {
  return (
    <div className={styles.header}>
      <span className={styles.gripSpace} aria-hidden="true" />
      <h2 className={styles.title}>
        <button
          type="button"
          className={styles.toggle}
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={`${title}, ${count} ${count === 1 ? 'session' : 'sessions'} ${describe}, also in their rooms, ${collapsed ? 'folded' : 'open'}`}
        >
          <ChevronIcon open={!collapsed} />
          {icon}
          <span className={styles.titleText}>{title} · {count}</span>
        </button>
      </h2>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The room's sheets
// ---------------------------------------------------------------------------

export interface RoomGroupSheetsProps {
  /** The room whose ⋯ was tapped; null = closed. */
  menuRoomId: string | null;
  onCloseMenu: () => void;
  /** The room groups on screen, in order: what Move up / Move down step through. */
  visibleRoomIds: readonly string[];
  /** A remote device (not the Mac itself): kill-room stops only shared sessions, and says so. */
  remote: boolean;
}

/** Ask for a room change and toast the outcome. */
async function changeRooms(op: RoomOp, isWriter: boolean, done: string): Promise<boolean> {
  const outcome = await requestRoomChange(op, isWriter);
  showToast(outcome.ok ? done : outcome.message, outcome.ok ? 'info' : 'error');
  return outcome.ok;
}

export function RoomGroupSheets({ menuRoomId, onCloseMenu, visibleRoomIds, remote }: RoomGroupSheetsProps) {
  const rooms = useRoomStore((s) => s.rooms);
  const sessions = useSessionStore((s) => s.sessions);
  const isWriter = useIsRoomWriter();
  // Rooms by id, read from the store when used: membership can change (rooms
  // sync from the Mac) between the menu, the confirm and the kill.
  const menuRoom = rooms.find((r) => r.id === menuRoomId) ?? null;
  const [killId, setKillId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; mode: 'rename' | 'color' } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const killRoom = rooms.find((r) => r.id === killId) ?? null;
  const deleting = rooms.find((r) => r.id === deletingId) ?? null;
  const [killing, setKilling] = useState(false);
  const killingRef = useRef(false);

  const cancelKill = useCallback(() => { if (!killingRef.current) setKillId(null); }, []);
  const closeEdit = useCallback(() => setEditing(null), []);
  const endDelete = useCallback(() => setDeletingId(null), []);

  const step = async (room: Room, dir: -1 | 1) => {
    onCloseMenu();
    const next = stepRoom(visibleRoomIds, room.id, dir);
    const op = next ? reorderOpFor(useRoomStore.getState().rooms, next) : null;
    if (op) await changeRooms(op, isWriter, `Moved “${room.name}” ${dir < 0 ? 'up' : 'down'}`);
  };

  const runKill = async () => {
    const room = useRoomStore.getState().rooms.find((r) => r.id === killId);
    if (killingRef.current) return;
    const targets = room ? sharedRoomTargets(room, useSessionStore.getState().sessions, remote) : [];
    if (!room || targets.length === 0) {
      setKillId(null);
      return;
    }
    killingRef.current = true;
    setKilling(true);
    try {
      const result = await killSharedRoomSessions(targets);
      showToast(roomKillSummary(room.name, result, remote), result.failed > 0 ? 'error' : 'success');
    } finally {
      killingRef.current = false;
      setKilling(false);
      setKillId(null);
    }
  };

  const at = menuRoom ? visibleRoomIds.indexOf(menuRoom.id) : -1;
  const menuTargets = menuRoom ? sharedRoomTargets(menuRoom, sessions, remote) : [];
  const killTargets = killRoom ? sharedRoomTargets(killRoom, sessions, remote) : [];
  const killNames = killTargets.slice(0, KILL_NAME_CAP).map(sessionDisplayTitle);
  const sharedWord = remote ? ' shared with this phone' : '';

  return (
    <>
      <Sheet open={menuRoom !== null} onClose={onCloseMenu} title={menuRoom ? `Room “${menuRoom.name}”` : 'Room'} detents={FIT} testId="room-menu-sheet">
        {menuRoom && (
          <>
            <ListSection label="Order" footer="Or hold ≡ beside a room’s name and drag it. Your Mac shows the same order.">
              <ListRow title="Move up" disabledReason={at <= 0 ? 'It is first already.' : undefined} onClick={() => void step(menuRoom, -1)} />
              <ListRow title="Move down" disabledReason={at === -1 || at >= visibleRoomIds.length - 1 ? 'It is last already.' : undefined} onClick={() => void step(menuRoom, 1)} />
            </ListSection>
            <ListSection label="Room">
              <ListRow title="Rename…" onClick={() => { setEditing({ id: menuRoom.id, mode: 'rename' }); onCloseMenu(); }} />
              <ListRow title="Colour…" onClick={() => { setEditing({ id: menuRoom.id, mode: 'color' }); onCloseMenu(); }} />
              <ListRow title="Delete room…" destructive onClick={() => { setDeletingId(menuRoom.id); onCloseMenu(); }} />
            </ListSection>
            <ListSection label="Sessions">
              <ListRow
                title={`Kill all sessions in “${menuRoom.name}”…`}
                destructive
                disabledReason={menuTargets.length === 0 ? `No live sessions${sharedWord} in this room.` : undefined}
                onClick={() => {
                  setKillId(menuRoom.id);
                  onCloseMenu();
                }}
              />
            </ListSection>
          </>
        )}
      </Sheet>
      <ConfirmSheet
        open={killRoom !== null}
        title={killRoom ? `Kill all sessions in “${killRoom.name}”?` : 'Kill all sessions?'}
        message={(
          <>
            <span className={styles.killList}>
              {killNames.join(', ')}
              {killTargets.length > KILL_NAME_CAP && ` +${killTargets.length - KILL_NAME_CAP} more`}
            </span>
            {` This ends ${killTargets.length} live ${killTargets.length === 1 ? 'session' : 'sessions'}${sharedWord}. Ended sessions are skipped.`}
            {remote && ' Sessions not shared with this phone are never touched; they keep running on your Mac.'}
          </>
        )}
        confirmLabel={`Kill ${killTargets.length}`}
        danger
        busy={killing}
        onConfirm={() => void runKill()}
        onCancel={cancelKill}
      />
      <RoomEditSheet roomId={editing?.id ?? null} mode={editing?.mode ?? 'rename'} onClose={closeEdit} />
      <DeleteRoomConfirm room={deleting} onDone={endDelete} />
    </>
  );
}

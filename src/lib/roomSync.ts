/**
 * @module roomSync
 * Every device's rooms come from the Mac (AASC-20).
 *
 * Rooms live in each browser's localStorage, and the Mac's main window — the
 * workspace writer — owns them. A paired phone may not read the workspace
 * snapshot, and every other device read its rooms only once at load. Now:
 *
 *  - The writer's main window pushes its list to the server (PUT /api/rooms)
 *    shortly after every change and once after it connects. Only ids of
 *    sessions it has go out: a room keeps the id of a session that has gone
 *    until a restart, and the server counts an id it can't resolve as hidden.
 *  - Everyone else takes the server's list as theirs: the GET after each
 *    connect and every `rooms_update` (newest revision wins). A remote device's
 *    copy has only the sessions shared with it. Its own `collapsed` flags stay.
 *  - A room change made elsewhere reaches the writer as `room_op`; only the
 *    writer's main window applies it (roomOps.ts), and its push carries it on.
 *
 * The writer never takes `rooms_update` (it is the source), so nothing echoes.
 * A pop-out shares its main window's device id and localStorage, so it is never
 * the writer and keeps the list in memory only. The desktop's own room logic is
 * unchanged: the writer's list is its room store, as before.
 */
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useWsStore } from '@/stores/wsStore';
import { useUiStore } from '@/stores/uiStore';
import { getClientId } from '@/lib/deviceIdentity';
import { isPopoutWindow } from '@/lib/windowRole';
import { isNativeMobileApp } from '@/lib/platform';
import { isImportInProgress, isRestorePending } from '@/lib/workspaceSnapshot';
import { applyRoomOp, readRoomOp } from '@/lib/roomOps';
import type { Room, RoomList } from '@/types';

/** How long after a change the writer pushes; changes in between go in the same push. */
export const ROOM_PUSH_DELAY_MS = 500;

type RoomRole = 'writer' | 'viewer' | 'unknown';

/** Revision of the list last taken from the server; a lower one is a late answer. */
let lastRevision = -1;
/** A list that arrived before presence said whether this window is the writer. */
let held: RoomList | null = null;
/** This window has taken a list from the server since it connected. */
let tookServerList = false;

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pushInFlight = false;
let pushAgain = false;
/** The last list the server accepted from this window, as JSON. */
let lastPushed: string | null = null;

/**
 * What this window is for the room list. A pop-out and the phone app never own
 * rooms (the phone's profile refuses PUT /rooms); a window without presence yet
 * doesn't know.
 */
function roomRole(): RoomRole {
  if (isPopoutWindow() || isNativeMobileApp()) return 'viewer';
  const presence = usePresenceStore.getState();
  if (!presence.received) return 'unknown';
  return presence.workspaceWriter === getClientId() ? 'writer' : 'viewer';
}

/** Is this the window whose room store is the list everyone else gets? */
export function isRoomWriter(): boolean {
  return roomRole() === 'writer';
}

/** Hook form of {@link isRoomWriter}: the room sheets change the store only here. */
export function useIsRoomWriter(): boolean {
  const isWriterDevice = usePresenceStore((s) => s.received && s.workspaceWriter === getClientId());
  return isWriterDevice && !isPopoutWindow() && !isNativeMobileApp();
}

/** True once this window has taken the Mac's list from the server (useWorkspaceAutoLoad's viewer path defers to it). */
export function hasServerRooms(): boolean {
  return tookServerList;
}

// ---------------------------------------------------------------------------
// Taking the list (everyone but the writer)
// ---------------------------------------------------------------------------

function isRoom(value: unknown): value is Room {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.name === 'string'
    && Array.isArray(r.sessionIds) && r.sessionIds.every((id) => typeof id === 'string');
}

function take(list: RoomList): void {
  lastRevision = list.revision;
  held = null;
  tookServerList = true;
  // Collapsing a room is this device's view, not the Mac's.
  const collapsed = new Map(useRoomStore.getState().rooms.map((r) => [r.id, r.collapsed]));
  const rooms = list.rooms.filter(isRoom).map((r) => {
    const mine = collapsed.get(r.id);
    return mine === undefined ? { ...r, collapsed: !!r.collapsed } : { ...r, collapsed: mine };
  });
  // Rooms only: hydrateRooms never touches sessions.
  useRoomStore.getState().hydrateRooms(rooms, { persist: !isPopoutWindow() });
}

/** A list from the server (`rooms_update` or the GET). The writer ignores it: it is the source. */
export function receiveRooms(list: RoomList): void {
  if (typeof list.revision !== 'number' || !Array.isArray(list.rooms)) return;
  if (list.revision <= lastRevision) return;
  const role = roomRole();
  if (role === 'writer') return;
  if (role === 'unknown') {
    if (!held || list.revision > held.revision) held = list;
    return;
  }
  take(list);
}

/** Presence arrived or changed: a held list is taken now, unless this window turned out to be the writer. */
function settleHeld(): void {
  if (!held) return;
  const role = roomRole();
  if (role === 'unknown') return;
  const list = held;
  held = null;
  if (role === 'viewer' && list.revision > lastRevision) take(list);
}

async function fetchRooms(): Promise<void> {
  try {
    const res = await fetch('/api/rooms', { method: 'GET' });
    if (!res.ok) return;
    const body = (await res.json()) as Partial<RoomList> | null;
    if (body && typeof body.revision === 'number' && Array.isArray(body.rooms)) {
      receiveRooms({ revision: body.revision, rooms: body.rooms });
    }
  } catch {
    /* best-effort: the next rooms_update brings the list */
  }
}

// ---------------------------------------------------------------------------
// Room changes from other devices (the writer only)
// ---------------------------------------------------------------------------

/** A `room_op` from the server: applied only by the writer's main window. */
export function handleRoomOpMessage(msg: unknown): void {
  if (roomRole() !== 'writer' || !msg || typeof msg !== 'object') return;
  const op = readRoomOp((msg as { op?: unknown }).op);
  if (op) applyRoomOp(op);
}

// ---------------------------------------------------------------------------
// Pushing the list (the writer only)
// ---------------------------------------------------------------------------

/**
 * Whether the room store is the list right now. Not while the restore is
 * undecided or an import runs (the same rule as the workspace auto-save: the
 * store is partial then), nor before the session list has arrived (every id
 * would read as gone).
 */
function canPush(): boolean {
  const ws = useWsStore.getState();
  return isRoomWriter() && ws.connected && ws.snapshotReceived && !isRestorePending() && !isImportInProgress();
}

/** The room store as it goes out: only ids of sessions this window has. Never changes the store. */
function listToPush(): Room[] {
  const sessions = useSessionStore.getState().sessions;
  return useRoomStore.getState().rooms.map((r) => ({ ...r, sessionIds: r.sessionIds.filter((id) => sessions.has(id)) }));
}

async function push(): Promise<void> {
  if (!canPush()) return; // the next change, session update or presence update tries again
  if (pushInFlight) {
    pushAgain = true;
    return;
  }
  const rooms = listToPush();
  const json = JSON.stringify(rooms);
  if (json === lastPushed) return;
  pushInFlight = true;
  try {
    const res = await fetch('/api/rooms', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rooms }),
    });
    // 409: another device became the writer; its own push is the list now.
    if (res.ok) lastPushed = json;
  } catch {
    /* best-effort, like the workspace auto-save: the next change pushes again */
  } finally {
    pushInFlight = false;
  }
  if (pushAgain) {
    pushAgain = false;
    schedulePush();
  }
}

/** Push soon. Changes until then go in the same push; a busy session list can't hold it off. */
function schedulePush(): void {
  if (pushTimer || !isRoomWriter()) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void push();
  }, ROOM_PUSH_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * The socket (re)connected. The server may have restarted (its revisions start
 * over, and its list is the saved snapshot's), so forget what was taken and
 * pushed, read the list, and push again if this window owns it.
 */
export function onRoomsSocketConnected(): void {
  lastRevision = -1;
  lastPushed = null;
  tookServerList = false;
  void fetchRooms();
  schedulePush();
}

/**
 * Watch what the writer pushes on — its rooms, its sessions (a gone session
 * leaves its room's list), presence (becoming the writer), the restore decision
 * and the socket — and settle a list held until presence arrived. For a main
 * window; returns the unsubscribe.
 */
export function startRoomSync(): () => void {
  const unsubs = [
    useRoomStore.subscribe((s, prev) => { if (s.rooms !== prev.rooms) schedulePush(); }),
    useSessionStore.subscribe((s, prev) => { if (s.sessions !== prev.sessions) schedulePush(); }),
    usePresenceStore.subscribe((s, prev) => {
      if (s.received === prev.received && s.workspaceWriter === prev.workspaceWriter) return;
      settleHeld();
      schedulePush();
    }),
    useWsStore.subscribe((s, prev) => {
      if (s.connected !== prev.connected || s.snapshotReceived !== prev.snapshotReceived) schedulePush();
    }),
    // setRestorePending mirrors the restore decision here.
    useUiStore.subscribe((s, prev) => {
      if (s.workspaceRestorePending !== prev.workspaceRestorePending) schedulePush();
    }),
  ];
  settleHeld();
  schedulePush();
  return () => {
    for (const unsub of unsubs) unsub();
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = null;
  };
}

/** Test-only: forget every revision, held list and push. */
export function _resetRoomSyncForTests(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
  lastRevision = -1;
  held = null;
  tookServerList = false;
  pushInFlight = false;
  pushAgain = false;
  lastPushed = null;
}

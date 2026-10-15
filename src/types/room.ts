// ---------------------------------------------------------------------------
// Rooms — shared by the browser's room store and the server's room mirror
// ---------------------------------------------------------------------------

export interface Room {
  id: string;
  name: string;
  sessionIds: string[];
  collapsed: boolean;
  createdAt: number;
  /** Mapped room index: 0=NW, 1=NE, 2=SW, 3=SE. Undefined = corridor.
   *
   *  This is a 3D WORLD-SPACE position, not a display-order hint — it drives
   *  `computeRoomCenter` (the room's actual walls/floor/doors in the
   *  cyberdrome), the camera-focus target in `SceneOverlay`, and the room's
   *  color in `HeaderAgentStrip`/`SessionSwitcher` (`roomIndex % PALETTE.length`).
   *  Reordering a room in a 2D list must NEVER write this field — see
   *  `listOrder` below, which exists specifically so list views have
   *  somewhere to put "order" without moving the room in the 3D scene. */
  roomIndex?: number;
  /** Display order for LIST views only (`SessionSwitcher`'s room-grouped
   *  strip) — independent of `roomIndex`. Undefined means "no explicit
   *  order yet"; the list falls back to `roomIndex` (then array order) so
   *  existing rooms don't visibly reshuffle until the user actually
   *  reorders one for the first time. Never read by anything 3D. */
  listOrder?: number;
  /** A colour the user picked (one of ROOM_COLOR_PALETTE, lib/roomColor.ts),
   *  overriding the slot colour `roomIndex` gives. Undefined = the slot
   *  colour. Picking a colour never touches `roomIndex`, so it can never move
   *  the room in the 3D scene. */
  color?: string;
}

/**
 * One room change asked for by a device that does not own the rooms (AASC-20).
 * The server checks it and hands it to the workspace writer (the Mac), which
 * applies it with its room store; the result reaches everyone as `rooms_update`.
 *
 *  - create  a new room; with `sessionId`, the session moves into it
 *  - rename  a room's name
 *  - color   a palette colour, or null for the room's slot colour
 *  - delete  the room; its sessions stay open and leave it
 *  - move    a session into a room, or out of every room (null)
 */
export type RoomOp =
  | { type: 'create'; name: string; sessionId?: string }
  | { type: 'rename'; roomId: string; name: string }
  | { type: 'color'; roomId: string; color: string | null }
  | { type: 'delete'; roomId: string }
  | { type: 'move'; sessionId: string; roomId: string | null };

/** The rooms as one device may see them, with the revision they were cut at. */
export interface RoomList {
  rooms: Room[];
  /** Newer lists replace older ones; a lower revision is a late answer. */
  revision: number;
}

/**
 * @module roomColor
 * One colour per room slot, for every surface that paints a room: the session
 * strip's room frames (SessionSwitcher), the header strip (HeaderAgentStrip, which
 * nothing mounts at present) and the LIVE board's room chips. The first two each
 * kept a copy, joined by a "must match" comment; one list means a room is the
 * same colour wherever it shows.
 *
 * The slot is `roomIndex % 8`, unless the user picked a colour (`Room.color`). `roomIndex` is a 3D world slot (see
 * `Room.roomIndex`), so two rooms eight apart share a colour, and a room with no
 * index (a corridor room) takes the first. Dependency-free.
 */

export const ROOM_COLOR_PALETTE: readonly string[] = [
  'var(--accent-orange)',
  '#4a9eff',
  'var(--accent-green)',
  'var(--accent-purple)',
  'var(--accent-yellow)',
  '#ff69b4',
  'var(--accent-cyan)',
  '#ff7043',
];

/**
 * A room's colour: the one the user picked (`Room.color`, set from the phone's
 * rooms sheet, AASC-20), else its slot's. A picked value is honoured only when
 * it is a palette entry: rooms arrive from other devices' snapshots, and this
 * string is painted into a style.
 */
export function roomColor(room: { roomIndex?: number; color?: string }): string {
  if (room.color && ROOM_COLOR_PALETTE.includes(room.color)) return room.color;
  const slots = ROOM_COLOR_PALETTE.length;
  return ROOM_COLOR_PALETTE[(((room.roomIndex ?? 0) % slots) + slots) % slots];
}

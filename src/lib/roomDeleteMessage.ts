/**
 * roomDeleteMessage.ts — the phone's "Delete room?" confirm: what happens to the room's sessions,
 * in words that agree for one and for several ("Its 1 session stays open…"). Pure.
 */
export function deleteRoomMessage(sessions: number): string {
  if (sessions === 0) return 'The room is empty.';
  return sessions === 1
    ? 'Its 1 session stays open; it just leaves the room.'
    : `Its ${sessions} sessions stay open; they just leave the room.`;
}

/**
 * @module projectLaunchRoom
 * Which room a session started from a project frame should join.
 *
 * A session the server creates has no room. In the Projects view that would be
 * invisible whenever the room filter is on: the strip keeps only sessions in the
 * selected rooms, so a launch from a frame filtered to one room would never show
 * up, and a user who thinks it failed clicks again and starts a second PTY. So
 * the new session joins the room its project's sessions are in, as the new-session
 * form does for the room it is given.
 *
 *  - One room holds the project's sessions: that one.
 *  - Several do: only when a room filter is on, and then the first of them the
 *    filter shows, because that is the one thing that keeps it on screen. With no
 *    filter the new session is visible in its frame anyway, and picking one room
 *    of several would be a guess.
 *  - None does: no room.
 *
 * Pure and dependency-free (a type import only), like the other strip helpers.
 */
import type { Room } from '@/stores/roomStore';

export function roomForNewProjectSession(
  projectSessionIds: readonly string[],
  rooms: readonly Room[],
  selectedRoomIds: ReadonlySet<string>,
): string | null {
  const ids = new Set(projectSessionIds);
  const owning = rooms.filter((room) => room.sessionIds.some((id) => ids.has(id)));

  if (owning.length === 1) return owning[0].id;
  if (owning.length > 1 && selectedRoomIds.size > 0) {
    return owning.find((room) => selectedRoomIds.has(room.id))?.id ?? null;
  }
  return null;
}

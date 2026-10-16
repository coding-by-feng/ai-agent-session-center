/**
 * phoneRoomKill.ts — kill a whole room from the phone (AASC-55, decision 3a).
 *
 * The phone stops only the room's sessions that are shared with it: the ones
 * it has. A remote device's session list and room list are both the Mac's cut
 * for it (sessionVisibility.ts, roomsMirror.ts), so a hidden session is never
 * in either; on top of that a remote phone skips any session not marked
 * `remoteVisible`, and the server answers 404 for a hidden one anyway.
 *
 * Sessions are killed one after another through the same hardened single kill
 * as everywhere else (`killOneSession`: POST /api/sessions/:id/kill, then the
 * terminal close that reaps the PTY's children).
 *
 * The summary never says how many hidden sessions the room has: the Mac does
 * not tell a remote device that number, and inferring it would reveal sessions
 * not shared with it. It says, in words, that those were left running.
 */
import type { Session } from '@/types';
import type { Room } from '@/stores/roomStore';
import { killOneSession, liveRoomSessions } from '@/lib/roomKill';

export interface RoomKillResult {
  killed: number;
  failed: number;
}

/**
 * The room's sessions this device may stop: live ones it has, and on a remote
 * device only those shared with it. On the Mac itself (`remote: false`) every
 * live session in the room.
 */
export function sharedRoomTargets(
  room: Pick<Room, 'sessionIds'>,
  sessions: ReadonlyMap<string, Session>,
  remote: boolean,
): Session[] {
  const live = liveRoomSessions(room, sessions);
  return remote ? live.filter((s) => s.remoteVisible === true) : live;
}

/** Kill `targets` one at a time (a snapshot taken before any store churn). */
export async function killSharedRoomSessions(
  targets: readonly Session[],
  killOne: (session: Session) => Promise<boolean> = killOneSession,
): Promise<RoomKillResult> {
  let killed = 0;
  for (const session of targets) {
    if (await killOne(session)) killed += 1;
  }
  return { killed, failed: targets.length - killed };
}

const sessionsWord = (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`;

/** What the phone says once the room is done. */
export function roomKillSummary(roomName: string, { killed, failed }: RoomKillResult, remote: boolean): string {
  const left = remote ? ' Sessions not shared with this phone were left running.' : '';
  if (killed === 0 && failed > 0) return `Couldn’t stop ${sessionsWord(failed)} in “${roomName}”.${left}`;
  const head = `Killed ${killed} in “${roomName}”`;
  const survived = failed > 0 ? ` · ${failed} couldn’t be stopped` : '';
  return `${head}${survived}.${left}`;
}

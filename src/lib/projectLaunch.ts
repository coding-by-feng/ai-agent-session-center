/**
 * @module projectLaunch
 * "One more Claude (or Codex) in this project": a NEW session in a project
 * frame's directory, joined to the room its project's sessions are in. The
 * desktop strip's project frames (ProjectFrameHeader) and the phone's session
 * drawer (AASC-18) both start sessions this way.
 *
 * `forceNew`: the server would otherwise hand back a live session that matches.
 * `requireExistingDir`: the server would otherwise start in the home directory
 * when the project's folder is gone. See lib/launchSession.ts.
 */
import { launchSession, type LaunchResult } from '@/lib/launchSession';
import type { ProjectGroup } from '@/lib/projectGroups';
import { roomForNewProjectSession } from '@/lib/projectLaunchRoom';
import { isPopoutWindow } from '@/lib/windowRole';
import { useRoomStore } from '@/stores/roomStore';
import { useUiStore } from '@/stores/uiStore';

export async function launchInProjectGroup(
  group: Pick<ProjectGroup, 'launchPath' | 'sessions'>,
  command: string,
): Promise<LaunchResult> {
  const result = await launchSession({
    workingDir: group.launchPath,
    command,
    forceNew: true,
    requireExistingDir: true,
  });
  // A pop-out's copy of the room list was read when it opened and may be hours
  // old; writing it back would undo the main window's edits (see useWebSocket).
  if (result.ok && result.terminalId && !result.deduplicated && !isPopoutWindow()) {
    const roomId = roomForNewProjectSession(
      group.sessions.map((s) => s.sessionId),
      useRoomStore.getState().rooms,
      useUiStore.getState().selectedRoomIds,
    );
    if (roomId) useRoomStore.getState().addSession(roomId, result.terminalId);
  }
  return result;
}

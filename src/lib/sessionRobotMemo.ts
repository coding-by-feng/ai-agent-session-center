/**
 * The equality check behind `memo(SessionRobot)`.
 *
 * A robot re-renders only when something it draws or acts on changed. Comparing the whole `session`
 * would re-render every robot on every hook event of any session; this lists the session fields whose
 * change a robot must show. (A few it reads indirectly — `cliSource`, `startupCommand`, `sshConfig`
 * feed the CLI badge — are fixed at creation, so they are left out on purpose.) A prop added to
 * `SessionRobot` that is NOT added here is silently ignored — the robot keeps drawing the old value
 * until something else makes it re-render — so `SessionRobot.tsx` carries a compile-time guard that
 * fails when the two prop lists drift.
 *
 * Lives apart from the component so it can be unit-tested without Three.js or a Canvas.
 */
import type { Session } from '@/types';

/** The `SessionRobot` props the comparator reads — structural, so the real props type fits it. */
export interface RobotMemoProps {
  session: Pick<
    Session,
    | 'sessionId'
    | 'status'
    | 'accentColor'
    | 'colorIndex'
    | 'model'
    | 'currentPrompt'
    | 'pendingTool'
    | 'characterModel'
    | 'title'
    | 'projectName'
    | 'toolLog'
    | 'events'
  >;
  sceneBound: number;
  onSelect: unknown;
  workstations: unknown;
  wallRects: unknown;
  rooms: unknown;
  doors: unknown;
  roomIndex?: number;
  globalCharacterModel: string;
  fontSize: number;
  /** Is this the robot whose session is open in the detail panel? Drives the selection marker. */
  isSelected: boolean;
  /** The scene's look (`diorama` / `cyberdrome`) — swaps the model, the label and the decals. */
  sceneStyle: string;
  /** Which clay the diorama body is painted in — follows the palette, so it changes on a theme switch. */
  clayTone: string;
}

export function sessionRobotPropsEqual(prev: RobotMemoProps, next: RobotMemoProps): boolean {
  return (
    prev.session.sessionId === next.session.sessionId &&
    prev.session.status === next.session.status &&
    prev.session.accentColor === next.session.accentColor &&
    prev.session.colorIndex === next.session.colorIndex &&
    prev.session.model === next.session.model &&
    prev.session.currentPrompt === next.session.currentPrompt &&
    prev.session.pendingTool === next.session.pendingTool &&
    prev.session.characterModel === next.session.characterModel &&
    prev.session.title === next.session.title &&
    prev.session.projectName === next.session.projectName &&
    (prev.session.toolLog?.length ?? 0) === (next.session.toolLog?.length ?? 0) &&
    (prev.session.events?.length ?? 0) === (next.session.events?.length ?? 0) &&
    prev.sceneBound === next.sceneBound &&
    prev.onSelect === next.onSelect &&
    prev.workstations === next.workstations &&
    prev.wallRects === next.wallRects &&
    prev.rooms === next.rooms &&
    prev.doors === next.doors &&
    prev.roomIndex === next.roomIndex &&
    prev.globalCharacterModel === next.globalCharacterModel &&
    prev.fontSize === next.fontSize &&
    prev.isSelected === next.isSelected &&
    prev.sceneStyle === next.sceneStyle &&
    prev.clayTone === next.clayTone
  );
}

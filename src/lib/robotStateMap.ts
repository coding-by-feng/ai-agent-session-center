/**
 * Maps SessionStatus to Robot3DState for driving 3D robot animations.
 */
import type { SessionStatus } from '@/types';

// ---------------------------------------------------------------------------
// Robot 3D State Type
// ---------------------------------------------------------------------------

export type Robot3DState =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'waiting'
  | 'alert'
  | 'input'
  | 'offline'
  | 'connecting';

// ---------------------------------------------------------------------------
// Status → Robot State Mapping
// ---------------------------------------------------------------------------

const STATUS_TO_ROBOT_STATE: Record<SessionStatus, Robot3DState> = {
  idle: 'idle',
  prompting: 'thinking',
  working: 'working',
  waiting: 'waiting',
  approval: 'alert',
  input: 'input',
  ended: 'offline',
  connecting: 'connecting',
};

export function sessionStatusToRobotState(status: SessionStatus): Robot3DState {
  return STATUS_TO_ROBOT_STATE[status] ?? 'idle';
}

// ---------------------------------------------------------------------------
// State behavior hints (for animation system)
// ---------------------------------------------------------------------------

export interface RobotStateBehavior {
  /** Should the robot seek a desk to sit at? */
  seekDesk: boolean;
  /** Should the robot wander around? */
  wander: boolean;
  /** Should the robot flash/pulse urgently? */
  urgentFlash: boolean;
  /** Visor color override (null = use neon color) */
  visorColorOverride: string | null;
  /** Animation speed multiplier */
  speedMultiplier: number;
  /** Navigate to a casual area instead of wandering (null = no casual target) */
  casualTarget: 'coffee' | null;
}

const STATE_BEHAVIORS: Record<Robot3DState, RobotStateBehavior> = {
  idle: {
    seekDesk: false,
    wander: false,
    urgentFlash: false,
    visorColorOverride: null,
    speedMultiplier: 1.0,
    casualTarget: 'coffee',
  },
  thinking: {
    seekDesk: true,
    wander: false,
    urgentFlash: false,
    visorColorOverride: null,
    speedMultiplier: 1.0,
    casualTarget: null,
  },
  working: {
    seekDesk: true,
    wander: false,
    urgentFlash: false,
    visorColorOverride: null,
    speedMultiplier: 1.2,
    casualTarget: null,
  },
  waiting: {
    seekDesk: false,
    wander: false,
    urgentFlash: false,
    visorColorOverride: null,
    speedMultiplier: 0.6,
    casualTarget: 'coffee',
  },
  alert: {
    seekDesk: false,
    wander: false,
    urgentFlash: true,
    visorColorOverride: '#ffdd00',
    speedMultiplier: 0,
    casualTarget: null,
  },
  input: {
    seekDesk: false,
    wander: false,
    urgentFlash: true,
    visorColorOverride: '#aa66ff',
    speedMultiplier: 0,
    casualTarget: null,
  },
  offline: {
    seekDesk: false,
    wander: false,
    urgentFlash: false,
    visorColorOverride: '#333344',
    speedMultiplier: 0,
    casualTarget: null,
  },
  connecting: {
    seekDesk: false,
    wander: false,
    urgentFlash: false,
    visorColorOverride: null,
    speedMultiplier: 0,
    casualTarget: null,
  },
};

export function getRobotStateBehavior(state: Robot3DState): RobotStateBehavior {
  return STATE_BEHAVIORS[state];
}

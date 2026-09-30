/**
 * WebSocket message types for AI Agent Session Center.
 * Discriminated unions for type-safe message handling.
 */

import type { Session } from './session.js';
import type { TeamSerialized } from './team.js';

// ---------------------------------------------------------------------------
// Hook Stats (broadcast via HookStatsMessage)
// ---------------------------------------------------------------------------

export interface HookTimingStats {
  avg: number;
  min: number;
  max: number;
  p95: number;
}

export interface HookEventStats {
  count: number;
  rate: number;
  latency: HookTimingStats;
  processing: HookTimingStats;
}

export interface HookStats {
  totalHooks: number;
  hooksPerMin: number;
  events: Record<string, HookEventStats>;
  sampledAt: number;
}

// ---------------------------------------------------------------------------
// Server -> Client Messages
// ---------------------------------------------------------------------------

/** Full state snapshot sent on initial WebSocket connection */
export interface SnapshotMessage {
  type: 'snapshot';
  sessions: Record<string, Session>;
  teams: Record<string, TeamSerialized>;
  seq: number;
}

/** Session state update (delta) */
export interface SessionUpdateMessage {
  type: 'session_update';
  session: Session;
  team?: TeamSerialized;
}

/** Session removed from memory */
export interface SessionRemovedMessage {
  type: 'session_removed';
  sessionId: string;
}

/**
 * A session's SHARED prompt queue changed on some device.
 *
 * Carries the full items + automation rather than a "go re-fetch" nudge, so a
 * receiving device applies it with no follow-up request. `originClientId` is
 * the sender's device id, echoed back by the server so the sender can ignore
 * its own broadcast instead of re-saving it in a loop.
 */
export interface QueueUpdateMessage {
  type: 'queue_update';
  sessionId: string;
  items: unknown[];
  automation: unknown | null;
  updatedAt: number;
  originClientId: string | null;
}

/** Team structure update */
export interface TeamUpdateMessage {
  type: 'team_update';
  team: TeamSerialized;
}

/** Hook performance statistics */
export interface HookStatsMessage {
  type: 'hook_stats';
  stats: HookStats;
}

/** Terminal output data (base64-encoded from SSH pty) */
export interface TerminalOutputMessage {
  type: 'terminal_output';
  terminalId: string;
  data: string;
}

/** Terminal is ready for input */
export interface TerminalReadyMessage {
  type: 'terminal_ready';
  terminalId: string;
}

/** Terminal has been closed */
export interface TerminalClosedMessage {
  type: 'terminal_closed';
  terminalId: string;
  reason?: string;
}

/** Signal to browsers to clear their IndexedDB */
export interface ClearBrowserDbMessage {
  type: 'clearBrowserDb';
}

// ---------------------------------------------------------------------------
// Multi-device presence
// ---------------------------------------------------------------------------

/** A device with at least one open WebSocket. */
export interface DevicePresence {
  clientId: string;
  label: string;
  address: string;
  /** True when connected over loopback — the desktop app or a local browser. */
  isLocal: boolean;
  connections: number;
  connectedAt: number;
  lastSeenAt: number;
}

/** Who holds the write baton for one session. */
export interface ControlHolderView {
  sessionId: string;
  clientId: string;
  label: string;
  since: number;
  lastActivityAt: number;
  /** False when the holder has disconnected — the session is then free to take. */
  online: boolean;
}

/** Full presence state; sent on connect and on every device/baton change. */
export interface PresenceUpdateMessage {
  type: 'presence_update';
  devices: DevicePresence[];
  controllers: ControlHolderView[];
  /** Device that owns the one-shot workspace restore for this server lifetime. */
  restoreOwner: string | null;
  /** The single device permitted to persist the shared workspace snapshot. */
  workspaceWriter: string | null;
}

/**
 * This client tried to write to a session another device controls. Throttled
 * server-side (once per session per few seconds) because `terminal_input`
 * fires per keystroke.
 */
export interface ControlDeniedMessage {
  type: 'control_denied';
  sessionId: string;
  terminalId: string;
  by: string | null;
  byClientId: string | null;
}

/** Another device is asking the current holder to hand over a session. */
export interface ControlRequestedMessage {
  type: 'control_requested';
  sessionId: string;
  fromClientId: string;
  fromLabel: string;
  /** The holder being asked — other clients ignore the message. */
  toClientId: string;
}

/** Union of all server-to-client messages */
export type ServerMessage =
  | SnapshotMessage
  | SessionUpdateMessage
  | SessionRemovedMessage
  | QueueUpdateMessage
  | TeamUpdateMessage
  | HookStatsMessage
  | TerminalOutputMessage
  | TerminalReadyMessage
  | TerminalClosedMessage
  | ClearBrowserDbMessage
  | PresenceUpdateMessage
  | ControlDeniedMessage
  | ControlRequestedMessage;

// ---------------------------------------------------------------------------
// Client -> Server Messages
// ---------------------------------------------------------------------------

/** Send terminal input data */
export interface TerminalInputMessage {
  type: 'terminal_input';
  terminalId: string;
  data: string;
}

/** Resize terminal dimensions */
export interface TerminalResizeMessage {
  type: 'terminal_resize';
  terminalId: string;
  cols: number;
  rows: number;
}

/** Disconnect (close) a terminal */
export interface TerminalDisconnectMessage {
  type: 'terminal_disconnect';
  terminalId: string;
}

/** Subscribe to terminal output */
export interface TerminalSubscribeMessage {
  type: 'terminal_subscribe';
  terminalId: string;
}

/** Update the prompt queue count for a session */
export interface UpdateQueueCountMessage {
  type: 'update_queue_count';
  sessionId: string;
  count: number;
}

/** Replay missed events since a sequence number */
export interface ReplayMessage {
  type: 'replay';
  sinceSeq: number;
}

/** Union of all client-to-server messages */
export type ClientMessage =
  | TerminalInputMessage
  | TerminalResizeMessage
  | TerminalDisconnectMessage
  | TerminalSubscribeMessage
  | UpdateQueueCountMessage
  | ReplayMessage;

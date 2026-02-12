/**
 * WebSocket message types for AI Agent Session Center
 */

import type { Session, HandleEventResult } from './session';

// ---- Team info (serialized) ----

export interface TeamInfo {
  teamId: string;
  parentSessionId: string;
  childSessionIds: string[];
  teamName: string | null;
  createdAt: number;
}

// ---- Server → Client messages ----

/** Full state snapshot sent on initial connection */
export interface SnapshotMessage {
  type: 'snapshot';
  sessions: Record<string, Session>;
  teams: Record<string, TeamInfo>;
  seq: number;
}

/** Session state update (delta) */
export interface SessionUpdateMessage {
  type: 'session_update';
  session: Session;
  team?: TeamInfo;
}

/** Session removed from memory */
export interface SessionRemovedMessage {
  type: 'session_removed';
  sessionId: string;
}

/** Team structure update */
export interface TeamUpdateMessage {
  type: 'team_update';
  team: TeamInfo;
}

/** Hook performance statistics */
export interface HookStatsMessage {
  type: 'hook_stats';
  stats: HookStats;
}

/** Terminal output data (from SSH pty) */
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
}

/** Signal to browsers to clear their IndexedDB */
export interface ClearBrowserDbMessage {
  type: 'clearBrowserDb';
}

/** Union of all server-to-client messages */
export type ServerMessage =
  | SnapshotMessage
  | SessionUpdateMessage
  | SessionRemovedMessage
  | TeamUpdateMessage
  | HookStatsMessage
  | TerminalOutputMessage
  | TerminalReadyMessage
  | TerminalClosedMessage
  | ClearBrowserDbMessage;

// ---- Client → Server messages ----

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

// ---- Hook stats shape (broadcast via HookStatsMessage) ----

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

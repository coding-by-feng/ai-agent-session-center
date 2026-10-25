/**
 * Central-session types shared by the server (server/mcp/) and the client.
 *
 * A central is an agent session AASC launched with an MCP token, so it can read and drive other
 * sessions through the server's /mcp endpoint. These two types are the part of that the rest of the
 * app sees: what a central can reach, and the marker a terminal config and a session card carry.
 * Everything else (the registry record, the token) stays in server/mcp/types.ts.
 */

/** What a central can reach: every session, one room's, or one project folder's. */
export type CentralKind = 'global' | 'room' | 'project';

/**
 * What a session carries to say "I am a central". It survives the re-key from `term-*` to the
 * CLI's own session id, so the registry can still find the central behind a renamed session.
 * `scopeRef` is the room id or the normalized project folder; null for a global central.
 */
export interface SessionCentralMarker {
  centralId: string;
  kind: CentralKind;
  scopeRef: string | null;
}

/**
 * Start the session as a central: POST /api/terminals' `central`. A room central names its room; a
 * project central's folder defaults to the launch's own. `centralId` is only for a relaunch of one that
 * already exists (a session's own marker can be sent as it is).
 */
export interface CentralLaunchRequest {
  kind: CentralKind;
  scopeRef?: string | null;
  centralId?: string;
}

/**
 * One live central as the dashboard sees it: a row of GET /api/mcp/centrals and of the `centrals_update`
 * message. The server builds it field by field (server/mcp/http.ts), so it carries no token, no terminal
 * id and nothing else the registry holds. `sessionId` is the card the central runs in, as found when the
 * list was read or sent: null until the card exists, and the list is not sent again when the card appears.
 * A window that wants the card of a central reads the `central` marker on the card itself.
 */
export interface CentralSummary {
  centralId: string;
  kind: CentralKind;
  scopeRef: string | null;
  cli: 'claude' | 'codex';
  sessionId: string | null;
  toolsets: string[];
  createdAt: number;
  /** How many of the sessions this central opened itself are live (P4); 0 from a server older than P4. */
  workerCount: number;
}

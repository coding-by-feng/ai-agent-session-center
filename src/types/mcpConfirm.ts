/**
 * Central-session (server/mcp) confirmations as this Mac's own windows see them (server/mcp/confirm.ts).
 * Shared by the server and the client, so the two cannot drift.
 *
 * Both messages are local-only broadcasts and carry no token, no confirmId (the central's id) and no arguments:
 *   - `mcp_confirm`           a tool asked the person; the card to show
 *   - `mcp_confirm_resolved`  that card was answered, expired or withdrawn
 */
import type { McpRisk } from './mcpEvents.js';
export const MCP_CONFIRM = 'mcp_confirm' as const;
export const MCP_CONFIRM_RESOLVED = 'mcp_confirm_resolved' as const;
export type McpConfirmState = 'pending' | 'allowed' | 'denied' | 'expired';
/** A confirmation as this Mac's windows see it: never the central's confirmId, never the call's arguments. */
export interface McpConfirmView {
  cardId: string; centralId: string; tool: string; risk: McpRisk;
  summary: string;            // AASC's words, <= 300
  detail: string | null;      // central-written text the person judges, <= 2000, shown verbatim
  targetSessionId: string | null; createdAt: number; expiresAt: number;
}
export interface McpConfirmMessage { type: typeof MCP_CONFIRM; confirm: McpConfirmView }
export interface McpConfirmResolvedMessage { type: typeof MCP_CONFIRM_RESOLVED; cardId: string; state: Exclude<McpConfirmState, 'pending'> }

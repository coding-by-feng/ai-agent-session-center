/**
 * Central-session (server/mcp) confirmations as a paired phone sees them (P5-15, server/mcp/phoneConfirmRoutes.ts).
 * Shared by the server and the client, so the two cannot drift.
 *
 * Only cards a phone may answer reach it: the tool is phone-answerable and the central's card (and its target,
 * when it has one) is shared. Both messages carry no token, no confirmId and no arguments:
 *   - `mcp_phone_confirm`           a tool asked the person; the card to show on the phone
 *   - `mcp_phone_confirm_resolved`  that card was answered, expired or withdrawn
 */
import type { McpConfirmState, McpConfirmView } from './mcpConfirm.js';
export const MCP_PHONE_CONFIRM = 'mcp_phone_confirm' as const;
export const MCP_PHONE_CONFIRM_RESOLVED = 'mcp_phone_confirm_resolved' as const;
/** A card a paired phone may answer (P5-15): the same view the Mac gets, never a confirmId or arguments. */
export interface McpPhoneConfirmMessage { type: typeof MCP_PHONE_CONFIRM; confirm: McpConfirmView }
export interface McpPhoneConfirmResolvedMessage { type: typeof MCP_PHONE_CONFIRM_RESOLVED; cardId: string; state: Exclude<McpConfirmState, 'pending'> }

/**
 * phoneAiScopes — the `data-ai-selectable` scope ids of the phone's AI-popup
 * surfaces that aren't a chat (AASC-57). A chat's scope is its session id; these
 * are prefixed so they can never be one. Import-free.
 */

/** A session's open project file. */
export const phoneFileAiScope = (sessionId: string): string => `file:${sessionId}`;

/** A terminal's text (the "Ask AI about the terminal" sheet). */
export const phoneTerminalAiScope = (terminalId: string): string => `terminal:${terminalId}`;

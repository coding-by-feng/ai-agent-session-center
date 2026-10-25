// types.ts — shared types, constants and the error class for the central-session MCP server
// (server/mcp/). Every other module in this folder imports from here. It imports only the two
// types the client shares (src/types/central.ts), which it re-exports so they can be had from here too.

import type { SessionCentralMarker } from '../../src/types/central.js';

export type { CentralKind, SessionCentralMarker } from '../../src/types/central.js';

// ---------------------------------------------------------------------------
// Toolsets
// ---------------------------------------------------------------------------

/** The one list of toolset names; `Toolset` is derived from it so the two cannot drift. */
const TOOLSET_NAMES = [
  'sessions',
  'conversation',
  'prompts',
  'tasks',
  'requests',
  'queue',
  'rooms',
  'resources',
  'skillNotes',
  'snippets',
  'history',
  'notes',
  'agenda',
  'cloud',
  'system',
] as const;

/** A group of tools a central can be given. Every tool belongs to exactly one. */
export type Toolset = (typeof TOOLSET_NAMES)[number];

/** Every toolset. A Claude central gets all of them by default. */
export const ALL_TOOLSETS: readonly Toolset[] = Object.freeze([...TOOLSET_NAMES]);

/** The toolsets every central gets first; a Codex central starts from these. */
export const CORE_TOOLSETS: readonly Toolset[] = Object.freeze<Toolset[]>([
  'sessions',
  'conversation',
  'prompts',
  'tasks',
  'requests',
  'queue',
  'system',
]);

// ---------------------------------------------------------------------------
// Tools and centrals
// ---------------------------------------------------------------------------

/**
 * What a tool can do, which decides its MCP annotations and whether it waits for a person:
 * `read` changes nothing; `write` changes AASC's own state; `steers` types into, or queues work
 * for, another session; `ask`, `destructive` and `outward` wait for the person's OK on the Mac
 * or phone (`outward` leaves the Mac).
 */
export type Risk = 'read' | 'write' | 'steers' | 'ask' | 'destructive' | 'outward';

/**
 * The risks that wait for the person (Ruling P5-2): runTool.ts's gate asks every tool of these, and only these, what
 * the person is asked (`ToolDef.confirm`). One without `confirm` is refused, so a new risk of this kind fails closed.
 */
export const WAITS_FOR_PERSON: ReadonlySet<Risk> = new Set<Risk>(['ask', 'destructive', 'outward']);

/** The agent CLIs a central can run as. */
export type CliKind = 'claude' | 'codex';

/** The delivery phase of a tool; a build only exposes tools up to its `MCP_MAX_PHASE`. */
export type Phase = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The last phase this build exposes. P1 SEE: the read tools. P2 DELIVER: send, delegate, answer, queue writes.
 * P3 ORGANIZE: session_create, the card writes and relaunches, rooms, keys, the library writes, and the confirmation
 * an `ask` tool waits on (confirm.ts, `confirm_wait`). P4 AUTOMATE: project_resolve, task_route and task_delegate's `to: "auto"`.
 * P5 CONTROL: interrupt, restart, kill and close, queue_clear, the resource uninstall and restore and the deletes, each
 * behind the person's card (every risk in WAITS_FOR_PERSON). P6 CLOUD: the 25 cloud changes (publish, install, sync,
 * jobs, project records and git, aliases, remote access), global-only, each outward one behind a Mac card naming the
 * account that acts. Here, not in registry.ts (which re-exports it), so a tool module can read it without an import
 * cycle (scope_get's playbook).
 */
export const MCP_MAX_PHASE: Phase = 6;

/** A live central: its marker plus how it was launched and the token it calls /mcp with. */
export interface CentralRecord extends SessionCentralMarker {
  cli: CliKind;
  permissionMode: string | null;
  toolsets: Toolset[];
  token: string;
  terminalId: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Why a tool call was refused or failed. The central reads the code; the text is for it too. */
export type ToolErrorCode =
  | 'NOT_IN_SCOPE'
  | 'HANDS_OFF'
  | 'HUMAN_ACTIVE'
  | 'BUSY'
  | 'NO_WINDOW'
  | 'BUDGET'
  | 'NEEDS_CONFIRMATION'
  | 'DENIED'
  | 'NOT_FOUND'
  | 'INVALID'
  | 'UPSTREAM'
  | 'UNAVAILABLE';

/**
 * A tool call that cannot go ahead. Thrown by tools and by the helpers they call; the MCP server
 * turns it into an `isError` result carrying `code`, `message` and `hint`. The message and hint
 * are read by a model: say what happened and, in the hint, what to do instead.
 * `message` defaults to the code when a caller has nothing more to say.
 * `data` holds the facts a central acts on (Ruling 66: Claude Code shows the model `structuredContent` only), such as
 * NEEDS_CONFIRMATION's `{ confirmId, expiresAt }`: flat AASC-made values, never an argument the central sent.
 */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly hint?: string;
  readonly data?: Readonly<Record<string, string | number | null>>;

  constructor(code: ToolErrorCode, message?: string, hint?: string, data?: Readonly<Record<string, string | number | null>>) {
    super(message ?? code);
    this.name = 'ToolError';
    this.code = code;
    this.hint = hint;
    if (data !== undefined) this.data = Object.freeze({ ...data });
  }
}

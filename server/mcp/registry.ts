// registry.ts — what a tool is, and which tools a central is given.
//
// Every tool is a `ToolDef`: a name, the toolset it belongs to, its risk and delivery phase, a zod input
// shape and a `run`. The tools themselves live one module per toolset under tools/, filed by toolset in
// tools/index.ts; this module only reads that list. A central is given the tools of its own toolsets
// whose phase this build has reached (`MCP_MAX_PHASE`).
//
// Tool modules import from here with `import type` only: tools/index.ts is imported by this module, so a
// runtime import back into it would be a cycle.

import type { z } from 'zod';
import type { Room } from '../../src/types/room.js';
import type { Session } from '../../src/types/session.js';
import type { ActivityNote } from './activity.js';
import type { InternalClient } from './client.js';
import type { ConfirmState } from './confirm.js';
import type { EventHub } from './events.js';
import type { Ledger } from './ledger.js';
import { toolsByToolset } from './tools/index.js';
import { ALL_TOOLSETS, WAITS_FOR_PERSON, type CentralRecord, type Phase, type Risk, type Toolset } from './types.js';
import type { WorkersView } from './workers.js';

/** The last phase this build exposes (types.ts says what each phase brings). */
export { MCP_MAX_PHASE } from './types.js';

/** What a tool's `run` answers: the data (sent as `structuredContent.data`) and a short line of text for the model. */
export interface ToolResult {
  data: unknown;
  summary: string;
  /**
   * For a non-read tool: what to write to the activity log, one row per note (a fan-out gives one per session).
   * Without notes, runTool writes one row in the tool's title. Never seen by the central; ignored for a read.
   */
  activity?: readonly ActivityNote[];
}

/**
 * What a waiting tool's `confirm` says the person is asked (Ruling P3-5): AASC's own words (`summary`, <= 300), the
 * central-written text the person judges, shown as written (`detail`, <= 2 000), and the session it is about.
 */
export interface ConfirmAsk {
  summary: string;
  detail?: string | null;
  targetSessionId?: string | null;
  /**
   * What the card is about as AASC sees it now (Ruling P5-3), AASC-made only: the target's terminal id, a queue's item
   * ids, a resource's id and path, a note's id (past 200 characters the book keeps a digest of the whole). After the
   * person allows, the gate asks `confirm` again and runs nothing when this, `targetSessionId` or `summary` changed
   * (Ruling P5-34). Never shown to anyone.
   */
  fingerprint?: string;
}

/** A confirmation's state as a tool sees it: its id (the central's), where it stands, when it expires. */
export interface ConfirmWaited {
  confirmId: string;
  state: ConfirmState;
  expiresAt: number;
  /** Still pending, and a paired phone may answer it too (phoneAnswerable.ts): NEEDS_CONFIRMATION says so (P5-25). */
  phone?: boolean;
}

/** The confirmation book as one call sees it (confirm.ts): the calling central's own records only. */
export interface ToolConfirms {
  /**
   * Waits (at most 50 s, and never past `ctx.signal`) for the person's answer to the central's confirmation
   * `confirmId` (undefined: its newest). NOT_FOUND for one that is not the central's, or is long gone.
   */
  wait(confirmId: string | undefined, timeoutMs: number): Promise<ConfirmWaited>;
  /**
   * Carries out an allowed confirmation once, with the arguments the person saw, through runTool (so the tool's own
   * checks run now). INVALID when it was used already or was not allowed; UNAVAILABLE when the tool is no longer the
   * central's.
   */
  runApproved(confirmId: string): Promise<ToolResult>;
}

/** How `mayEdit` asks. */
export interface EditOptions {
  /** The card is only the source of a fork or a clone, and left alone: hands-off is not asked (policy.ts). */
  asSource?: boolean;
}

/** How `mayDrive` asks. */
export interface DriveOptions {
  /**
   * The calling central's own task in that session: its lock is not a BUSY refusal (an answer to its own worker's
   * dialog, the cancel of its own task). Another central's task, or none, still is.
   */
  ownTaskId?: string;
  /** Ask only: a refusal is not written to the activity log (the caller says what it did instead). */
  quiet?: boolean;
  /**
   * The session is this child central's own card, and the task is handed down to it (Ruling P4-8): the policy's
   * hand-off rails (policy.ts `assertMayHandOff`: a global caller, a room or project child) instead of a steer's.
   */
  handOffTo?: CentralRecord;
}

/**
 * What a tool runs with, built fresh for each call. It holds nothing from the HTTP request but the call's
 * abort signal: never its headers, which carry the central's bearer token.
 *
 * Scope rule: a tool that answers about a session, or acts on one, takes it from `scopedSessions()` or
 * `resolveTarget` (tools/define.ts), or checks `inScope` before it answers: the one rule all three apply.
 * `sessions()` is for the few tools that need every session whatever the scope (a count, a health line), and
 * nothing they return may describe one out of scope.
 *
 * Steering rule: before a tool types into another session, hands it a task or queues work for it, it calls
 * `mayDrive(session)`, and records tasks through `ledger`.
 */
export interface ToolContext {
  /**
   * The calling central as the registry holds it at the moment of the call, with its token blanked
   * (`''`): a tool never needs the token, so it never has it.
   */
  central: CentralRecord;
  /** The loopback /api client, calling as `mcp:<centralId>`. */
  client: InternalClient;
  /**
   * The sessions in this central's scope now (scope.ts, with the current rooms), as shallow copies: a tool
   * cannot change the store through them. The default for every tool.
   */
  scopedSessions(): Session[];
  /** Every session AASC holds now, in scope or not, as shallow copies. See the scope rule above. */
  sessions(): Session[];
  /** The Mac's whole room list now. UNSCOPED: a tool that shows rooms to a room or project central filters them. */
  rooms(): Room[];
  /**
   * Every live central now, as copies with the token blanked (`''`). UNSCOPED, like `rooms()`: a global
   * central may see them all, any other only itself (central_list).
   */
  centrals(): CentralRecord[];
  /** Every broadcast AASC sends, in or out of this central's scope: a tool that waits filters with `inScope`. */
  events: EventHub;
  now(): number;
  /**
   * Aborted when the central cancels the call or its MCP session closes. Pass it to `events.waitFor`, and to
   * anything else that waits, so a wait ends with the call.
   */
  signal: AbortSignal;
  /**
   * Is this session in the central's scope now? THE scope rule (scope.ts `scopePredicate`): the rooms as they are
   * at each check, plus the workers the central opened itself (workers.ts), filed into a room yet or not.
   * `scopedSessions`, `resolveTarget` and session_wait's matcher all apply this one.
   */
  inScope(session: Session): boolean;
  /**
   * The sessions this central opened itself (workers.ts, by terminal id), as they are at each check: bound to the
   * calling central, so another central's id answers false, none and 0. Its own worker is let through the unattended
   * lock (unattended.ts) and gets its queued prompts on.
   */
  workers: WorkersView;
  /**
   * The current id of a session id that may be stale (a re-key from term-* to the CLI's id, a workspace restore),
   * following AASC's alias chain; null when no session has it. Not scope-checked.
   */
  resolveSessionId(id: string): string | null;
  /**
   * The task ledger (ledger.ts), seen as this central: its own tasks only, recorded as itself, the envelope
   * labelled with its room or folder. The lock (`isLocked`, `create`'s BUSY) spans every central.
   */
  ledger: Ledger;
  /**
   * May this central steer this session now? Returns, or throws the policy's refusal (policy.ts `SteerRefusal`:
   * NOT_IN_SCOPE, INVALID, HANDS_OFF, HUMAN_ACTIVE, BUSY), live presence, the person's Esc hold and the ledger's lock
   * included. A refusal is written to the activity log as it is thrown (unless `quiet`), so a tool that catches it
   * (a fan-out) need not log it again.
   */
  mayDrive(session: Session, opts?: DriveOptions): void;
  /**
   * May this central write this session's card (title, remark, pin, room …; Ruling P3-7)? The policy's
   * `assertMayEditCard`: NOT_IN_SCOPE, INVALID (its kind), HANDS_OFF (not `asSource`). Logged once, like `mayDrive`.
   */
  mayEdit(session: Session, opts?: EditOptions): void;
  /**
   * May this central relaunch this ended card in place (resume, reconnect; Ruling P3-8)? The policy's
   * `assertMayRelaunch`: scope, kind, ended, then hands-off, a person and the lock. Logged once, like `mayDrive`.
   */
  mayRelaunch(session: Session): void;
  /**
   * May this central end this session (interrupt, restart, kill or close; Ruling P5-8)? The policy's `assertMayEnd`:
   * NOT_IN_SCOPE, INVALID (its kind, an ended card allowed), then HANDS_OFF, HUMAN_ACTIVE and BUSY for another central's
   * task (the caller's own task does not block: the person is asked). Logged once, like `mayDrive`.
   */
  mayEnd(session: Session): void;
  /**
   * True only while this run carries out a confirmation the person allowed (within the gate's wait, or through
   * `confirm_wait`); false for a run whose `confirm` needed no card, and for every tool that does not wait. A tool with
   * a no-card exemption (P5-4) checks it at run time: an exempt call whose card needs asking now is refused.
   */
  allowedByPerson(): boolean;
  /** The calling central's confirmations (confirm.ts): `confirm_wait` waits on one and carries it out. */
  confirms: ToolConfirms;
}

export interface ToolDef {
  /** `<domain>_<verb>`, as the catalog names it; Claude Code shows it as `mcp__aasc__<name>`. */
  name: string;
  toolset: Toolset;
  title: string;
  /** Read by the model: what the tool does and when to reach for it. */
  description: string;
  risk: Risk;
  phase: Phase;
  /** The arguments, as a zod raw shape; `{}` for a tool that takes none. Checked before `run` is called. */
  input: z.ZodRawShape;
  /** Calling it twice with the same arguments does what calling it once does (a setter). */
  idempotent?: boolean;
  /**
   * Required when the risk waits for the person (`ask`, `destructive`, `outward`: WAITS_FOR_PERSON), and only then: what
   * the person is asked before `run` runs (runTool.ts's gate), or null when this call needs no card (turning sharing
   * off, an own idle worker's close). It may refuse (a ToolError) before any card opens: an out-of-scope target is
   * refused here, not asked about. After the person allows, the gate calls it again with the same arguments (P5-3).
   */
  confirm?(args: Record<string, unknown>, ctx: ToolContext): ConfirmAsk | null | Promise<ConfirmAsk | null>;
  /**
   * Runs the tool with arguments that already passed `input`. Throw a `ToolError` to refuse with a code
   * and a hint; any other error reaches the central as `UPSTREAM`, its details kept in the server log.
   */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * The tools that break the confirmation rule, by name: every tool whose risk waits for the person (WAITS_FOR_PERSON)
 * defines `confirm`, and no other tool does (runTool's gate asks `confirm` of those risks only, so another tool's would
 * be a question nobody asks).
 */
export function confirmRuleViolations(tools: readonly ToolDef[]): string[] {
  return tools.filter((t) => WAITS_FOR_PERSON.has(t.risk) !== (typeof t.confirm === 'function')).map((t) => t.name);
}

/** Every tool in this build, every phase, in toolset order; a new array each call. */
export function allTools(): ToolDef[] {
  return ALL_TOOLSETS.flatMap((toolset) => [...toolsByToolset[toolset]]);
}

/**
 * The tools a central is given: those of its own toolsets whose phase is `maxPhase` or earlier, in the
 * order `tools` lists them. `tools` defaults to every registered tool; the endpoint passes its own list
 * (`McpDeps.tools`), which is how tests give a central stub tools.
 */
export function toolsFor(
  central: Pick<CentralRecord, 'toolsets'>,
  maxPhase: Phase,
  tools: readonly ToolDef[] = allTools(),
): ToolDef[] {
  const on = new Set<Toolset>(central.toolsets);
  return tools.filter((tool) => on.has(tool.toolset) && tool.phase <= maxPhase);
}

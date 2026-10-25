// policy.ts — who a central may steer: the rails every P2 write checks before it types into another session or
// hands it work. Reads never come here; scope alone decides what a central may read (scope.ts).
//
// `assertMaySteer` refuses in a fixed order, so a refusal says no more than it must:
//   NOT_IN_SCOPE  the session is outside the central's scope (first: nothing else is said about such a session)
//   INVALID       a session a central never steers: itself, another central, an ops shell, a subagent, a floating
//                 fork, an external card, an SSH session, one with no terminal, one that has ended
//   HANDS_OFF     the person marked it hands-off (`session.handsOff`)
//   HUMAN_ACTIVE  a person drove it less than 60 s ago (its presence controller is not an `mcp:` client), or the
//                 person stopped it with Esc and has not prompted it since (`userCancelledAt`, Ruling 47; the stamp
//                 a central's own Esc causes is not the person's: escHold.ts, `centralEscAt`)
//   BUSY          it holds a task a central gave it (the ledger's lock, which spans every central)
//
// The one exception to "never another central" (Ruling P4-8): a global central may hand a task down to a room or
// project central, into that central's own card (`assertMayHandOff`). INVALID for any other pair, or for a session that
// is not the child's live card on this Mac with a terminal; then the same HANDS_OFF, HUMAN_ACTIVE and BUSY rails.
//
// Two P3 rails reuse the same list: `assertMayEditCard` (a card write, Ruling P3-7: scope, the kinds without the
// terminal and ended checks, hands-off) and `assertMayRelaunch` (a resume or reconnect, P3-8: scope, the kinds, ended
// only, then hands-off, the person and the lock). So does P5's `assertMayEnd` (an interrupt, restart, kill or close,
// Ruling P5-8: scope, the kinds without the terminal and ended checks, then hands-off, the person and the lock; the
// context leaves the caller's own task out of the lock, since the person is asked).
//
// Every refusal is a `SteerRefusal`: a ToolError that also carries the refused session's id, for the activity
// log only. Its words never name the session or repeat anything the central sent.
//
// Pure: nothing here reads a store or the clock; the context hands in what it needs.

import type { Session } from '../../src/types/session.js';
import { stripLeadingRun } from './commandRules.js';
import { isEscHeld } from './escHold.js';
import { isLocalSession } from './scope.js';
import { ToolError, type CentralRecord, type ToolErrorCode } from './types.js';

/** How long after a person last drove a session no central may type into it. */
export const HUMAN_ACTIVE_MS = 60_000;

/** The most sessions one call may steer. */
export const MAX_FAN_OUT = 8;

/** What a central's own calls carry as their presence client id (`mcp:<centralId>`); anything else is a person. */
export const MCP_CLIENT_PREFIX = 'mcp:';

/** Who drove a session last (presenceManager's `getController`), as far as the policy needs it. */
export interface SessionController {
  clientId: string;
  lastActivityAt: number;
}

/** What the policy is told about the world, by the context of one call. */
export interface SteerContext {
  /** The central's one scope rule (ToolContext.inScope). */
  inScope(session: Session): boolean;
  /** Who drove the session last, or null when nobody has. */
  controller(sessionId: string): SessionController | null;
  /** Does the session hold a central's task (the ledger's lock)? */
  isLocked(sessionId: string): boolean;
  /** Is this terminal a session's ops shell (its blank "Commands Terminal")? */
  isOpsTerminal(terminalId: string): boolean;
  /**
   * When a central last pressed Esc in the session or its terminal (escHold.ts), or null. Left out: never, so any
   * cancel stamp on the session holds it.
   */
  centralEscAt?(sessionId: string, terminalId: string | null): number | null;
  now(): number;
}

/** A refusal to steer a session. `sessionId` is for the activity log; it is never part of the words. */
export class SteerRefusal extends ToolError {
  readonly sessionId: string;

  constructor(code: ToolErrorCode, message: string, hint: string, sessionId: string) {
    super(code, message, hint);
    this.name = 'SteerRefusal';
    this.sessionId = sessionId;
  }
}

const PICK_ANOTHER = 'Pick another session (session_list shows them).';

/** Throws a `SteerRefusal` about `session`. */
const refuserFor =
  (session: Session) =>
  (code: ToolErrorCode, message: string, hint: string): never => {
    throw new SteerRefusal(code, message, hint, session.sessionId);
  };

/** What a central does to a session, for the words of a kind refusal. */
type Act = 'steers' | 'edits' | 'relaunches' | 'ends';

/**
 * Why a central never acts on this session, by its kind alone, in AASC's words; null when it may as far as its kind
 * goes: itself (its marker, or its own terminal), another central, an ops shell, a subagent, a floating popup, an
 * external card, an SSH card. Every rail asks this; a steer also asks `liveRefusal`.
 */
function kindRefusal(central: CentralRecord, s: Session, ctx: SteerContext, act: Act = 'steers'): { message: string; hint: string } | null {
  const marker = s.central;
  const itsTerminal = central.terminalId !== null && s.terminalId === central.terminalId;
  if (marker?.centralId === central.centralId || itsTerminal) {
    return { message: `A central never ${act} itself.`, hint: PICK_ANOTHER };
  }
  if (marker) {
    return { message: `That session is another central: a central never ${act} one.`, hint: PICK_ANOTHER };
  }
  if (s.terminalId && ctx.isOpsTerminal(s.terminalId)) {
    return { message: 'That is a session’s command shell, not an agent.', hint: PICK_ANOTHER };
  }
  if (s.isSubagent) {
    const instead = act === 'steers' ? 'steer the session that runs it instead' : 'it belongs to the session that runs it';
    return { message: `That is a subagent: ${instead}.`, hint: PICK_ANOTHER };
  }
  if (s.isFloating) {
    return { message: 'That is a floating AI popup, not a session a central steers.', hint: PICK_ANOTHER };
  }
  if (s.isExternal) {
    return {
      message: 'AASC did not start that session (an external card): it has no terminal AASC types into.',
      hint: PICK_ANOTHER,
    };
  }
  if (!isLocalSession(s)) {
    return { message: 'That session runs on another machine (SSH): centrals steer sessions on this Mac only.', hint: PICK_ANOTHER };
  }
  return null;
}

/** What a steer asks beyond the kind: a terminal to type into, and a session that has not ended. */
function liveRefusal(s: Session): { message: string; hint: string } | null {
  if (!s.terminalId) {
    return { message: 'That session has no terminal to type into.', hint: `Ask the person to reconnect it, or pick another session.` };
  }
  if (s.status === 'ended') {
    return { message: 'That session has ended.', hint: PICK_ANOTHER };
  }
  return null;
}

/**
 * May `central` steer `session` now (type into it, hand it a task, queue work for it)? Returns when it may;
 * throws a `SteerRefusal` in the order the header gives when it may not.
 */
export function assertMaySteer(central: CentralRecord, session: Session, ctx: SteerContext): void {
  const refuse = refuserFor(session);
  if (!ctx.inScope(session)) {
    refuse('NOT_IN_SCOPE', 'That session is outside your scope.', 'Call session_list to see the sessions you can reach.');
  }
  const kind = kindRefusal(central, session, ctx) ?? liveRefusal(session);
  if (kind !== null) refuse('INVALID', kind.message, kind.hint);
  assertPersonRails(session, ctx);
}

/** How `assertMayEditCard` asks. */
export interface EditCardOptions {
  /**
   * The card is only read, as the source of a fork or a clone, and left as it is: hands-off (which keeps centrals off
   * a card) is not asked. Scope and the kinds still are.
   */
  asSource?: boolean;
}

/**
 * May `central` write `session`'s card (its title, remark, pin, mute, alert, colour, model, popup, sharing, room;
 * Ruling P3-7)? NOT_IN_SCOPE, then INVALID for the kinds a central never touches (its own card included), then
 * HANDS_OFF (not for `asSource`). Nothing is typed, so neither the 60 s rule, the Esc hold nor the lock is asked, and
 * an ended card, or one with no terminal, may be written.
 */
export function assertMayEditCard(
  central: CentralRecord,
  session: Session,
  ctx: SteerContext,
  opts: EditCardOptions = {},
): void {
  const refuse = refuserFor(session);
  if (!ctx.inScope(session)) {
    refuse('NOT_IN_SCOPE', 'That session is outside your scope.', 'Call session_list to see the sessions you can reach.');
  }
  const kind = kindRefusal(central, session, ctx, 'edits');
  if (kind !== null) refuse('INVALID', kind.message, kind.hint);
  if (opts.asSource !== true && session.handsOff === true) refuse('HANDS_OFF', HANDS_OFF_WORDS, HANDS_OFF_HINT);
}

/**
 * May `central` relaunch `session` in place (a resume, a reconnect; Ruling P3-8)? NOT_IN_SCOPE, INVALID for the
 * kinds, INVALID while it still runs (only an ended card is relaunched), then hands-off, the 60 s rule (and the
 * person's Esc hold) and the lock, as a steer asks them.
 */
export function assertMayRelaunch(central: CentralRecord, session: Session, ctx: SteerContext): void {
  const refuse = refuserFor(session);
  if (!ctx.inScope(session)) {
    refuse('NOT_IN_SCOPE', 'That session is outside your scope.', 'Call session_list to see the sessions you can reach.');
  }
  const kind = kindRefusal(central, session, ctx, 'relaunches');
  if (kind !== null) refuse('INVALID', kind.message, kind.hint);
  if (session.status !== 'ended') {
    refuse('INVALID', 'That session is still running.', 'Steer it instead, or pick a session that has ended.');
  }
  assertPersonRails(session, ctx);
}

/**
 * May `central` end `session` (interrupt, restart, kill or close it; Ruling P5-8)? NOT_IN_SCOPE, INVALID for the kinds a
 * central never touches (itself and another central included), then hands-off, the 60 s rule (and the person's Esc
 * hold) and the lock, as a steer asks them. An ended card, or one with no terminal, may be ended (closed). The lock the
 * context hands in leaves out the caller's own task: the person is asked before any end.
 */
export function assertMayEnd(central: CentralRecord, session: Session, ctx: SteerContext): void {
  const refuse = refuserFor(session);
  if (!ctx.inScope(session)) {
    refuse('NOT_IN_SCOPE', 'That session is outside your scope.', 'Call session_list to see the sessions you can reach.');
  }
  const kind = kindRefusal(central, session, ctx, 'ends');
  if (kind !== null) refuse('INVALID', kind.message, kind.hint);
  assertPersonRails(session, ctx);
}

/** Why `session` is not `child`'s own card to hand a task to; null when it is. */
function cardRefusal(child: CentralRecord, s: Session): string | null {
  const isCard = s.central?.centralId === child.centralId || (child.terminalId !== null && s.terminalId === child.terminalId);
  if (!isCard) return 'A task is handed down into the central’s own session only.';
  if (!isLocalSession(s)) return 'That central runs on another machine (SSH): centrals hand work to this Mac only.';
  if (!s.terminalId) return 'That central has no terminal to type into.';
  if (s.status === 'ended') return 'That central has ended.';
  return null;
}

/**
 * May the `caller` central hand a task down to the `child` central, typed into `childSession` (the child's card)?
 * Only a global caller to a room or project child, into its live local card with a terminal (INVALID otherwise); then
 * hands-off, a person and the lock, as `assertMaySteer`. Scope is not asked: a global central's covers every session.
 */
export function assertMayHandOff(caller: CentralRecord, child: CentralRecord, childSession: Session, ctx: SteerContext): void {
  const refuse = refuserFor(childSession);
  if (caller.kind !== 'global' || child.kind === 'global' || caller.centralId === child.centralId) {
    refuse('INVALID', 'Only a global central hands a task down, and only to a room or project central.', PICK_ANOTHER);
  }
  const card = cardRefusal(child, childSession);
  if (card !== null) refuse('INVALID', card, 'Pick the room or project central’s own session (session_list shows them).');
  assertPersonRails(childSession, ctx);
}

const HANDS_OFF_WORDS = 'That session is hands-off: centrals may read it, never type into it or give it work.';
const HANDS_OFF_HINT = 'Pick another session; only the person can take hands-off away.';

/** HANDS_OFF, HUMAN_ACTIVE (60 s, then the person's Esc hold) and BUSY, in that order: what any steer asks last. */
function assertPersonRails(session: Session, ctx: SteerContext): void {
  const refuse = refuserFor(session);
  if (session.handsOff === true) refuse('HANDS_OFF', HANDS_OFF_WORDS, HANDS_OFF_HINT);
  const driver = ctx.controller(session.sessionId);
  if (driver !== null && !driver.clientId.startsWith(MCP_CLIENT_PREFIX)) {
    const idle = ctx.now() - driver.lastActivityAt;
    if (idle < HUMAN_ACTIVE_MS) {
      const seconds = Math.max(1, Math.ceil((HUMAN_ACTIVE_MS - idle) / 1_000));
      refuse(
        'HUMAN_ACTIVE',
        'A person drove that session less than a minute ago.',
        `Try again in ${seconds} s, or pick another session.`,
      );
    }
  }
  const centralEsc = ctx.centralEscAt?.(session.sessionId, session.terminalId ?? null) ?? null;
  if (isEscHeld(session.userCancelledAt, centralEsc)) {
    refuse(
      'HUMAN_ACTIVE',
      'The person stopped that session with Esc; it waits for them.',
      'Pick another session; it is free again once the person prompts it.',
    );
  }
  if (ctx.isLocked(session.sessionId)) {
    refuse(
      'BUSY',
      'That session is working on a task a central gave it.',
      'Wait for that task (task_wait), or pick another session.',
    );
  }
}

/** One call steers 1 to MAX_FAN_OUT sessions, each named once. INVALID otherwise; the targets are never repeated. */
export function assertFanOut(targets: readonly string[]): void {
  if (targets.length === 0) {
    throw new ToolError('INVALID', 'Name at least one session.', 'Pass session ids from session_list.');
  }
  if (targets.length > MAX_FAN_OUT) {
    throw new ToolError(
      'INVALID',
      `One call steers at most ${MAX_FAN_OUT} sessions.`,
      'Split the work over several calls.',
    );
  }
  if (new Set(targets.map((t) => t.trim())).size !== targets.length) {
    throw new ToolError('INVALID', 'The same session is named more than once.', 'Name each session once.');
  }
}

/** The bytes POST /sessions/:id/prompt strips before it types (promptRouter.ts `cleanPromptText`). */
// eslint-disable-next-line no-control-regex
const STRIPPED_BYTES = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

/**
 * Refuses text that the CLI would run as a shell command: it starts with `!` once what the prompt route strips
 * (control bytes) and leading whitespace are gone. A `!` anywhere else is plain text.
 */
export function assertNotShellLine(text: string): void {
  if (stripLeadingRun(text.replace(STRIPPED_BYTES, '')).startsWith('!')) {
    throw new ToolError(
      'INVALID',
      'Text that starts with ! runs as a shell command in the CLI; a central never sends one.',
      'Say in words what the session should do; it runs commands under its own permission prompts.',
    );
  }
}

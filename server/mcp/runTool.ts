// runTool.ts — the one way into a tool's `run`, whoever asks: a tool call (server.ts) or a read of a resource that is
// the tool's answer (resources.ts). The tool runs as the central that asked, in the context callContext.ts builds,
// and whatever goes wrong comes back as a ToolError: the tool's own refusals as they are, anything else as UPSTREAM in
// fixed words, its details only in the log.
//
// Nothing else calls `run` on a tool (test/mcp/runTool.test.ts reads the sources and fails if something does).
// Whatever must hold for every way a central reaches a tool (an activity log, a budget, a rate limit) goes here, so
// that reading a resource cannot slip past what calling the tool is held to.
//
// The activity log (activity.ts): every call of a non-read tool is written, ok (one row per note the tool gives, or
// one in its title when it gave none and nothing was refused), refused (its ToolError's code; a SteerRefusal names its
// session) or failed (UPSTREAM); a policy refusal from ctx.mayDrive is written as it is thrown, whatever the tool's
// risk, and only once. A waiting tool's card (`ask`, `destructive`, `outward`) has rows of its own: asked, then (when
// the person answers) allowed by the person, or refused (said no, no answer in 5 minutes, withdrawn because its central
// left, or changed after the allow: P5-3). A read is never
// written. A row never holds the call's arguments or the tool's answer. With no activity log wired
// (`McpDeps.deliver`) a non-read tool is refused UNAVAILABLE before it runs: a write nobody can audit does not happen.
// A log that fails to write is said in the server log and never fails the call.

import log from '../logger.js';
import type { ActivityDetail, ActivityInput, ActivityNote } from './activity.js';
import { contextFor, phoneAnswerDepsOf, type CallAudit, type RunApproved } from './callContext.js';
import { resolveCentralSession } from './centrals.js';
import {
  answerRefusal,
  ASK_WAIT_MS,
  changedRefusal,
  confirms as serverConfirms,
  needsConfirmation,
  stillAsAsked,
  type AnsweredOn,
  type ConfirmBook,
  type PendingConfirm,
} from './confirm.js';
import { unwired } from './deliver.js';
import { phoneMayAnswer, shareable } from './phoneAnswerable.js';
import { allTools, MCP_MAX_PHASE, toolsFor, type ToolContext, type ToolDef, type ToolResult } from './registry.js';
import { SteerRefusal } from './policy.js';
import type { McpDeps } from './server.js';
import { isRecord, unwrap } from './tools/define.js';
import { macWindowOpenOf } from './tools/system.js';
import { ToolError, WAITS_FOR_PERSON } from './types.js';

/** What a refusal for an unexpected failure tells the central to do. */
export const RETRY_HINT =
  'Try it once more; if it fails again, tell the person (the details are in the AASC log).';

/** How a central reached the tool: it called it, or read a resource that is its answer. */
export type Via = 'call' | 'read';

/** Who runs the tool, with what, and how they came to it. */
export interface ToolRun {
  centralId: string;
  deps: McpDeps;
  /** The caller's own abort signal: nothing else from the request reaches a tool. */
  signal: AbortSignal;
  via: Via;
  /**
   * A confirmId the person allowed and `confirm_wait` used (`ctx.confirms.runApproved`): the gate lets the call through
   * only when that record is this tool's and this central's, and what it asked about has not changed (P5-3).
   */
  approved?: string;
}

/** What the gate found, read by the call's context (`ctx.allowedByPerson`): set only after an allow is checked. */
interface PersonBox {
  allowed: boolean;
  /** Where the allow came from, kept with it. */
  answeredOn: AnsweredOn | null;
}

/**
 * An allowed call's answer says so in `data` (P5-40): an allow inside the wait otherwise reads, to a central, like a
 * call that never asked, and Claude Code shows its model `structuredContent` only (Ruling 66). Object data only.
 */
function withAllow(result: ToolResult, person: PersonBox): ToolResult {
  if (!person.allowed || !isRecord(result.data)) return result;
  return { ...result, data: { ...result.data, allowedByPerson: { answeredOn: person.answeredOn } } };
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * An unexpected failure as the refusal a central reads: UPSTREAM, in fixed words that name what failed and nothing the
 * failure said. The details, and the central they were for, go to the log.
 */
export function upstreamFailure(what: string, centralId: string, detail: unknown): ToolError {
  log.warn('mcp', `${what} failed for central ${centralId}: ${describe(detail)}`);
  return new ToolError('UPSTREAM', `${what} failed inside AASC.`, RETRY_HINT);
}

// ---------------------------------------------------------------------------
// The activity log of one call
// ---------------------------------------------------------------------------

/** A refusal's row text: its code and AASC's words (a refusal never repeats an argument value). */
const refusalSummary = (err: ToolError): string => `Refused (${err.code}): ${err.message}`;

interface Audit extends CallAudit {
  /** The tool answered. */
  done(result: ToolResult): void;
  /** The tool (or building its context) threw this; `upstream` when it was not the tool's own refusal. */
  failed(err: ToolError, upstream: boolean): void;
  /** The gate asked the person (P3-19): AASC's summary and the target, never the arguments or the detail. */
  asked(record: PendingConfirm): void;
  /**
   * The person allowed the card (A-M2): a row of its own, for the central that never comes back to carry it out. Its
   * detail says where they answered (`answeredOn`, D-5).
   */
  allowed(record: PendingConfirm): void;
  /** The person said no (or the card ended unanswered): a refused row, saying where they answered when they did. */
  answerRefused(err: ToolError, record: PendingConfirm): void;
}

/** Where the person answered, as an activity row's detail: AASC's words only; nothing when nobody answered. */
const answeredDetail = (record: PendingConfirm): ActivityDetail =>
  record.answeredOn === null ? {} : { answeredOn: record.answeredOn };

/** The activity reporter of one call: writes rows for it, each refusal once, and never throws. */
function auditFor(tool: ToolDef, run: Pick<ToolRun, 'centralId' | 'deps'>): Audit {
  const activity = run.deps.deliver?.activity ?? null;
  const logged = new WeakSet<ToolError>();
  let refusals = 0;
  const write = (row: Omit<ActivityInput, 'centralId' | 'centralSessionId' | 'tool' | 'risk'>): void => {
    if (activity === null) return;
    try {
      activity.logActivity({
        centralId: run.centralId,
        centralSessionId: resolveCentralSession(run.centralId, run.deps.sessions())?.sessionId ?? null,
        tool: tool.name,
        risk: tool.risk,
        ...row,
      });
    } catch (err) {
      log.warn('mcp', `Writing the activity log for ${tool.name} (central ${run.centralId}) failed: ${describe(err)}`);
    }
  };
  const writeRefusal = (
    err: ToolError,
    targetSessionId: string | null,
    outcome: 'refused' | 'failed',
    extra: ActivityDetail = {},
  ): void => {
    if (logged.has(err)) return;
    logged.add(err);
    refusals += 1;
    write({ targetSessionId, taskId: null, summary: refusalSummary(err), outcome, detail: { code: err.code, ...extra } });
  };
  const note = (n: ActivityNote): void =>
    write({
      targetSessionId: n.targetSessionId ?? null,
      taskId: n.taskId ?? null,
      summary: n.summary,
      outcome: n.outcome ?? 'ok',
      detail: n.detail ?? null,
    });
  return {
    refused: (err, targetSessionId) => writeRefusal(err, targetSessionId, 'refused'),
    done(result) {
      if (tool.risk === 'read') return;
      const notes = result.activity ?? [];
      // A fan-out whose every target was refused did nothing: its refusals are its rows (A-M3).
      if (notes.length === 0 && refusals === 0) {
        write({ targetSessionId: null, taskId: null, summary: tool.title, outcome: 'ok' });
      }
      for (const n of notes) note(n);
    },
    failed(err, upstream) {
      // Still waiting for the person is no refusal: its row comes when the person answers (`watchAnswer`).
      if (tool.risk === 'read' || err.code === 'NEEDS_CONFIRMATION') return;
      writeRefusal(err, err instanceof SteerRefusal ? err.sessionId : null, upstream ? 'failed' : 'refused');
    },
    asked(record) {
      write({ targetSessionId: record.targetSessionId, taskId: null, summary: `asked the person: ${record.summary}`, outcome: 'ok' });
    },
    allowed(record) {
      write({
        targetSessionId: record.targetSessionId,
        taskId: null,
        summary: `allowed by the person: ${record.summary}`,
        outcome: 'ok',
        detail: answeredDetail(record),
      });
    },
    answerRefused: (err, record) => writeRefusal(err, record.targetSessionId ?? '', 'refused', answeredDetail(record)),
  };
}

/**
 * server.ts: a call of `tool` that its argument check refused, before the tool ran. Written like any refusal of a
 * non-read tool (the arguments themselves never are); a read's is not written.
 */
export function logArgumentRefusal(tool: ToolDef, refusal: ToolError, centralId: string, deps: McpDeps): void {
  auditFor(tool, { centralId, deps }).failed(refusal, false);
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The confirmation gate (Rulings P3-3…P3-5, P5-2, P5-3)
// ---------------------------------------------------------------------------

const bookOf = (deps: McpDeps): ConfirmBook => deps.confirms ?? serverConfirms;

/** GET /presence's snapshot (unwrapped), or null when it cannot be read: then no window and no phone is open. */
async function presenceNow(ctx: ToolContext): Promise<unknown> {
  const res = await ctx.client.get<unknown>('/presence', undefined, { signal: ctx.signal });
  try {
    return unwrap<unknown>(res);
  } catch (err) {
    if (err instanceof ToolError) return null;
    throw err;
  }
}

/**
 * Can a paired phone be told about a card now (Ruling P5-36)? Only when /presence lists a remote device with a
 * connection open that wsManager knows as a paired phone's socket (a password sign-in is no phone). Anything it cannot
 * tell is no.
 */
async function pairedPhoneConnected(snapshot: unknown): Promise<boolean> {
  const devices = isRecord(snapshot) && Array.isArray(snapshot.devices) ? snapshot.devices.filter(isRecord) : [];
  const remote = devices
    .filter((d) => d.isLocal !== true && typeof d.connections === 'number' && d.connections > 0)
    .map((d) => d.clientId)
    .filter((id): id is string => typeof id === 'string' && id !== '');
  if (remote.length === 0) return false;
  try {
    // Loaded here, not at the top: wsManager is the server's socket layer, and only this question needs it.
    const { isPairedPhoneClient } = await import('../wsManager.js');
    return remote.some((clientId) => isPairedPhoneClient(clientId));
  } catch (err) {
    log.warn('mcp', `Could not tell whether a paired phone is connected: ${describe(err)}`);
    return false;
  }
}

/**
 * Once the call has answered NEEDS_CONFIRMATION, the person's later answer is still written: a refused row when the
 * record is denied, expires or is withdrawn (its central left; its own words, not "said no"), and an "allowed by the
 * person" row when it is allowed, since the central may never come back. `confirm_wait` carries an allowed one out,
 * and the tool writes its own rows then.
 */
function watchAnswer(book: ConfirmBook, record: PendingConfirm, audit: Audit): void {
  const stop = book.onChange((e) => {
    if (e.kind !== 'resolved' || e.confirm.confirmId !== record.confirmId) return;
    stop();
    const decided = e.confirm;
    const { state, withdrawn } = decided;
    if (state === 'allowed') audit.allowed(decided);
    else if (withdrawn) audit.answerRefused(answerRefusal('withdrawn'), decided);
    else if (state === 'denied' || state === 'expired') audit.answerRefused(answerRefusal(state), decided);
  });
}

/**
 * After an allow, and the record used: asks the tool's `confirm` again with the same arguments (P5-3). True when it is
 * still the card the person allowed (`stillAsAsked`: summary, target and fingerprint, Ruling P5-34). False when no card
 * is needed now (null): the call runs as one nobody allowed (A-2), so the tool judges it as it judges any call that
 * needed no card. Anything else is CHANGED, a refused row of its own, and nothing runs. A refusal from `confirm`
 * itself goes up as it is.
 */
async function recheck(
  confirm: NonNullable<ToolDef['confirm']>,
  args: Record<string, unknown>,
  ctx: ToolContext,
  record: PendingConfirm,
  audit: Audit,
): Promise<boolean> {
  const again = await confirm(args, ctx);
  if (again === null) return false;
  if (stillAsAsked(record, again)) return true;
  const refusal = changedRefusal();
  audit.refused(refusal, record.targetSessionId ?? '');
  throw refusal;
}

/**
 * For a tool whose risk waits for the person (WAITS_FOR_PERSON): returns when it may run, or throws. One without
 * `confirm` is UNAVAILABLE (fails closed). A call carrying `approved` (a consumed record of this tool and this central:
 * `confirm_wait`'s) is rechecked and passes. Otherwise the tool's `confirm` says what to ask (null: nothing; it may
 * refuse first). A closed Mac window is NO_WINDOW, unless a paired phone may answer the card (phoneAnswerable.ts) and
 * can be told now (Ruling P5-36). The person has ASK_WAIT_MS to answer: allowed is rechecked, then runs (the record
 * used), denied or expired is DENIED (withdrawn: UNAVAILABLE), no answer yet is NEEDS_CONFIRMATION with the confirmId,
 * naming the phone exactly when one may answer it (P5-25). `person.allowed` is set only once an allow has passed its
 * recheck with a card still needed.
 */
async function gate(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ToolContext,
  run: ToolRun,
  audit: Audit,
  person: PersonBox,
): Promise<void> {
  if (!WAITS_FOR_PERSON.has(tool.risk)) return;
  const book = bookOf(run.deps);
  const confirm = tool.confirm?.bind(tool);
  if (confirm === undefined) {
    log.warn('mcp', `The ${tool.risk} tool ${tool.name} has no confirm: refused`);
    throw new ToolError('UNAVAILABLE', 'That tool cannot ask the person in this build.', 'Tell the person.');
  }
  if (run.approved !== undefined) {
    const used = book.forCentral(run.approved, run.centralId);
    if (used !== null && used.tool === tool.name && used.state === 'allowed' && used.consumed) {
      person.allowed = await recheck(confirm, args, ctx, used, audit);
      person.answeredOn = used.answeredOn;
      return;
    }
  }
  const ask = await confirm(args, ctx);
  if (ask === null) return;
  const phoneDeps = phoneAnswerDepsOf(run.deps);
  const snapshot = await presenceNow(ctx);
  const phoneCard = { tool: tool.name, centralId: run.centralId, targetSessionId: ask.targetSessionId ?? null };
  if (!macWindowOpenOf(snapshot) && !(shareable(phoneCard, phoneDeps) && (await pairedPhoneConnected(snapshot)))) {
    throw new ToolError(
      'NO_WINDOW',
      'Nobody can answer on the Mac now: its AASC window is closed.',
      'Ask the person to open AASC on the Mac, then call the tool again.',
    );
  }
  const record = book.open({
    centralId: run.centralId,
    tool: tool.name,
    risk: tool.risk,
    args,
    summary: ask.summary,
    detail: ask.detail ?? null,
    targetSessionId: ask.targetSessionId ?? null,
    fingerprint: ask.fingerprint ?? null,
  });
  audit.asked(record);
  const state = await book.wait(record.confirmId, run.centralId, ASK_WAIT_MS, ctx.signal);
  const decided = book.forCentral(record.confirmId, run.centralId) ?? record;
  if (state === 'allowed') {
    audit.allowed(decided);
    if (book.consume(record.confirmId, run.centralId) === null) {
      throw new ToolError('INVALID', 'That confirmation was already used, or was not allowed.', 'Call the tool again to ask the person.');
    }
    person.allowed = await recheck(confirm, args, ctx, record, audit);
    person.answeredOn = decided.answeredOn;
    return;
  }
  if (state !== 'pending') {
    // denied, expired or withdrawn (a closed or revoked central's card, A-M2)
    const refusal = answerRefusal(state);
    audit.answerRefused(refusal, decided);
    throw refusal;
  }
  watchAnswer(book, record, audit);
  throw needsConfirmation({ ...record, phone: phoneMayAnswer(decided, phoneDeps) });
}

/**
 * `ctx.confirms.runApproved` for this call: uses the central's allowed record once, then runs its tool (still the
 * central's, at this build's phase) through runTool with the stored arguments, so the tool's own checks run now.
 */
function approver(run: ToolRun): RunApproved {
  return async (confirmId) => {
    const record = bookOf(run.deps).consume(confirmId, run.centralId);
    if (record === null) {
      throw new ToolError('INVALID', 'That confirmation was already used, or was not allowed.', 'Call the tool again to ask the person.');
    }
    const central = run.deps.registry.byId(run.centralId);
    const tool =
      central === null ? undefined : toolsFor(central, MCP_MAX_PHASE, (run.deps.tools ?? allTools)()).find((t) => t.name === record.tool);
    if (tool === undefined) {
      throw new ToolError('UNAVAILABLE', 'The tool that asked is no longer one of yours.', 'Tell the person.');
    }
    return runTool(tool, structuredClone({ ...record.args }), { ...run, via: 'call', approved: confirmId });
  };
}

/**
 * Runs `tool` with `args` (already checked against its input shape) as the central in `run`. A tool whose risk waits
 * for the person passes the confirmation gate first. Answers what the tool answered, or throws a ToolError: the tool's own, the gate's,
 * UNAVAILABLE when the central is no longer live (or a write finds no activity log to record it), else UPSTREAM.
 */
export async function runTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  run: ToolRun,
): Promise<ToolResult> {
  log.debug(
    'mcp',
    `Central ${run.centralId} ${run.via === 'read' ? 'reads' : 'calls'} ${tool.name}`,
  );
  const audit = auditFor(tool, run);
  const person: PersonBox = { allowed: false, answeredOn: null };
  try {
    const ctx = contextFor(run.centralId, run.deps, run.signal, audit, approver(run), () => person.allowed);
    if (tool.risk !== 'read' && run.deps.deliver === undefined) throw unwired();
    await gate(tool, args, ctx, run, audit, person);
    const result = withAllow(await tool.run(args, ctx), person);
    audit.done(result);
    return result;
  } catch (err) {
    const failure = err instanceof ToolError ? err : upstreamFailure(tool.name, run.centralId, err);
    audit.failed(failure, !(err instanceof ToolError));
    throw failure;
  }
}

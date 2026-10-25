// confirm.ts — the confirmation book: what a tool that waits for the person (`ask`, `destructive`, `outward`: types.ts
// WAITS_FOR_PERSON) waits on (Rulings P3-3…P3-5, P5-2).
//
// runTool.ts opens a record when such a tool's `confirm` says a card is needed, and waits on it; the person answers
// on this Mac (confirmRoutes.ts, POST /api/mcp/confirm/:cardId); `confirm_wait` waits on it later and carries out the
// approved call, once, with the arguments the person saw.
//
// Each record has two ids, both `randomUUID()`:
//   confirmId  only ever goes to the central (a tool answer's `data`); `confirm_wait` takes it
//   cardId     only ever goes to this Mac's windows (the feeds, GET /api/mcp/confirms); the answer route takes it
// so a central cannot answer its own confirmation by the id it holds, and a window never learns the central's id.
//
// What a record holds: the call's arguments as a deep-frozen copy, in memory only and never logged; AASC's summary
// (<= 300) and the text the person judges (`detail`, <= 2 000), both with token shapes blanked (activity.ts). The
// summary is one line (`scrubText`). The detail keeps its lines and the spaces inside them, so indented code looks as
// it will be saved, and shows every character that hides itself (bidi controls, zero-width and tag characters, other
// control characters) as a marker like ⟨U+202E⟩: the person approves what they can read (A-I2). And the AASC-made
// `fingerprint` of what the person is asked about (<= 200 as it is, a longer one as its sha256 digest; a terminal, a
// queue's item ids …, Ruling P5-3), which runTool compares after the allow with the summary and the target
// (`stillAsAsked`, Ruling P5-34), so the call carried out is the one approved. Like the arguments, it never leaves
// the server: no view, feed, row, tool answer or phone carries it. A record is pending
// for 5 min, then `expired` (as good as denied); a decided one is kept 10 min so `confirm_wait` can still read it,
// then forgotten. At most 3 are pending per central and 20 overall (BUDGET). Every timer is `unref()`'d, so the book
// never keeps the process alive; `close()` clears them all.
//
// A central that leaves (revoked, closed) while its card waits has the card withdrawn (A-M2): windows see it
// denied (`state` stays denied, their vocabulary), `withdrawn` is true, and `wait` answers 'withdrawn', which has its
// own words (`answerRefusal`) and its own activity row.
//
// Records go out frozen and are replaced, never edited.

import { createHash, randomUUID } from 'node:crypto';
import type { McpConfirmState } from '../../src/types/mcpConfirm.js';
import log from '../logger.js';
import { blankSecrets, scrubText } from './activity.js';
import { ToolError, type Risk } from './types.js';

/** How long the person has to answer. */
export const CONFIRM_TTL_MS = 300_000;
/** How long an ask tool's own call waits for the answer before it answers NEEDS_CONFIRMATION. */
export const ASK_WAIT_MS = 45_000;
/** The most confirmations one central has waiting. */
export const MAX_PENDING_PER_CENTRAL = 3;
/** The most confirmations waiting on the Mac. */
export const MAX_PENDING_TOTAL = 20;
export const CONFIRM_SUMMARY_MAX = 300;
export const CONFIRM_DETAIL_MAX = 2_000;
/** The longest one wait may be (a tool call never waits longer than 50 s). */
export const CONFIRM_WAIT_MAX_MS = 50_000;
/** How long a decided record is kept for `confirm_wait`. */
export const CONFIRM_KEEP_MS = 10 * 60_000;
/** The longest fingerprint kept as it is: a longer one is kept as its digest, the same way when compared (`fingerprintOf`). */
export const CONFIRM_FINGERPRINT_MAX = 200;

/** What `wait` answers: the windows' states, and 'withdrawn' (the central left; windows saw it denied). */
export type ConfirmState = McpConfirmState | 'withdrawn';

/** Where an answer came from: the Mac's own window (confirmRoutes.ts) or a paired phone (phoneConfirmRoutes.ts). */
export type AnsweredOn = 'mac' | 'phone';

export interface PendingConfirm {
  readonly confirmId: string;
  readonly cardId: string;
  readonly centralId: string;
  readonly tool: string;
  readonly risk: Risk;
  /** The call's arguments as the person saw them: a deep-frozen copy. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly detail: string | null;
  readonly targetSessionId: string | null;
  /** What the person was asked about, as AASC sees it (P5-3); server-only, never in a view, row or answer. */
  readonly fingerprint: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: McpConfirmState;
  /** The central left before the person answered: `state` is denied, but nobody said no. */
  readonly withdrawn: boolean;
  readonly decidedAt: number | null;
  /** Where the person answered (D-5): this Mac's window or a paired phone; null until answered (expired, withdrawn). */
  readonly answeredOn: AnsweredOn | null;
  /** The approved call was carried out (or is being): a second use is refused. */
  readonly consumed: boolean;
}

export interface ConfirmOpen {
  centralId: string;
  tool: string;
  risk: Risk;
  args: Record<string, unknown>;
  summary: string;
  detail?: string | null;
  targetSessionId?: string | null;
  /** AASC-made (P5-3): kept as `fingerprintOf` keeps it, never shown. */
  fingerprint?: string | null;
}

export interface ConfirmChange {
  kind: 'opened' | 'resolved';
  confirm: PendingConfirm;
}

export interface ConfirmBook {
  /** A new pending record; BUDGET past the caps. */
  open(input: ConfirmOpen): PendingConfirm;
  /** The central's record by its confirmId (undefined: its newest), or null. Never another central's. */
  forCentral(confirmId: string | undefined, centralId: string): PendingConfirm | null;
  /**
   * The person's answer, by the card id: the record decided, 'gone' (unknown or expired) or 'decided' (answered).
   * `via`: where it came from (the Mac when left out), kept as `answeredOn`.
   */
  answer(cardId: string, decision: 'allow' | 'deny', via?: AnsweredOn): PendingConfirm | 'gone' | 'decided';
  /**
   * The record's state once it is decided, or 'pending' at the timeout (at most 50 s) or when `signal` aborts.
   * NOT_FOUND for an id that is not the central's.
   */
  wait(confirmId: string, centralId: string, timeoutMs: number, signal: AbortSignal): Promise<ConfirmState>;
  /** The allowed, unused record, now marked used; null otherwise. */
  consume(confirmId: string, centralId: string): PendingConfirm | null;
  /** Every pending record, oldest first. */
  pending(): PendingConfirm[];
  /** Called on each open and each resolution. Returns the unsubscribe. */
  onChange(l: (e: ConfirmChange) => void): () => void;
  /** A central that left: its pending records are withdrawn (windows see them denied). */
  forgetCentral(centralId: string): void;
  close(): void;
}

export interface ConfirmBookOptions {
  now?: () => number;
}

/** A deep-frozen copy of plain data. */
function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (v: unknown): void => {
    if (typeof v !== 'object' || v === null || Object.isFrozen(v)) return;
    Object.freeze(v);
    for (const inner of Object.values(v)) freeze(inner);
  };
  freeze(copy);
  return copy;
}

/**
 * Characters the person cannot see but a CLI or a note keeps: every format character (`\p{Cf}`: bidi marks, overrides
 * and isolates, zero-width, soft hyphen, invisible operators, tag characters, as commandRules.ts WORD_END reads them),
 * the unassigned tag block, and the control characters other than the tab (a line break is already a line
 * split; a lone carriage return would overwrite the line it sits in).
 */
// eslint-disable-next-line no-control-regex
const HIDDEN_CHARS = /[\p{Cf}\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\u{E0000}-\u{E007F}]/gu;

/** `text` with each hidden character spelled out, e.g. ⟨U+202E⟩. */
function showHidden(text: string): string {
  return text.replace(HIDDEN_CHARS, (c) => `⟨U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`);
}

/**
 * The text the person judges: its lines kept with their own spaces, token shapes blanked, hidden characters shown,
 * the whole cut to CONFIRM_DETAIL_MAX. Not `scrubText`, which flattens spacing for the activity rows.
 */
function detailText(detail: string | null | undefined): string | null {
  if (typeof detail !== 'string' || detail.trim() === '') return null;
  const joined = detail
    .split(/\r?\n/)
    .map((line) => showHidden(blankSecrets(line)))
    .join('\n');
  return joined.length > CONFIRM_DETAIL_MAX ? `${joined.slice(0, CONFIRM_DETAIL_MAX - 1)}…` : joined;
}

/**
 * A fingerprint as the book keeps it, and as runTool compares it: as it is up to CONFIRM_FINGERPRINT_MAX, a longer one
 * as `sha256:` and the hex digest of the whole of it (A-6: a cut would never compare its tail); none is null.
 */
export function fingerprintOf(fingerprint: string | null | undefined): string | null {
  if (typeof fingerprint !== 'string') return null;
  if (fingerprint.length <= CONFIRM_FINGERPRINT_MAX) return fingerprint;
  return `sha256:${createHash('sha256').update(fingerprint, 'utf8').digest('hex')}`;
}

/** A card's summary as the book keeps it (one line, token shapes blanked, cut to 300), and as runTool compares it. */
export function confirmSummaryOf(summary: string): string {
  return scrubText(summary, CONFIRM_SUMMARY_MAX);
}

/** What the gate compares after an allow (P5-3, Ruling P5-34): one card's facts, as the book keeps them. */
export type AskedAbout = Pick<PendingConfirm, 'summary' | 'targetSessionId' | 'fingerprint'>;

/**
 * Is what `confirm` answers now (`again`) still the card the person allowed (`record`): the same summary, target and
 * fingerprint, each as the book keeps it?
 */
export function stillAsAsked(
  record: AskedAbout,
  again: { summary: string; targetSessionId?: string | null; fingerprint?: string | null },
): boolean {
  return (
    fingerprintOf(again.fingerprint) === record.fingerprint &&
    (again.targetSessionId ?? null) === record.targetSessionId &&
    confirmSummaryOf(again.summary) === record.summary
  );
}

/**
 * The person has not answered yet: NEEDS_CONFIRMATION, with the facts the central acts on in `data` (Ruling 66). Its
 * own id only; the Mac's card id never. `phone`: a paired phone may answer it too (P5-25), and the words say so.
 */
export function needsConfirmation(record: Pick<PendingConfirm, 'confirmId' | 'expiresAt'> & { phone?: boolean }): ToolError {
  return new ToolError(
    'NEEDS_CONFIRMATION',
    record.phone === true
      ? 'Waiting for the person to allow it on the Mac or the paired phone.'
      : 'Waiting for the person to allow it on the Mac.',
    'Tell the person, then call confirm_wait with this confirmId.',
    { confirmId: record.confirmId, expiresAt: record.expiresAt },
  );
}

/** The person said no, let it expire, or the central left first: DENIED in AASC's words (withdrawn: UNAVAILABLE). */
export function answerRefusal(state: 'denied' | 'expired' | 'withdrawn'): ToolError {
  if (state === 'withdrawn') return withdrawnRefusal();
  return state === 'denied'
    ? new ToolError('DENIED', 'The person said no.', 'Do not ask again unless the person asks you to.')
    : new ToolError('DENIED', 'The person did not answer within 5 minutes.', 'Ask again only if it is still needed, and tell the person first.');
}

/**
 * What the person allowed is no longer what the call would act on (P5-3): its fingerprint, its target or its summary
 * changed after the card was opened (`stillAsAsked`). Nothing ran; the record is used.
 */
export function changedRefusal(): ToolError {
  return new ToolError(
    'INVALID',
    'What you asked about changed after the person was asked, so nothing was done.',
    'Call the tool again: the person is asked about it as it is now.',
  );
}

/** The card was withdrawn: its central was revoked or closed before the person answered. Nobody said no. */
export function withdrawnRefusal(): ToolError {
  return new ToolError(
    'UNAVAILABLE',
    'The request was withdrawn before the person answered: the central that asked it was revoked or closed.',
    'Ask again from a live central, and tell the person first.',
  );
}

const budget = (message: string): ToolError =>
  new ToolError('BUDGET', message, 'Wait for the person to answer the ones waiting (confirm_wait), then ask again.');

export function createConfirmBook(opts: ConfirmBookOptions = {}): ConfirmBook {
  const now = opts.now ?? Date.now;
  // confirmId → the only copy of its record; replaced, never edited.
  const records = new Map<string, PendingConfirm>();
  const byCard = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const waiters = new Map<string, Set<(state: ConfirmState) => void>>();
  const listeners = new Set<(e: ConfirmChange) => void>();

  const notify = (e: ConfirmChange): void => {
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch (err) {
        log.warn('mcp', `A confirmation listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const setTimer = (confirmId: string, ms: number, fn: () => void): void => {
    clearTimeout(timers.get(confirmId));
    const t = setTimeout(() => {
      timers.delete(confirmId);
      fn();
    }, ms);
    t.unref?.();
    timers.set(confirmId, t);
  };

  const forget = (confirmId: string): void => {
    const r = records.get(confirmId);
    if (r === undefined) return;
    records.delete(confirmId);
    byCard.delete(r.cardId);
    clearTimeout(timers.get(confirmId));
    timers.delete(confirmId);
  };

  const replace = (next: PendingConfirm): PendingConfirm => {
    const frozen = Object.freeze({ ...next });
    records.set(frozen.confirmId, frozen);
    return frozen;
  };

  /** Moves a pending record to `state`, tells its waiters and the listeners, and keeps it CONFIRM_KEEP_MS. */
  const resolve = (
    r: PendingConfirm,
    state: Exclude<McpConfirmState, 'pending'>,
    withdrawn = false,
    answeredOn: AnsweredOn | null = null,
  ): PendingConfirm => {
    const decided = replace({ ...r, state, withdrawn, decidedAt: now(), answeredOn });
    setTimer(r.confirmId, CONFIRM_KEEP_MS, () => forget(r.confirmId));
    for (const w of [...(waiters.get(r.confirmId) ?? [])]) w(stateOf(decided));
    waiters.delete(r.confirmId);
    notify({ kind: 'resolved', confirm: decided });
    return decided;
  };

  /** The state a waiter is told: 'withdrawn' for a withdrawn record, else its own. */
  const stateOf = (r: PendingConfirm): ConfirmState => (r.withdrawn ? 'withdrawn' : r.state);

  const pending = (): PendingConfirm[] =>
    [...records.values()].filter((r) => r.state === 'pending').sort((a, b) => a.createdAt - b.createdAt);

  const forCentral = (confirmId: string | undefined, centralId: string): PendingConfirm | null => {
    if (confirmId === undefined) {
      const mine = [...records.values()].filter((r) => r.centralId === centralId);
      return mine.reduce<PendingConfirm | null>((best, r) => (best === null || r.createdAt >= best.createdAt ? r : best), null);
    }
    const r = records.get(confirmId);
    return r !== undefined && r.centralId === centralId ? r : null;
  };

  return {
    open(input) {
      const waiting = pending();
      if (waiting.filter((r) => r.centralId === input.centralId).length >= MAX_PENDING_PER_CENTRAL) {
        throw budget(`You already have ${MAX_PENDING_PER_CENTRAL} questions waiting for the person.`);
      }
      if (waiting.length >= MAX_PENDING_TOTAL) {
        throw budget(`The Mac already has ${MAX_PENDING_TOTAL} questions waiting for the person.`);
      }
      const createdAt = now();
      const record = replace({
        confirmId: randomUUID(),
        cardId: randomUUID(),
        centralId: input.centralId,
        tool: input.tool,
        risk: input.risk,
        args: frozenCopy(input.args),
        summary: confirmSummaryOf(input.summary),
        detail: detailText(input.detail),
        targetSessionId: input.targetSessionId ?? null,
        fingerprint: fingerprintOf(input.fingerprint),
        createdAt,
        expiresAt: createdAt + CONFIRM_TTL_MS,
        state: 'pending',
        withdrawn: false,
        decidedAt: null,
        answeredOn: null,
        consumed: false,
      });
      byCard.set(record.cardId, record.confirmId);
      setTimer(record.confirmId, CONFIRM_TTL_MS, () => {
        const current = records.get(record.confirmId);
        if (current?.state === 'pending') resolve(current, 'expired');
      });
      notify({ kind: 'opened', confirm: record });
      return record;
    },
    forCentral,
    answer(cardId, decision, via = 'mac') {
      const confirmId = byCard.get(cardId);
      const r = confirmId === undefined ? undefined : records.get(confirmId);
      if (r === undefined || r.state === 'expired') return 'gone';
      if (r.state !== 'pending') return 'decided';
      return resolve(r, decision === 'allow' ? 'allowed' : 'denied', false, via === 'phone' ? 'phone' : 'mac');
    },
    wait(confirmId, centralId, timeoutMs, signal) {
      const r = forCentral(confirmId, centralId);
      if (r === null) {
        return Promise.reject(
          new ToolError('NOT_FOUND', 'There is no such confirmation of yours.', 'Ask again with the tool itself.'),
        );
      }
      if (r.state !== 'pending' || signal.aborted) return Promise.resolve(stateOf(r));
      return new Promise<ConfirmState>((done) => {
        const set = waiters.get(confirmId) ?? new Set<(state: ConfirmState) => void>();
        waiters.set(confirmId, set);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (state: ConfirmState): void => {
          clearTimeout(timer);
          set.delete(finish);
          signal.removeEventListener('abort', onAbort);
          done(state);
        };
        const onAbort = (): void => {
          const current = records.get(confirmId);
          finish(current === undefined ? 'pending' : stateOf(current));
        };
        timer = setTimeout(onAbort, Math.max(0, Math.min(timeoutMs, CONFIRM_WAIT_MAX_MS)));
        timer.unref?.();
        signal.addEventListener('abort', onAbort, { once: true });
        set.add(finish);
      });
    },
    consume(confirmId, centralId) {
      const r = forCentral(confirmId, centralId);
      if (r === null || r.state !== 'allowed' || r.consumed) return null;
      return replace({ ...r, consumed: true });
    },
    pending,
    onChange(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    forgetCentral(centralId) {
      for (const r of pending()) if (r.centralId === centralId) resolve(r, 'denied', true);
    },
    close() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const [confirmId, set] of waiters) {
        const current = records.get(confirmId);
        const state = current === undefined ? 'pending' : stateOf(current);
        for (const w of [...set]) w(state);
      }
      waiters.clear();
      listeners.clear();
    },
  };
}

/** The book the server runs on. */
export const confirms: ConfirmBook = createConfirmBook();

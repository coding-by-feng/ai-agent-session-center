// promptSubmit.ts — the Mac types a prompt into an agent terminal and makes sure the CLI took it (AASC-42).
//
// A phone used to type its prompt over POST /terminals/:id/write: the text, then a
// lone Enter a second later, and nothing after that. When Claude Code swallowed the
// Enter (it takes a pasted image path in slowly, and an Enter that lands too early
// is lost) the prompt sat typed but unsent, and a phone that locked right after
// sending never knew. The desktop queue already handles this by pressing Enter again
// until a hook acknowledges the prompt (src/lib/submitConfirm.ts); this is the same
// logic on the Mac, so it no longer depends on a browser window staying open.
//
// The rules are the queue's, taken from the same module so they can't drift:
//   - the text, then a STANDALONE "\r" after 1 s (2.5 s with images): a single
//     `text + "\r"` write reads as a paste and the Enter lands as a newline;
//   - Enter again at 3 / 8 / 15 / 30 / 60 s after the first Enter, only while the
//     session sits waiting/idle (an Enter in an empty input box is a no-op);
//   - stop at once when it is no longer safe: a dialog opened (an Enter would pick
//     an option), the session ended or lost its terminal, the user cancelled after
//     the send, or another device took the session over;
//   - never confirm a slash command (`/model` opens a picker an Enter would answer);
//   - give up 15 s after the last retry.
// On top of the queue's rules, the Mac checks before EVERY keystroke it writes (the
// text, the first Enter, each repeat) that the session still runs in that terminal,
// shows no dialog, still has its agent in the foreground (a crashed agent sends no
// SessionEnd, and an Enter would reach the shell), and that the requesting device
// may still drive it: seconds pass between the route's checks and the last Enter.
// Unlike the browser, the Mac sees which hook arrived: the acknowledgement is the
// UserPromptSubmit hook for that terminal (or the session going busy from waiting),
// never just any hook, so an idle notification can't pass for a submitted prompt.
// Sent while the agent is busy, only its UserPromptSubmit counts: the running turn's
// hooks are not about it. It presses nothing until the session is waiting again.
//
// One prompt at a time per terminal, and at most one waiting behind it: the next one
// types only once the one before is confirmed (or typed nothing, or was a slash
// command and its first hook arrived), never onto text it may have left unsent.
//
// `interrupt` presses Esc first and waits (at most 10 s) for the turn to stop.
// Claude Code fires an ordinary Stop for an Esc; the transcript check that follows
// it stamps `userCancelledAt` (sessionStore), which is why only a cancel stamped
// after this prompt's own Enter counts as the user taking over, and for an
// interrupt only once INTERRUPT_CANCEL_GRACE_MS have passed.

import { EVENT_TYPES, SESSION_STATUS } from './constants.js';
import log from './logger.js';
import type { HookSignal } from './hookSignals.js';
import {
  SUBMIT_RETRY_AFTER_MS, SUBMIT_GIVE_UP_GRACE_MS, mayConfirmSubmit, retriesElapsed, submitRetryDecision,
} from '../src/lib/submitConfirm.js';
import { SUBMIT_ENTER_DELAY_MS, IMAGE_SUBMIT_ENTER_DELAY_MS, submitDelayFor } from '../src/lib/terminalSend.js';

export { SUBMIT_RETRY_AFTER_MS, SUBMIT_GIVE_UP_GRACE_MS, SUBMIT_ENTER_DELAY_MS, IMAGE_SUBMIT_ENTER_DELAY_MS };

/** The longest an interrupt waits for the turn to stop before it types anyway. */
export const INTERRUPT_WAIT_MS = 10_000;

/**
 * After an interrupt, cancel stamps this long after the prompt's Enter still belong
 * to the turn its Esc stopped: the transcript is read 150 and 600 ms after that
 * turn's Stop, and the read itself is slower on a busy Mac, so the stamp can land
 * after the Enter (Stop + 1 s). The first repeated Enter is due at 3 s.
 */
export const INTERRUPT_CANCEL_GRACE_MS = 5_000;

/**
 * The longest a prompt waits for the one before it on the same terminal. Longer than
 * that one's slowest ordinary path (an interrupt's wait, the image pause and every
 * retry), so it fires only when the one before is parked behind a long turn.
 */
export const PREVIOUS_PROMPT_WAIT_MS = 90_000;

/** After a slash command (never confirmed), the next prompt waits for a hook or this long. */
export const SLASH_SETTLE_MS = 3_000;

/** How often a prompt parked behind a running turn looks at the session's status. */
export const BUSY_PARK_CHECK_MS = 5_000;

/** The longest a prompt sent to a busy session waits for that turn to end. */
export const BUSY_PARK_MAX_MS = 15 * 60_000;

/** How long a request key is remembered: a repeat inside this window never sends twice. */
export const PROMPT_KEY_TTL_MS = 5 * 60_000;

/** Request keys kept at most; the oldest go first. */
export const PROMPT_KEY_MAX = 1_000;

const ESC = '\x1b';
const ENTER = '\r';

/** Statuses in which an extra Enter can only submit what is in the input box. */
const RETRYABLE_STATUSES: ReadonlySet<string> = new Set([SESSION_STATUS.WAITING, SESSION_STATUS.IDLE]);
/** The CLI took a prompt and is working on it. */
const BUSY_STATUSES: ReadonlySet<string> = new Set([SESSION_STATUS.PROMPTING, SESSION_STATUS.WORKING]);
/** Statuses in which typing reaches the input box (a busy CLI queues it); anything else could answer a dialog. */
const TYPABLE_STATUSES: ReadonlySet<string> = new Set([...RETRYABLE_STATUSES, ...BUSY_STATUSES]);
/** Something an Esc stops: a running turn, or a dialog it declines. */
const INTERRUPTIBLE_STATUSES: ReadonlySet<string> = new Set([
  SESSION_STATUS.PROMPTING, SESSION_STATUS.WORKING, SESSION_STATUS.APPROVAL, SESSION_STATUS.INPUT,
]);
/** Statuses that end an interrupt's wait: the turn is over, one way or another. */
const TURN_OVER_STATUSES: ReadonlySet<string> = new Set([SESSION_STATUS.WAITING, SESSION_STATUS.IDLE, SESSION_STATUS.ENDED]);
const TURN_OVER_EVENTS: ReadonlySet<string> = new Set([EVENT_TYPES.STOP, EVENT_TYPES.AGENT_TURN_COMPLETE, EVENT_TYPES.SESSION_END]);

export type PromptMode = 'now' | 'interrupt';

/**
 * How a send ended:
 * - submitted    the CLI acknowledged it (its UserPromptSubmit, or the session going busy
 *                from waiting; a prompt sent to a busy session needs its UserPromptSubmit)
 * - unconfirmed  sent once and deliberately not confirmed (a slash command)
 * - stopped      no longer safe to type or press Enter (a dialog, a cancel, the agent gone,
 *                another driver, or the prompt before it left text in the input box)
 * - gave-up      every retry was pressed and nothing acknowledged it
 * - failed       the terminal is gone: a write did not reach it
 */
export type PromptOutcome = 'submitted' | 'unconfirmed' | 'stopped' | 'gave-up' | 'failed';

/** How a send ended, and whether any of its text reached the terminal. */
export interface PromptResult {
  outcome: PromptOutcome;
  /** False when it ended before typing: sending it again can't double it up. */
  typed: boolean;
}

/** What the submitter reads of the session a prompt is for. */
export interface PromptSessionView {
  sessionId: string;
  terminalId?: string | null;
  status: string;
  userCancelledAt?: number | null;
}

export interface PromptSubmitDeps {
  /** Write to the terminal's PTY; false when the terminal is gone. */
  write(terminalId: string, data: string): boolean;
  /** The session by id, following re-keys (term-* → the CLI's id), or null. */
  getSession(sessionId: string): PromptSessionView | null;
  /** Is the agent itself the terminal's foreground program (not the shell underneath)? */
  isAgentForeground(terminalId: string): boolean;
  /** Hear every hook processed for the terminal's session (hookSignals.onTerminalHook). */
  onTerminalHook(terminalId: string, listener: (signal: HookSignal) => void): () => void;
}

export interface PromptRequest {
  /** The session the route checked; the prompt is dropped if it moves to another terminal. */
  sessionId: string;
  terminalId: string;
  text: string;
  /** Absolute paths of uploaded images, typed under the text as the queue does. */
  imagePaths?: readonly string[];
  mode: PromptMode;
  /** May the requesting device still drive the session? Checked before every keystroke. */
  mayDrive?: (sessionId: string) => boolean;
}

export interface PromptSubmitter {
  /** Is there room for one more prompt on this terminal (none waiting behind the one in progress)? */
  hasRoom(terminalId: string): boolean;
  submit(req: PromptRequest): Promise<PromptResult>;
}

/** A prompt's place in its terminal's line: `done` settles once the next one may go. */
interface Slot {
  done: Promise<PromptResult>;
  release: (result: PromptResult) => void;
}

function newSlot(): Slot {
  let release: (result: PromptResult) => void = () => {};
  const done = new Promise<PromptResult>((resolve) => { release = resolve; });
  return { done, release };
}

/** The prompt in progress, and at most one waiting behind it. */
const MAX_PER_TERMINAL = 2;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `promise`'s value, or null once `ms` pass first. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createPromptSubmitter(deps: PromptSubmitDeps): PromptSubmitter {
  /** Each terminal's line of prompts: the one in progress first. */
  const lines = new Map<string, Slot[]>();

  /** The prompt's session, while it still runs in the prompt's terminal. */
  function current(req: PromptRequest): PromptSessionView | null {
    const session = deps.getSession(req.sessionId);
    return session && session.terminalId === req.terminalId ? session : null;
  }

  /** May the requesting device still drive it, and is its agent still in front? */
  function stillOurs(req: PromptRequest, session: PromptSessionView): boolean {
    return deps.isAgentForeground(req.terminalId) && (!req.mayDrive || req.mayDrive(session.sessionId));
  }

  /** Is a keystroke now safe: the session in its terminal, no dialog open, the agent in front, ours to drive? */
  function mayType(req: PromptRequest): boolean {
    const session = current(req);
    return !!session && TYPABLE_STATUSES.has(session.status) && stillOurs(req, session);
  }

  /** Resolves on the terminal's next hook, or after `ms`. */
  function nextHookOr(terminalId: string, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const off = deps.onTerminalHook(terminalId, finish);
      const timer = setTimeout(finish, ms);
    });
  }

  /** Press Esc and wait for the turn to stop, at most INTERRUPT_WAIT_MS. Nothing running: no Esc. */
  function interrupt(req: PromptRequest): Promise<void> {
    const { terminalId } = req;
    const session = current(req);
    if (!session || !INTERRUPTIBLE_STATUSES.has(session.status) || !stillOurs(req, session)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const off = deps.onTerminalHook(terminalId, (signal) => {
        if (TURN_OVER_EVENTS.has(signal.event) || TURN_OVER_STATUSES.has(signal.status)) finish();
      });
      timer = setTimeout(() => {
        log.info('prompt', `Interrupt of ${terminalId.slice(0, 12)}: no Stop within ${INTERRUPT_WAIT_MS} ms`);
        finish();
      }, INTERRUPT_WAIT_MS);
      // A failed Esc means the terminal is gone; the text write that follows fails too.
      if (!deps.write(terminalId, ESC)) finish();
    });
  }

  /**
   * Press Enter again until the prompt is acknowledged, or it is no longer safe.
   *
   * Sent while the agent was busy, the CLI queues the prompt, and the running
   * turn's own hooks (and its busy status) say nothing about it: only its
   * UserPromptSubmit confirms it. It is parked meanwhile, pressing nothing, and
   * the retries start over once the session is waiting again.
   */
  function confirm(req: PromptRequest, enterAt: number): Promise<PromptOutcome> {
    const { terminalId } = req;
    const interruptGrace = req.mode === 'interrupt' ? INTERRUPT_CANCEL_GRACE_MS : 0;
    return new Promise<PromptOutcome>((resolve) => {
      const atEnter = current(req);
      let parked = !!atEnter && BUSY_STATUSES.has(atEnter.status);
      const parkedAt = Date.now();
      // Retries count from the Enter, or from when a parked prompt's turn ended.
      let clockFrom = enterAt;
      let cancelFloor = enterAt + interruptGrace;
      let attempts = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const done = (outcome: PromptOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(outcome);
      };
      // A timer callback: an exception here would be uncaught and leave the listener behind.
      const guarded = (fn: () => void) => (): void => {
        try {
          fn();
        } catch (err: unknown) {
          log.error('prompt', `Enter retry for ${terminalId.slice(0, 12)} failed: ${err instanceof Error ? err.message : String(err)}`);
          done('failed');
        }
      };

      const schedule = (): void => {
        const after = SUBMIT_RETRY_AFTER_MS[attempts]
          ?? SUBMIT_RETRY_AFTER_MS[SUBMIT_RETRY_AFTER_MS.length - 1] + SUBMIT_GIVE_UP_GRACE_MS;
        timer = setTimeout(guarded(step), Math.max(0, clockFrom + after - Date.now()));
      };
      const unpark = (): void => {
        parked = false;
        clearTimeout(timer);
        clockFrom = Date.now();
        // The Stop that ended the turn may be the interrupt's own, stamped as a cancel.
        if (interruptGrace) cancelFloor = clockFrom + interruptGrace;
        schedule();
      };
      // While parked, a status that changes without a hook (auto-idle) is noticed here.
      const parkCheck = (): void => {
        timer = setTimeout(guarded(() => {
          const session = current(req);
          if (!session || session.status === SESSION_STATUS.ENDED || !stillOurs(req, session)) { done('stopped'); return; }
          if (RETRYABLE_STATUSES.has(session.status)) { unpark(); return; }
          if (Date.now() - parkedAt >= BUSY_PARK_MAX_MS) { done('gave-up'); return; }
          parkCheck();
        }), BUSY_PARK_CHECK_MS);
      };
      const step = (): void => {
        const session = current(req);
        if (!session || !stillOurs(req, session)) { done('stopped'); return; }
        const now = Date.now();
        const decision = submitRetryDecision({ terminalId, enterAt: clockFrom, attempts }, {
          now,
          status: session.status,
          terminalId,
          // An interrupt's own Esc stamps a cancel around this Enter; only a later one is the user's.
          userCancelled: (session.userCancelledAt ?? 0) > cancelFloor,
          // This request IS the submit: there is no Auto-Enter toggle to switch off.
          autoEnter: true,
        });
        if (decision === 'done') { done(BUSY_STATUSES.has(session.status) ? 'submitted' : 'stopped'); return; }
        if (decision === 'give-up') { done('gave-up'); return; }
        if (decision === 'retry') {
          attempts = retriesElapsed(now - clockFrom);
          if (!deps.write(terminalId, ENTER)) { done('failed'); return; }
        }
        schedule();
      };

      const off = deps.onTerminalHook(terminalId, (signal) => {
        if (signal.event === EVENT_TYPES.USER_PROMPT_SUBMIT) { done('submitted'); return; }
        if (parked) {
          if (signal.status === SESSION_STATUS.ENDED) done('stopped');
          else if (RETRYABLE_STATUSES.has(signal.status)) unpark();
          return;
        }
        if (!RETRYABLE_STATUSES.has(signal.status)) done(BUSY_STATUSES.has(signal.status) ? 'submitted' : 'stopped');
      });
      if (parked) parkCheck();
      else schedule();
    });
  }

  async function run(req: PromptRequest, progress: { typed: boolean }): Promise<PromptOutcome> {
    const { terminalId, text } = req;
    const imagePaths = req.imagePaths ?? [];
    if (req.mode === 'interrupt') await interrupt(req);
    // Checked again before each keystroke: an interrupt or a previous prompt may have
    // waited seconds, and the pause before Enter is one or two more.
    if (!mayType(req)) return 'stopped';
    const typed = imagePaths.length > 0 ? `${text}\n${imagePaths.join('\n')}` : text;
    if (!deps.write(terminalId, typed)) return 'failed';
    progress.typed = true;
    await sleep(submitDelayFor(imagePaths.length));
    // A dialog that opened meanwhile would take this Enter as its answer.
    if (!mayType(req)) return 'stopped';
    if (!deps.write(terminalId, ENTER)) return 'failed';
    const enterAt = Date.now();
    if (!mayConfirmSubmit(text, true)) return 'unconfirmed';
    return confirm(req, enterAt);
  }

  /**
   * May a prompt go after `previous` has finished? Only when the input box is
   * known to be empty: the previous one was taken, typed nothing, or was a slash
   * command. Text left behind by one that stopped or gave up would be sent along
   * with this one. Waits at most PREVIOUS_PROMPT_WAIT_MS.
   */
  async function mayFollow(terminalId: string, previous: Slot): Promise<boolean> {
    const before = await within(previous.done, PREVIOUS_PROMPT_WAIT_MS);
    if (!before) {
      log.info('prompt', `Prompt for ${terminalId.slice(0, 12)} dropped: the one before it is still in progress`);
      return false;
    }
    return before.outcome === 'submitted' || before.outcome === 'unconfirmed' || !before.typed;
  }

  function leave(terminalId: string, slot: Slot): void {
    const rest = (lines.get(terminalId) ?? []).filter((s) => s !== slot);
    if (rest.length > 0) lines.set(terminalId, rest);
    else lines.delete(terminalId);
  }

  async function submit(req: PromptRequest): Promise<PromptResult> {
    const { terminalId } = req;
    const line = lines.get(terminalId) ?? [];
    if (line.length >= MAX_PER_TERMINAL) {
      log.warn('prompt', `Prompt for ${terminalId.slice(0, 12)} refused: one is already waiting`);
      return { outcome: 'stopped', typed: false };
    }
    const slot = newSlot();
    const previous = line[line.length - 1];
    lines.set(terminalId, [...line, slot]);
    const progress = { typed: false };
    let outcome: PromptOutcome = 'failed';
    try {
      outcome = previous && !(await mayFollow(terminalId, previous)) ? 'stopped' : await run(req, progress);
      const level = outcome === 'failed' || outcome === 'gave-up' ? 'warn' : outcome === 'stopped' ? 'info' : 'debug';
      log[level]('prompt', `Prompt for ${terminalId.slice(0, 12)} (${req.mode}): ${outcome}`);
      return { outcome, typed: progress.typed };
    } finally {
      const result = { outcome, typed: progress.typed };
      if (outcome === 'unconfirmed') {
        // A slash command fires no UserPromptSubmit and may still be running (a /clear's
        // SessionStart hooks): the next prompt waits for its first hook, or SLASH_SETTLE_MS.
        void nextHookOr(terminalId, SLASH_SETTLE_MS).then(() => { slot.release(result); leave(terminalId, slot); });
      } else {
        slot.release(result);
        leave(terminalId, slot);
      }
    }
  }

  return {
    hasRoom: (terminalId) => (lines.get(terminalId)?.length ?? 0) < MAX_PER_TERMINAL,
    submit,
  };
}

/**
 * Request keys seen in the last PROMPT_KEY_TTL_MS, with what was answered: a phone
 * that retries a send it never heard back about gets the first answer, not a second
 * send. Kept from the first use (not refreshed on a hit), oldest dropped first.
 */
export function createPromptKeyCache<T>(opts: { ttlMs?: number; max?: number; now?: () => number } = {}): {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
} {
  const ttlMs = opts.ttlMs ?? PROMPT_KEY_TTL_MS;
  const max = opts.max ?? PROMPT_KEY_MAX;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { value: T; at: number }>();
  const prune = (): void => {
    const t = now();
    for (const [key, entry] of entries) {
      if (t - entry.at < ttlMs) break;
      entries.delete(key);
    }
  };
  return {
    get(key) {
      prune();
      return entries.get(key)?.value;
    },
    set(key, value) {
      prune();
      entries.delete(key);
      entries.set(key, { value, at: now() });
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

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
// Unlike the browser, the Mac sees which hook arrived: the acknowledgement is the
// UserPromptSubmit hook for that terminal (or the session going busy), never just
// any hook, so an idle notification can't pass for a submitted prompt.
//
// `interrupt` presses Esc first and waits (at most 10 s) for the turn to stop.
// Claude Code fires an ordinary Stop for an Esc; the transcript check that follows
// it stamps `userCancelledAt` (sessionStore), which is why only a cancel stamped
// after this prompt's own Enter counts as the user taking over.

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
 * - submitted    the CLI acknowledged it (UserPromptSubmit, or the session went busy)
 * - unconfirmed  sent once and deliberately not confirmed (a slash command)
 * - stopped      no longer safe to press Enter (a dialog, a cancel, the agent gone, another driver)
 * - gave-up      every retry was pressed and nothing acknowledged it
 * - failed       the terminal is gone: a write did not reach it
 * - superseded   a newer prompt for the same terminal took over the input box
 */
export type PromptOutcome = 'submitted' | 'unconfirmed' | 'stopped' | 'gave-up' | 'failed' | 'superseded';

/** What the submitter reads of the session that owns a terminal. */
export interface PromptSessionView {
  sessionId: string;
  status: string;
  userCancelledAt?: number | null;
}

export interface PromptSubmitDeps {
  /** Write to the terminal's PTY; false when the terminal is gone. */
  write(terminalId: string, data: string): boolean;
  /** The session that owns this terminal now, or null. */
  sessionOfTerminal(terminalId: string): PromptSessionView | null;
  /** Is the agent itself the terminal's foreground program (not the shell underneath)? */
  isAgentForeground(terminalId: string): boolean;
  /** Hear every hook processed for the terminal's session (hookSignals.onTerminalHook). */
  onTerminalHook(terminalId: string, listener: (signal: HookSignal) => void): () => void;
}

export interface PromptRequest {
  terminalId: string;
  text: string;
  /** Absolute paths of uploaded images, typed under the text as the queue does. */
  imagePaths?: readonly string[];
  mode: PromptMode;
  /** May the requesting device still drive the session? Checked before each repeated Enter. */
  mayDrive?: (sessionId: string) => boolean;
}

interface Job {
  /** Resolves once this job's first Enter is written (or it ended before that). */
  entered: Promise<void>;
  markEntered: () => void;
  superseded: boolean;
  /** Ends the confirm phase early, while it runs. */
  cancel: (() => void) | null;
}

function newJob(): Job {
  let markEntered = (): void => {};
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  return { entered, markEntered, superseded: false, cancel: null };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createPromptSubmitter(deps: PromptSubmitDeps): { submit(req: PromptRequest): Promise<PromptOutcome> } {
  /** The newest job per terminal: one prompt types into an input box at a time. */
  const active = new Map<string, Job>();

  /** Press Esc and wait for the turn to stop, at most INTERRUPT_WAIT_MS. Nothing running: no Esc. */
  function interrupt(terminalId: string): Promise<void> {
    const session = deps.sessionOfTerminal(terminalId);
    if (!session || !INTERRUPTIBLE_STATUSES.has(session.status)) return Promise.resolve();
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
        log.info('prompt', `Interrupt of ${terminalId.slice(0, 12)}: no Stop within ${INTERRUPT_WAIT_MS} ms, typing anyway`);
        finish();
      }, INTERRUPT_WAIT_MS);
      // A failed Esc means the terminal is gone; the text write that follows fails too.
      if (!deps.write(terminalId, ESC)) finish();
    });
  }

  /** Press Enter again until the prompt is acknowledged, or it is no longer safe. */
  function confirm(req: PromptRequest, job: Job, enterAt: number): Promise<PromptOutcome> {
    const { terminalId } = req;
    if (job.superseded) return Promise.resolve('superseded');
    return new Promise<PromptOutcome>((resolve) => {
      let attempts = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const done = (outcome: PromptOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        job.cancel = null;
        resolve(outcome);
      };
      const off = deps.onTerminalHook(terminalId, (signal) => {
        if (signal.event === EVENT_TYPES.USER_PROMPT_SUBMIT) done('submitted');
        else if (!RETRYABLE_STATUSES.has(signal.status)) done(BUSY_STATUSES.has(signal.status) ? 'submitted' : 'stopped');
      });
      job.cancel = () => done('superseded');

      const schedule = (): void => {
        const after = SUBMIT_RETRY_AFTER_MS[attempts]
          ?? SUBMIT_RETRY_AFTER_MS[SUBMIT_RETRY_AFTER_MS.length - 1] + SUBMIT_GIVE_UP_GRACE_MS;
        timer = setTimeout(tick, Math.max(0, enterAt + after - Date.now()));
      };
      const tick = (): void => {
        const session = deps.sessionOfTerminal(terminalId);
        if (!session || (req.mayDrive && !req.mayDrive(session.sessionId))) { done('stopped'); return; }
        const now = Date.now();
        const decision = submitRetryDecision({ terminalId, enterAt, attempts }, {
          now,
          status: session.status,
          terminalId,
          // The interrupt's own Esc stamps a cancel before this Enter; only a later one is the user's.
          userCancelled: (session.userCancelledAt ?? 0) > enterAt,
          // This request IS the submit: there is no Auto-Enter toggle to switch off.
          autoEnter: true,
        });
        if (decision === 'done') { done(BUSY_STATUSES.has(session.status) ? 'submitted' : 'stopped'); return; }
        if (decision === 'give-up') { done('gave-up'); return; }
        if (decision === 'retry') {
          attempts = retriesElapsed(now - enterAt);
          if (!deps.write(terminalId, ENTER)) { done('failed'); return; }
        }
        schedule();
      };
      schedule();
    });
  }

  async function run(req: PromptRequest, job: Job): Promise<PromptOutcome> {
    const { terminalId, text } = req;
    const imagePaths = req.imagePaths ?? [];
    if (req.mode === 'interrupt') await interrupt(terminalId);
    // Re-checked here: an interrupt or a previous prompt may have waited seconds, and
    // once the agent exits the same keystrokes would run in the shell underneath.
    const session = deps.sessionOfTerminal(terminalId);
    if (!session || session.status === SESSION_STATUS.ENDED || !deps.isAgentForeground(terminalId)) return 'stopped';
    const typed = imagePaths.length > 0 ? `${text}\n${imagePaths.join('\n')}` : text;
    if (!deps.write(terminalId, typed)) return 'failed';
    await sleep(submitDelayFor(imagePaths.length));
    if (!deps.write(terminalId, ENTER)) return 'failed';
    const enterAt = Date.now();
    job.markEntered();
    if (!mayConfirmSubmit(text, true)) return 'unconfirmed';
    return confirm(req, job, enterAt);
  }

  async function submit(req: PromptRequest): Promise<PromptOutcome> {
    const job = newJob();
    const previous = active.get(req.terminalId);
    active.set(req.terminalId, job);
    if (previous) {
      // Its text and Enter go first; then its Enter retries stop, or one of them
      // would submit this prompt's text before its images were taken in.
      await previous.entered;
      previous.superseded = true;
      previous.cancel?.();
    }
    try {
      const outcome = await run(req, job);
      const level = outcome === 'failed' || outcome === 'gave-up' ? 'warn' : 'debug';
      log[level]('prompt', `Prompt for ${req.terminalId.slice(0, 12)} (${req.mode}): ${outcome}`);
      return outcome;
    } finally {
      job.markEntered();
      if (active.get(req.terminalId) === job) active.delete(req.terminalId);
    }
  }

  return { submit };
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

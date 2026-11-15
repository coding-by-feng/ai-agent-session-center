// brain.ts — the Voice central: the central session (server/mcp/) that does the work a voice call asks for.
//
// A call never acts by itself. Each delegation becomes one line typed into this central's terminal through the
// shared prompt submitter (promptSubmit.ts, the same path as a phone's Send), and the central's reply, read from its
// transcript once its turn ends, is what the voice says. So every action a call takes passes the central's own
// rails: its scope, policy, ledger and confirm cards. There is no second permission path.
//
// One question at a time: the answer is "the central's next reply", which only holds while one prompt is in flight.

import { EVENT_TYPES, SESSION_STATUS } from '../constants.js';
import type { HookSignal } from '../hookSignals.js';
import type { PromptRequest, PromptResult } from '../promptSubmit.js';
import { voiceHeader } from './voiceText.js';

/** How long one Voice-central turn may run before the call is told it timed out. */
export const TURN_TIMEOUT_MS = 10 * 60_000;

/** Reads of the transcript after the turn ends, waiting for the reply to be written. */
const ANSWER_READ_DELAYS_MS = [0, 300, 1_000, 2_500];

/** The parts of a transcript entry the answer read needs (ChatEntry from server/chat/). */
export interface BrainEntry {
  kind: string;
  text?: string;
}

/** Entries that can sit after a finished reply without meaning the turn went on. */
const AFTER_REPLY_OK: ReadonlySet<string> = new Set(['thinking', 'system']);

/**
 * The central's reply to the prompt carrying `header`: the last assistant text after that prompt, and only when
 * nothing but thinking or notices follows it (a tool call after it means the reply isn't final yet). Null otherwise.
 */
export function replyAfter(entries: readonly BrainEntry[], header: string): string | null {
  let asked = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e.kind === 'user' && typeof e.text === 'string' && e.text.includes(header)) { asked = i; break; }
  }
  if (asked < 0) return null;
  for (let i = entries.length - 1; i > asked; i -= 1) {
    const e = entries[i];
    if (e.kind === 'assistant' && typeof e.text === 'string' && e.text.trim()) return e.text;
    if (!AFTER_REPLY_OK.has(e.kind)) return null;
  }
  return null;
}

const TURN_OVER: ReadonlySet<string> = new Set([EVENT_TYPES.STOP, EVENT_TYPES.AGENT_TURN_COMPLETE]);

/** What the brain reads of the central's session. */
export interface BrainSession {
  sessionId: string;
  terminalId: string | null;
  status: string;
  title: string;
  projectName: string;
  remoteVisible: boolean;
  centralId: string;
  lastActivityAt: number;
}

export interface BrainDeps {
  centrals(): ReadonlyArray<{ centralId: string; kind: string }>;
  /** The central chosen in Settings, if any. */
  preferredCentralId(): string | null;
  /** The live card of a central (resolveCentralSession), or null. */
  sessionOfCentral(centralId: string): BrainSession | null;
  submit(req: PromptRequest): Promise<PromptResult>;
  onTerminalHook(terminalId: string, listener: (s: HookSignal) => void): () => void;
  /** The session's transcript entries (newest last), or null when it can't be read. */
  readEntries(session: BrainSession): Promise<readonly BrainEntry[] | null>;
  sleep(ms: number): Promise<void>;
}

export type BrainProblem = 'no_central' | 'not_running';

export type BrainErrorCode = BrainProblem | 'not_shared' | 'not_taken' | 'timeout' | 'no_answer' | 'cancelled';

const SPOKEN: Record<BrainErrorCode, string> = {
  no_central: 'No Voice central is set up in AASC, so I cannot do that yet.',
  not_running: 'The Voice central is not running. Start it in AASC and ask me again.',
  not_shared: 'The Voice central is no longer shared with this phone, so I cannot ask it.',
  not_taken: 'The Voice central did not take the request. It may be waiting on a dialog in AASC.',
  timeout: 'The Voice central is still working on that. I will not wait any longer for it.',
  no_answer: 'The Voice central finished but I could not read its answer.',
  cancelled: 'The call ended before the Voice central was asked.',
};

export class BrainError extends Error {
  /** What the voice says when this happens. */
  readonly spoken: string;
  constructor(readonly code: BrainErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BrainError';
    this.spoken = SPOKEN[code];
  }
}

/** The central that answers calls: the chosen one, else the only global one. */
export function findBrain(deps: Pick<BrainDeps, 'centrals' | 'preferredCentralId' | 'sessionOfCentral'>):
  { centralId: string; session: BrainSession } | { problem: BrainProblem } {
  const all = deps.centrals();
  const preferred = deps.preferredCentralId();
  const globals = all.filter((c) => c.kind === 'global');
  const chosen = (preferred !== null ? all.find((c) => c.centralId === preferred) : undefined)
    ?? (globals.length === 1 ? globals[0] : undefined);
  if (!chosen) return { problem: 'no_central' };
  const session = deps.sessionOfCentral(chosen.centralId);
  if (!session || !session.terminalId || session.status === SESSION_STATUS.ENDED) return { problem: 'not_running' };
  return { centralId: chosen.centralId, session };
}

export interface AskOptions {
  /** A call from this Mac; a remote call may ask only a central shared with remote devices. */
  isLocal: boolean;
  /** Aborted when the call ends: a question still waiting is dropped, one in progress stops being waited on. */
  signal?: AbortSignal;
}

export interface Brain {
  /**
   * Types `compose(tag)` into the Voice central and answers its reply. `tag` is this question's id, which the
   * typed line must carry (brainPrompt's `tag`) so the reply can be found. Throws BrainError.
   */
  ask(compose: (tag: string) => string, opts: AskOptions): Promise<string>;
}

export function createBrain(deps: BrainDeps, opts: { turnTimeoutMs?: number } = {}): Brain {
  const turnTimeoutMs = opts.turnTimeoutMs ?? TURN_TIMEOUT_MS;
  let line: Promise<unknown> = Promise.resolve();
  let asked = 0;
  const run = Math.random().toString(36).slice(2, 6);

  async function readAnswer(session: BrainSession, header: string): Promise<string> {
    for (const delay of ANSWER_READ_DELAYS_MS) {
      if (delay > 0) await deps.sleep(delay);
      const entries = await deps.readEntries(session).catch(() => null);
      const reply = entries ? replyAfter(entries, header) : null;
      if (reply) return reply;
    }
    throw new BrainError('no_answer');
  }

  async function askNow(compose: (tag: string) => string, ask: AskOptions): Promise<string> {
    if (ask.signal?.aborted) throw new BrainError('cancelled');
    const found = findBrain(deps);
    if ('problem' in found) throw new BrainError(found.problem);
    const { session } = found;
    // Checked again for every question, not only when the call started: unsharing the central stops a phone's call.
    if (!ask.isLocal && !session.remoteVisible) throw new BrainError('not_shared');
    const terminalId = session.terminalId as string;
    asked += 1;
    const tag = `q${run}${asked.toString(36)}`;

    let submitted = false;
    let finish: (outcome: 'done' | 'ended' | 'cancelled') => void = () => {};
    const turnOver = new Promise<'done' | 'ended' | 'cancelled'>((resolve) => { finish = resolve; });
    const onAbort = (): void => finish('cancelled');
    ask.signal?.addEventListener('abort', onAbort, { once: true });
    // Subscribed before typing, so a fast turn's Stop is not missed; only hooks after the prompt was taken count.
    const unsubscribe = deps.onTerminalHook(terminalId, (signal) => {
      if (signal.event === EVENT_TYPES.SESSION_END || signal.status === SESSION_STATUS.ENDED) finish('ended');
      else if (submitted && TURN_OVER.has(signal.event)) finish('done');
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await deps.submit({ sessionId: session.sessionId, terminalId, text: compose(tag), mode: 'now' });
      if (result.outcome !== 'submitted') throw new BrainError('not_taken', result.outcome);
      submitted = true;
      const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), turnTimeoutMs); });
      const how = await Promise.race([turnOver, timeout]);
      if (how === 'timeout') throw new BrainError('timeout');
      if (how === 'ended') throw new BrainError('not_running');
      if (how === 'cancelled') throw new BrainError('cancelled');
      return await readAnswer(session, voiceHeader(tag));
    } finally {
      clearTimeout(timer);
      unsubscribe();
      ask.signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    ask(compose, ask) {
      const next = line.then(() => askNow(compose, ask));
      line = next.catch(() => {});
      return next;
    },
  };
}

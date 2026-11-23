// runtimeChange.ts — a session's model or effort changed on request, typed only when the session is free and reported
// only once the CLI's own record shows it (Nov 23 2026).
//
// `session_set_model` / `session_set_effort` (a worker) and `central_set_runtime` (the calling central itself, after
// the person allows it) used to type `/model <m>` or `/effort <e>` at once and answer "sent". Typed mid-turn, the line
// lands as a queued message in the CLI's input; typed into the calling central, it always would, since the central is
// in its turn when it calls a tool. Nothing checked that the CLI took it. Now a tool schedules a change here and:
//
//   waiting      until the session is free, every condition below at one tick (TICK_MS):
//                  its live card in the same terminal, `idle` or `waiting` for SETTLE_MS, started, no open dialog,
//                  no person at it (presence within PERSON_GAP_MS, or input since the card's last activity: a draft),
//                  room on the terminal (no prompt waiting to be typed), a queue that will not auto-send its next
//                  prompt (it would race the line), then the caller's own `check`: for a worker
//                  the steering rails again (policy.ts; HUMAN_ACTIVE and BUSY wait, any other refusal fails it), for a
//                  central's own card that it is still its live, not hands-off card with no Esc hold.
//                Past WAIT_TTL_MS it is `expired`.
//   typed        the line went in (`/model opus`); the card's `runtime` (sessionRuntime.ts) is watched:
//                  model   `launchModel` is the value, set at or after the typing, or `model` names the same model
//                          (an alias matches its family: `opus` ↔ `Opus 5.5`)
//                  effort  `effort` is the value, set at or after the typing
//                Claude writes the record the moment the command runs; Codex only at its next turn, so a Codex change
//                is watched for CODEX_CONFIRM_MS and a Claude one for CLAUDE_CONFIRM_MS.
//                Mid-conversation Claude Code asks first ("Switch model?" / "Change effort level?": the next reply
//                re-reads the whole history; 2.1.330). The screen is read each tick: when the question names the
//                value asked for, its "Yes, switch to …" is focused, nobody is at the session and the check still
//                passes, AASC presses Enter once (the person asked for this change). A focused "No" (a draft in the
//                box) gets Esc and the change is not applied; a question naming something else, or with a person
//                there, is left to the person.
//   confirmed    the record shows it.
//   not-applied  the CLI kept what it had ("Kept model as …", `modelKeptAt` / `effortKeptAt`), said it has no such
//                command, the typing stopped part-way, the check refused it, or no record came in time (an unknown
//                model, for one).
//   replaced     a newer change of the same kind for the same session came before this one was typed.
//
// One change per session is typed at a time, oldest first: a model then an effort (a model switch resets the effort,
// so the order matters). Every final state is told to `onChange` listeners (the activity row, the typed notice, a
// voice call) and to `waitFor`. Values reach here validated (sessionCard.ts / centralRuntime.ts): a model is letters,
// digits, `.`, `_`, `-`; an effort one the CLI takes.
//
// Pure apart from its timer: the store, presence, the submitter and the activity log are handed in (deliverWiring.ts).

import { randomUUID } from 'node:crypto';
import { modelLabelKey } from '../../src/lib/modelLabel.js';
import type { Session } from '../../src/types/session.js';
import { startPending } from '../heardTerminals.js';
import log from '../logger.js';
import type { PromptRequest, PromptResult } from '../promptSubmit.js';
import type { ActivityLog } from './activity.js';
import { MCP_CLIENT_PREFIX } from './policy.js';
import { waitsOnPerson } from './tools/views.js';
import type { CliKind } from './types.js';
import type { WorkerController } from './workers.js';

export const TICK_MS = 2_000;
/** How long the card must have been idle or waiting (its `lastActivityAt`) before anything is typed. */
export const SETTLE_MS = 3_000;
/** A person at the session this recently holds the change. */
export const PERSON_GAP_MS = 60_000;
/** The longest a change waits for its session to come free. */
export const WAIT_TTL_MS = 10 * 60_000;
export const CLAUDE_CONFIRM_MS = 60_000;
export const CODEX_CONFIRM_MS = 30 * 60_000;
/** The most submits that typed nothing before a change is given up. */
export const TYPE_TRIES = 3;
/** Final changes remembered for `get`. */
const DONE_KEPT = 200;

export type SettingKind = 'model' | 'effort';
export type ChangeState = 'waiting' | 'typed' | 'confirmed' | 'not-applied' | 'expired' | 'replaced';

/** What the caller's own check says just before typing. */
export type ChangeCheck = { go: true } | { go: false; wait: true } | { go: false; wait: false; reason: string };

export interface ChangeRequest {
  centralId: string;
  sessionId: string;
  terminalId: string;
  cli: CliKind;
  kind: SettingKind;
  value: string;
  /** The calling central's own card. */
  self: boolean;
  /** Re-asked just before the line is typed (see the header). */
  check(): ChangeCheck;
}

export interface SettingChange {
  readonly changeId: string;
  readonly centralId: string;
  readonly sessionId: string;
  readonly terminalId: string;
  readonly cli: CliKind;
  readonly kind: SettingKind;
  readonly value: string;
  readonly self: boolean;
  readonly askedAt: number;
  readonly typedAt: number | null;
  readonly state: ChangeState;
  /** AASC's words for why it is not applied; null otherwise. */
  readonly reason: string | null;
  readonly decidedAt: number | null;
}

export interface RuntimeChangeDeps {
  sessions(): readonly Session[];
  /** Who drove the session last (presence), or null. */
  controller(sessionId: string): WorkerController | null;
  /** Is there room on this terminal for one more prompt (promptSubmit.ts `hasRoom`)? */
  hasRoom(terminalId: string): boolean;
  submit(req: PromptRequest): Promise<PromptResult>;
  /** Will the session's queue type its next prompt by itself when the session comes free? Then the change waits. */
  queueWillSend?(sessionId: string): Promise<boolean>;
  activity?: Pick<ActivityLog, 'logActivity'>;
  now(): number;
  /** The terminal's screen now, one string per row (sshManager `readTerminalScreenCells`); null when unknown. */
  screen?(terminalId: string): Promise<readonly string[] | null>;
  /** Writes keys into the terminal: Enter or Esc answering the CLI's switch question. */
  press?(terminalId: string, keys: string): void;
  /** Test seam: no interval timer (the test calls `tick`). */
  manual?: boolean;
}

export interface RuntimeChangeBox {
  schedule(req: ChangeRequest): SettingChange;
  get(changeId: string): SettingChange | null;
  /** The change once it is final, or as it is when `ms` ran out or `signal` aborted. */
  waitFor(changeId: string, ms: number, signal?: AbortSignal): Promise<SettingChange | null>;
  /** Every change reaching a final state. Returns the unsubscribe. */
  onChange(listener: (change: SettingChange) => void): () => void;
  tick(): Promise<void>;
  close(): void;
}

const IDLE = new Set(['idle', 'waiting']);
const FINAL: ReadonlySet<ChangeState> = new Set(['confirmed', 'not-applied', 'expired', 'replaced']);

export const isFinal = (state: ChangeState): boolean => FINAL.has(state);

/** The line typed for a change. */
export const commandLine = (kind: SettingKind, value: string): string => `/${kind} ${value}`;

/** Does a model name or label (`Opus 5.5`, `claude-opus-5-5`) name the model asked for? An alias (`opus`) names a family. */
function namesModel(label: string, value: string): boolean {
  const want = value.toLowerCase();
  const have = modelLabelKey(label);
  return have === modelLabelKey(value) || (/^[a-z]+$/.test(want) && have.startsWith(`${want} `));
}

/** Does the card's runtime record show this change, made at or after `since`? */
export function runtimeShows(card: Pick<Session, 'runtime'>, kind: SettingKind, value: string, since: number): boolean {
  const rt = card.runtime;
  if (!rt) return false;
  if (kind === 'effort') return rt.effort === value && (rt.effortAt ?? 0) >= since;
  if (rt.launchModel !== undefined && rt.launchModel.toLowerCase() === value.toLowerCase() && (rt.launchModelAt ?? 0) >= since) return true;
  if (rt.model === undefined || (rt.modelAt ?? 0) < since) return false;
  return namesModel(rt.model, value);
}

/** Did the CLI keep what it had ("Kept model as …") at or after `since`? */
export function runtimeKept(card: Pick<Session, 'runtime'>, kind: SettingKind, since: number): boolean {
  const at = kind === 'model' ? card.runtime?.modelKeptAt : card.runtime?.effortKeptAt;
  return at !== undefined && at >= since;
}

/** Claude Code's question before a mid-conversation switch, as drawn on its screen (2.1.330). */
export interface SwitchQuestion {
  /** What it would switch to: `Opus 5.5`, `low`. */
  label: string;
  /** The `❯` is on "Yes, switch to …" (it is unless a draft sits in the input box). */
  yesFocused: boolean;
}

const QUESTION_TITLE: Record<SettingKind, string> = { model: 'Switch model?', effort: 'Change effort level?' };
const YES_ROW = /Yes, switch to (.+?)\s*$/;

/** The switch question on `rows`, or null. Only below its own title, so an old copy higher up is not taken. */
export function switchQuestion(rows: readonly string[], kind: SettingKind): SwitchQuestion | null {
  let title = -1;
  rows.forEach((row, i) => {
    if (row.includes(QUESTION_TITLE[kind])) title = i;
  });
  if (title < 0) return null;
  for (const row of rows.slice(title + 1)) {
    const yes = YES_ROW.exec(row);
    if (yes) return { label: yes[1], yesFocused: row.trimStart().startsWith('❯') };
  }
  return null;
}

/** Does the question's label name the value asked for? */
export function questionMatches(kind: SettingKind, value: string, label: string): boolean {
  return kind === 'model' ? namesModel(label, value) : label.trim().toLowerCase() === value.toLowerCase();
}

const ENTER = '\r';
const ESC = '\x1b';

export function createRuntimeChangeBox(deps: RuntimeChangeDeps): RuntimeChangeBox {
  // Change id → change; replaced, never edited. The checks live beside it.
  let changes = new Map<string, SettingChange>();
  const checks = new Map<string, () => ChangeCheck>();
  const tries = new Map<string, number>();
  const typing = new Set<string>();
  // The switch question per change: answered Yes by AASC, or left to the person.
  const answered = new Set<string>();
  const leftToPerson = new Set<string>();
  const listeners = new Set<(change: SettingChange) => void>();
  const waiters = new Map<string, Set<(change: SettingChange) => void>>();
  let closed = false;

  const put = (next: SettingChange): void => {
    changes = new Map(changes).set(next.changeId, next);
    if (!isFinal(next.state)) return;
    checks.delete(next.changeId);
    tries.delete(next.changeId);
    leftToPerson.delete(next.changeId);
    const done = [...changes.values()].filter((c) => isFinal(c.state));
    if (done.length > DONE_KEPT) {
      const drop = new Set(done.slice(0, done.length - DONE_KEPT).map((c) => c.changeId));
      changes = new Map([...changes].filter(([id]) => !drop.has(id)));
    }
    report(next);
    answered.delete(next.changeId);
    for (const resolve of waiters.get(next.changeId) ?? []) resolve(next);
    waiters.delete(next.changeId);
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (err) {
        log.warn('mcp', `A setting-change listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const finish = (c: SettingChange, state: ChangeState, reason: string | null = null): void =>
    put({ ...c, state, reason, decidedAt: deps.now() });

  const report = (c: SettingChange): void => {
    if (!deps.activity || c.state === 'replaced') return;
    // AASC's words only: the value stays out of the row (activity.ts), the kind says enough.
    const what = c.kind === 'model' ? 'model change' : 'effort change';
    const whose = c.self ? 'the central’s own session' : 'the session';
    const asked = answered.has(c.changeId) ? ', after AASC answered its switch question' : '';
    const summary =
      c.state === 'confirmed'
        ? `The CLI confirmed the ${what} in ${whose}${asked}.`
        : `The ${what} was not applied in ${whose}${c.reason ? `: ${c.reason}.` : '.'}`;
    try {
      deps.activity.logActivity({
        centralId: c.centralId,
        tool: c.self ? 'central_set_runtime' : `session_set_${c.kind}`,
        risk: 'steers',
        targetSessionId: c.sessionId,
        summary,
        outcome: c.state === 'confirmed' ? 'ok' : 'failed',
        detail: { changeId: c.changeId, kind: c.kind, state: c.state },
      });
    } catch (err) {
      log.warn('mcp', `A setting change's activity row failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** The live card in the change's terminal, or null. */
  const cardOf = (c: SettingChange): Session | null =>
    deps.sessions().find((s) => s.terminalId === c.terminalId && s.status !== 'ended') ?? null;

  /** Is a person at the card: presence this recently, or input since its last activity (an unsent draft)? */
  const personThere = (card: Session): boolean => {
    const holder = deps.controller(card.sessionId);
    if (holder === null || holder.clientId.startsWith(MCP_CLIENT_PREFIX)) return false;
    if (deps.now() - holder.lastActivityAt < PERSON_GAP_MS) return true;
    return holder.lastInputAt !== undefined && holder.lastInputAt > card.lastActivityAt;
  };

  const free = (card: Session): boolean =>
    IDLE.has(card.status) &&
    deps.now() - card.lastActivityAt >= SETTLE_MS &&
    !startPending(card) &&
    !waitsOnPerson(card) &&
    !personThere(card) &&
    deps.hasRoom(card.terminalId ?? '');

  const typeOne = async (c: SettingChange): Promise<void> => {
    if (deps.now() - c.askedAt > WAIT_TTL_MS) {
      finish(c, 'expired', 'the session did not come free in time');
      return;
    }
    const card = cardOf(c);
    if (card === null) {
      finish(c, 'not-applied', 'the session has ended');
      return;
    }
    if (!free(card)) return;
    if (deps.queueWillSend && (await deps.queueWillSend(card.sessionId).catch(() => true))) return;
    const check = checks.get(c.changeId)?.() ?? { go: false, wait: false, reason: 'it can no longer be checked' };
    if (!check.go) {
      if (!check.wait) finish(c, 'not-applied', check.reason);
      return;
    }
    const typedAt = deps.now();
    let result: PromptResult;
    try {
      result = await deps.submit({
        sessionId: card.sessionId,
        terminalId: c.terminalId,
        text: commandLine(c.kind, c.value),
        mode: 'now',
        mayDrive: (sessionId) => {
          const now = deps.sessions().find((s) => s.sessionId === sessionId);
          return now !== undefined && !personThere(now) && checks.get(c.changeId)?.().go === true;
        },
      });
    } catch (err) {
      log.warn('mcp', `A setting change could not be typed: ${err instanceof Error ? err.message : String(err)}`);
      result = { outcome: 'failed', typed: false };
    }
    const latest = changes.get(c.changeId);
    if (!latest || isFinal(latest.state)) return;
    if (result.outcome === 'submitted' || result.outcome === 'unconfirmed') {
      put({ ...latest, state: 'typed', typedAt });
      return;
    }
    if (result.outcome === 'unknown-command') {
      finish(latest, 'not-applied', `the CLI has no /${c.kind} command`);
      return;
    }
    const tried = (tries.get(c.changeId) ?? 0) + 1;
    tries.set(c.changeId, tried);
    if (result.typed) finish(latest, 'not-applied', 'the typing stopped part-way (a dialog opened or a person took over)');
    else if (tried >= TYPE_TRIES) finish(latest, 'not-applied', 'AASC could not type into the session');
  };

  /** Answers the CLI's switch question for a typed change, when it is ours to answer (see the header). */
  const answerQuestion = async (c: SettingChange, card: Session): Promise<void> => {
    if (c.cli !== 'claude' || !deps.screen || !deps.press || answered.has(c.changeId) || leftToPerson.has(c.changeId)) return;
    const rows = await deps.screen(c.terminalId).catch(() => null);
    const question = rows ? switchQuestion(rows, c.kind) : null;
    if (question === null) return;
    const latest = changes.get(c.changeId);
    if (!latest || isFinal(latest.state)) return;
    if (!questionMatches(c.kind, c.value, question.label) || personThere(card) || checks.get(c.changeId)?.().go !== true) {
      leftToPerson.add(c.changeId);
      return;
    }
    if (!question.yesFocused) {
      deps.press(c.terminalId, ESC);
      finish(latest, 'not-applied', 'Claude Code asked to confirm the switch and AASC could not answer it safely');
      return;
    }
    answered.add(c.changeId);
    deps.press(c.terminalId, ENTER);
  };

  const watchOne = async (c: SettingChange): Promise<void> => {
    const card = cardOf(c);
    if (card === null) {
      finish(c, 'not-applied', 'the session ended before the CLI confirmed it');
      return;
    }
    const since = c.typedAt ?? c.askedAt;
    if (runtimeShows(card, c.kind, c.value, since)) {
      finish(c, 'confirmed');
      return;
    }
    if (runtimeKept(card, c.kind, since)) {
      finish(c, 'not-applied', `Claude Code kept its current ${c.kind === 'model' ? 'model' : 'effort'} (its switch question was answered No, or the switch failed)`);
      return;
    }
    const limit = c.cli === 'codex' ? CODEX_CONFIRM_MS : CLAUDE_CONFIRM_MS;
    if (deps.now() - since > limit) {
      finish(c, 'not-applied', leftToPerson.has(c.changeId)
        ? 'Claude Code’s switch question is waiting for the person in the session'
        : c.cli === 'codex'
          ? 'Codex did not report it at a turn since'
          : 'the CLI did not record it (it may not know that value)');
      return;
    }
    await answerQuestion(c, card);
  };

  const tick = async (): Promise<void> => {
    if (closed) return;
    // Per session: confirm what was typed; type the oldest waiting change only when nothing is being confirmed.
    const bySession = new Map<string, SettingChange[]>();
    for (const c of changes.values()) {
      if (isFinal(c.state)) continue;
      bySession.set(c.terminalId, [...(bySession.get(c.terminalId) ?? []), c]);
    }
    await Promise.all(
      [...bySession.entries()].map(async ([terminalId, list]) => {
        // One pass per terminal at a time: a slow screen read must not let a second tick press a key too.
        if (typing.has(terminalId)) return;
        const typed = list.find((c) => c.state === 'typed');
        if (typed) {
          typing.add(terminalId);
          try {
            await watchOne(typed);
          } catch (err) {
            log.warn('mcp', `A setting-change watch failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            typing.delete(terminalId);
          }
          return;
        }
        const next = [...list].sort((a, b) => a.askedAt - b.askedAt)[0];
        if (!next) return;
        typing.add(terminalId);
        try {
          await typeOne(next);
        } catch (err) {
          log.warn('mcp', `A setting-change check failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          typing.delete(terminalId);
        }
      }),
    );
  };

  const timer = deps.manual ? null : setInterval(() => void tick(), TICK_MS);
  timer?.unref?.();

  return {
    schedule(req) {
      // A newer change of the same kind replaces one not yet typed.
      for (const c of changes.values()) {
        if (c.state === 'waiting' && c.terminalId === req.terminalId && c.kind === req.kind) finish(c, 'replaced');
      }
      const change: SettingChange = {
        changeId: randomUUID(),
        centralId: req.centralId,
        sessionId: req.sessionId,
        terminalId: req.terminalId,
        cli: req.cli,
        kind: req.kind,
        value: req.value,
        self: req.self,
        askedAt: deps.now(),
        typedAt: null,
        state: 'waiting',
        reason: null,
        decidedAt: null,
      };
      checks.set(change.changeId, req.check);
      changes = new Map(changes).set(change.changeId, change);
      return change;
    },
    get: (changeId) => changes.get(changeId) ?? null,
    waitFor(changeId, ms, signal) {
      const now = changes.get(changeId);
      if (!now || isFinal(now.state) || ms <= 0 || signal?.aborted) return Promise.resolve(now ?? null);
      return new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(timer_);
          signal?.removeEventListener('abort', done);
          waiters.get(changeId)?.delete(onFinal);
          resolve(changes.get(changeId) ?? null);
        };
        const onFinal = (): void => done();
        const timer_ = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
        waiters.set(changeId, new Set([...(waiters.get(changeId) ?? []), onFinal]));
      });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tick,
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      listeners.clear();
      for (const [id, set] of waiters) {
        const c = changes.get(id);
        if (c) for (const resolve of set) resolve(c);
      }
      waiters.clear();
    },
  };
}

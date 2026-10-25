// test/mcp/ledgerFixtures.ts — fake deps for the task ledger (server/mcp/ledger.ts): a session table the test
// edits, per-terminal hook listeners it fires like the hook pipeline (hookSignals.ts) does, a terminal-exit feed,
// and recorded submits, outcome polls, chat reads, interrupts and central Esc notes. Nothing reaches a real terminal
// or process.
//
// Whose prompt (Ruling 46): a UserPromptSubmit carries its prompt on the card (`currentPrompt`). `takePrompt` is the
// worker taking the task's own envelope (the last one AASC typed into that terminal); `typePrompt` is anybody else's.
//
// The chat page `readChat` gives is `chats.get(sessionId)` when a test set one; otherwise the task's own prompt (the
// last envelope sent with that head) and, after it, `answers.get(sessionId)` as the final assistant message.
//
// The clock is `Date.now()`, so a test under `vi.useFakeTimers()` moves it with the timers.
import { vi } from 'vitest';
import type { ChatEntry } from '../../src/types/chat.js';
import type { Session } from '../../src/types/session.js';
import { noteTerminalHeard } from '../../server/heardTerminals.js';
import type { HookSignal } from '../../server/hookSignals.js';
import type { LedgerDeps, PromptOutcomeState, PromptOutcomeView } from '../../server/mcp/ledger.js';
import { makeSession } from './toolHarness.js';

export interface SubmitCall {
  sessionId: string;
  text: string;
  key: string;
  centralId: string;
}

export interface ChatRead {
  sessionId: string;
  head: string;
  since: number;
  centralId: string;
}

export function fakeLedgerDeps() {
  const sessions = new Map<string, Session>();
  const hookListeners = new Map<string, Set<(s: HookSignal) => void>>();
  const exitListeners = new Set<(terminalId: string) => void>();
  const submits: SubmitCall[] = [];
  /** Each submit's terminal, as the session had it then (a re-key keeps the terminal). */
  const submitTerminals: Array<string | null> = [];
  const outcomes = new Map<string, PromptOutcomeState | PromptOutcomeView | null>();
  const answers = new Map<string, string | null>();
  const chats = new Map<string, ChatEntry[]>();
  const interrupts: Array<{ sessionId: string; terminalId: string }> = [];
  const escNotes: Array<{ sessionId: string; terminalId: string }> = [];
  const answerReads: ChatRead[] = [];
  /** Terminals whose foreground program is not the agent now. */
  const away = new Set<string>();
  const resumePrompts = new Map<string, string>();
  const control = { submitAnswer: { accepted: true, error: null } as { accepted: boolean; error: string | null }, pressed: true, failReads: 0, lastTask: 0 };

  /** The page of a session's chat the fake reads by default: the task's own prompt, then its answer. */
  function defaultPage(sessionId: string, head: string, since: number): ChatEntry[] {
    const sent = [...submits].reverse().find((c) => c.text.startsWith(head));
    const answer = answers.get(sessionId) ?? null;
    return [
      ...(sent ? [{ kind: 'user' as const, key: '1:0', timestamp: since, text: sent.text }] : []),
      ...(answer === null ? [] : [{ kind: 'assistant' as const, key: '2:0', timestamp: since + 1, text: answer }]),
    ];
  }

  const deps: LedgerDeps = {
    submit: vi.fn(async (sessionId: string, text: string, key: string, centralId: string) => {
      submits.push({ sessionId, text, key, centralId });
      submitTerminals.push(sessions.get(sessionId)?.terminalId ?? null);
      return control.submitAnswer;
    }),
    promptOutcome: vi.fn(async (_sessionId: string, key: string): Promise<PromptOutcomeView | null> => {
      const o = outcomes.get(key) ?? null;
      return typeof o === 'string' ? { state: o } : o;
    }),
    onTerminalHook(terminalId, listener) {
      const set = hookListeners.get(terminalId) ?? new Set();
      set.add(listener);
      hookListeners.set(terminalId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) hookListeners.delete(terminalId);
      };
    },
    onTerminalExit(listener) {
      const wrapped = (terminalId: string): void => listener(terminalId);
      exitListeners.add(wrapped);
      return () => {
        exitListeners.delete(wrapped);
      };
    },
    getSession: (id) => {
      const s = sessions.get(id);
      return s ? { ...s } : null;
    },
    readChat: vi.fn(async (sessionId: string, head: string, since: number, centralId: string) => {
      answerReads.push({ sessionId, head, since, centralId });
      if (control.failReads > 0) {
        control.failReads -= 1;
        throw new Error('EACCES /Users/x/.claude/projects/y.jsonl');
      }
      return chats.get(sessionId) ?? defaultPage(sessionId, head, since);
    }),
    interrupt: vi.fn(async (sessionId: string, terminalId: string) => {
      interrupts.push({ sessionId, terminalId });
      return control.pressed;
    }),
    noteCentralEsc: (sessionId, terminalId) => {
      escNotes.push({ sessionId, terminalId });
    },
    agentInFront: (terminalId) => !away.has(terminalId),
    lastTaskNumber: () => control.lastTask,
    resumePromptOf: (sessionId) => resumePrompts.get(sessionId) ?? null,
    now: () => Date.now(),
  };

  /** Adds (or replaces) a session the ledger can look up. */
  function setSession(s: Session): Session {
    sessions.set(s.sessionId, s);
    return s;
  }

  /** A worker: local, waiting, on its own terminal. */
  function worker(id = 'w1', over: Partial<Session> = {}): Session {
    return setSession(makeSession(id, { terminalId: `term-${id}`, status: 'waiting', ...over }));
  }

  /** Changes a session's fields (a new object: what the ledger was handed earlier stays as it was). */
  function patch(id: string, over: Partial<Session>): Session {
    const current = sessions.get(id);
    if (current === undefined) throw new Error(`no session ${id}`);
    return setSession({ ...current, ...over });
  }

  /**
   * A processed hook for session `id`: its fields change and its terminal is heard first (as sessionStore does), then
   * every listener on its terminal hears the signal hookSignals.ts would build. `hears: false` is a hook sessionStore
   * did not let hear the terminal (another tty's, Rulings P4-53 / P4-59): the listeners still get it.
   */
  function hook(event: string, id: string, over: Partial<Session> = {}, hears = true): void {
    const s = patch(id, over);
    if (!s.terminalId) throw new Error(`session ${id} has no terminal`);
    if (hears) noteTerminalHeard(s.terminalId);
    const signal: HookSignal = {
      event,
      sessionId: s.sessionId,
      terminalId: s.terminalId,
      status: s.status,
      userCancelledAt: s.userCancelledAt ?? null,
    };
    for (const listener of [...(hookListeners.get(s.terminalId) ?? [])]) listener(signal);
  }

  /** The last envelope AASC typed into session `id`'s terminal ('' when none). */
  function lastEnvelope(id: string): string {
    const terminal = sessions.get(id)?.terminalId ?? null;
    for (let i = submits.length - 1; i >= 0; i -= 1) {
      if (submits[i].sessionId === id || (terminal !== null && submitTerminals[i] === terminal)) return submits[i].text;
    }
    return '';
  }

  /** Session `id` takes the task's own prompt: its UserPromptSubmit, the envelope on the card. */
  function takePrompt(id = 'w1', over: Partial<Session> = {}): void {
    hook('UserPromptSubmit', id, { status: 'prompting', currentPrompt: lastEnvelope(id), ...over });
  }

  /** Session `id` takes somebody else's prompt (a person's, the queue's, another central's). */
  function typePrompt(id: string, text: string, over: Partial<Session> = {}): void {
    hook('UserPromptSubmit', id, { status: 'prompting', currentPrompt: text, ...over });
  }

  /** The hook a terminal sends after its session was re-keyed to `newId` (term-* → the CLI's own id). */
  function rekey(oldId: string, newId: string): void {
    const s = sessions.get(oldId);
    if (s === undefined) throw new Error(`no session ${oldId}`);
    sessions.delete(oldId);
    setSession({ ...s, sessionId: newId });
  }

  function exit(terminalId: string): void {
    for (const listener of [...exitListeners]) listener(terminalId);
  }

  return {
    deps,
    sessions,
    submits,
    outcomes,
    answers,
    chats,
    answerReads,
    interrupts,
    escNotes,
    resumePrompts,
    setSession,
    worker,
    patch,
    hook,
    takePrompt,
    typePrompt,
    lastEnvelope,
    rekey,
    exit,
    answerSubmitWith(answer: { accepted: boolean; error: string | null }): void {
      control.submitAnswer = answer;
    },
    /** What the next interrupts answer: true when the submitter pressed Esc. */
    interruptPresses(pressed: boolean): void {
      control.pressed = pressed;
    },
    /** The next `n` chat reads fail. */
    failChatReads(n: number): void {
      control.failReads = n;
    },
    /** The highest task number the activity log holds (read once, at the ledger's first task). */
    lastTaskNumberIs(n: number): void {
      control.lastTask = n;
    },
    /** Is the agent the terminal's foreground program? */
    agentInFront(terminalId: string, front: boolean): void {
      if (front) away.delete(terminalId);
      else away.add(terminalId);
    },
    hookListenerCount: (terminalId?: string): number =>
      terminalId === undefined
        ? [...hookListeners.values()].reduce((n, set) => n + set.size, 0)
        : (hookListeners.get(terminalId)?.size ?? 0),
    exitListenerCount: (): number => exitListeners.size,
  };
}

export type FakeLedgerDeps = ReturnType<typeof fakeLedgerDeps>;

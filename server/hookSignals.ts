// hookSignals.ts — a processed hook, announced to whoever waits on that terminal (AASC-42).
//
// A prompt the Mac types for a phone (promptSubmit.ts) is confirmed by the CLI's
// own UserPromptSubmit hook, and an interrupt waits for the turn's Stop. Both wait
// on one terminal, so listeners are kept per terminal id: the hook pipeline does one
// Map lookup per hook, and nothing at all when no one is waiting.

import log from './logger.js';

/** What a listener learns of a hook: its event and the session's state after it. */
export interface HookSignal {
  event: string;
  sessionId: string;
  terminalId: string;
  status: string;
  userCancelledAt?: number | null;
}

/** The fields of a session a signal is built from. */
export interface HookSignalSession {
  sessionId: string;
  terminalId?: string | null;
  status: string;
  userCancelledAt?: number | null;
}

type Listener = (signal: HookSignal) => void;

const listeners = new Map<string, Set<Listener>>();

/** Hear every hook processed for this terminal's session. Returns the unsubscribe. */
export function onTerminalHook(terminalId: string, listener: Listener): () => void {
  const set = listeners.get(terminalId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(terminalId, set);
  return () => {
    const current = listeners.get(terminalId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(terminalId);
  };
}

/** Called by the hook pipeline after each processed hook. Never throws. */
export function emitTerminalHook(event: string, session: HookSignalSession): void {
  const terminalId = session.terminalId;
  if (!terminalId) return;
  const set = listeners.get(terminalId);
  if (!set) return;
  const signal: HookSignal = {
    event,
    sessionId: session.sessionId,
    terminalId,
    status: session.status,
    userCancelledAt: session.userCancelledAt ?? null,
  };
  // A copy: a listener may unsubscribe (or subscribe another) while it is told.
  for (const listener of [...set]) {
    try {
      listener(signal);
    } catch (err: unknown) {
      log.error('hook', `Hook listener failed for terminal ${terminalId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function _resetHookSignalsForTests(): void {
  listeners.clear();
}

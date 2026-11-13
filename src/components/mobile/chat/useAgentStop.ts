/**
 * useAgentStop — the phone's one Stop: Esc written to the session's terminal the way the
 * phone's key bar writes keys (`writeTerminal`, POST /api/terminals/:id/write). Since Nov 13
 * 2026 it is the ■ beside the composer's send button, or full-screen Chat's strip, never both.
 *
 * One tap writes Esc at once, a running tool included (Nov 5 2026: a confirm sheet while a
 * tool ran made Stop two taps; Esc on the desktop never asked either). Once Esc is written,
 * Stop holds "Stopping…" and the status says "Stopping" until the turn ends, a new one starts,
 * or STOP_PENDING_MS passes with the agent still working (then Stop can be pressed again;
 * Oct 28 2026). Never a second Esc on its own: at Claude's idle prompt a second Esc opens its
 * rewind menu.
 *
 * The written Stop is kept per session outside React, so the status chip, the open peek's
 * header and the ■ (separate components) agree on "Stopping", and it outlives them: going full
 * screen swaps the ■ for the strip's Stop, which must still hold "Stopping…" (a second Esc at
 * the idle prompt opens the rewind menu). It ends by turn or STOP_PENDING_MS, never by unmount;
 * an ended entry is dropped at the next write.
 */
import { useState, useSyncExternalStore } from 'react';
import type { Session } from '@/types';
import { useControlBaton } from '@/hooks/useControlBaton';
import { PHONE_KEY_SEQUENCES, writeTerminal } from '@/lib/terminalCompose';

/** How long a written Stop holds "Stopping…" before Stop is offered again. */
export const STOP_PENDING_MS = 5_000;

/** When Esc was written, and for which turn (its start). */
export interface StopSent {
  at: number;
  turn: number;
}

let sentBySession: ReadonlyMap<string, StopSent> = new Map();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setSent(sessionId: string, sent: StopSent): void {
  // Entries no longer pending can't hold anything; drop them so the map stays small.
  const live = [...sentBySession].filter(([, s]) => sent.at - s.at < STOP_PENDING_MS);
  sentBySession = new Map([...live, [sessionId, sent]]);
  for (const listener of listeners) listener();
}

/** Forgets every written Stop. Tests only: the map outlives components, so it outlives a test. */
export function resetStopSent(): void {
  sentBySession = new Map();
}

export function useStopSent(sessionId: string): StopSent | null {
  return useSyncExternalStore(subscribe, () => sentBySession.get(sessionId) ?? null, () => null);
}

/** Does a written Stop still hold for this turn? (`now` may lag the write by a tick.) */
export function isStopPending(sent: StopSent | null, turn: number, now: number): boolean {
  return !!sent && sent.turn === turn && now - sent.at < STOP_PENDING_MS;
}

export interface AgentStop {
  /** Writes Esc; resolves to why it failed, or null. */
  stop: () => Promise<string | null>;
  /** The Esc write is in flight. */
  writing: boolean;
  /** Why the last write failed, until the next try. */
  error: string | null;
  disabledReason?: string;
}

/** Stop for `session`'s current turn (`turn` = its start, from useWorkingStatus). */
export function useAgentStop(session: Session, turn: number): AgentStop {
  const { sessionId, terminalId } = session;
  const baton = useControlBaton(sessionId);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = async () => {
    if (!terminalId) return null;
    setWriting(true);
    setError(null);
    const result = await writeTerminal(terminalId, PHONE_KEY_SEQUENCES.esc);
    setWriting(false);
    if (result.ok) {
      setSent(sessionId, { at: Date.now(), turn });
      return null;
    }
    setError(result.message);
    return result.message;
  };

  const disabledReason = !terminalId
    ? 'No terminal to stop'
    : baton.mode === 'spectator'
      ? `${baton.holder?.label ?? 'Another device'} is driving`
      : undefined;

  return { stop, writing, error, disabledReason };
}

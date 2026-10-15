/**
 * sessionReads.ts — when this phone last read each session (AASC-40).
 *
 * "Read" is per device: opening a session from the list, or "Mark read" on its
 * row, stamps it. A finished turn newer than the stamp is unread, which is what
 * keeps a session in the Sessions tab's Finished section (sessionsModel.ts).
 * Kept in localStorage (`aasc.phoneReads`, ids and times only), at most
 * MAX_READS entries, newest kept; one copy shared through useSyncExternalStore.
 *
 * A stamp is the session's own `lastActivityAt` (the Mac's clock), never the
 * phone's: unread compares against that same clock, so a phone running ahead
 * or behind the Mac can't mark a newer turn read or an old one unread. And a
 * session on show is being read: the session screen selects the session it
 * shows (from the list, the Inbox, a notification, "N more need you"), so
 * while it is selected each turn it finishes is read at once.
 */
import { useSyncExternalStore } from 'react';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import type { ReadMap } from './sessionsModel';

export const SESSION_READS_KEY = 'aasc.phoneReads';
export const MAX_READS = 200;

let reads: ReadMap = load();
const listeners = new Set<() => void>();

function load(): ReadMap {
  try {
    const raw = localStorage.getItem(SESSION_READS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
    }
    return out;
  } catch {
    return {};
  }
}

function save(next: ReadMap): void {
  try {
    localStorage.setItem(SESSION_READS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: reads last until the page reloads */
  }
}

/** The stamp that reads a session up to now, on the Mac's clock. */
export function readStamp(session: Pick<Session, 'lastActivityAt'>): number {
  return session.lastActivityAt || Date.now();
}

/** Stamp a session read now (or at `at`). */
export function markSessionRead(sessionId: string, at: number = Date.now()): void {
  if ((reads[sessionId] ?? 0) >= at) return;
  const entries = Object.entries({ ...reads, [sessionId]: at })
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_READS);
  reads = Object.fromEntries(entries);
  save(reads);
  listeners.forEach((l) => l());
}

export function getSessionReads(): ReadMap {
  return reads;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSessionReads(): ReadMap {
  return useSyncExternalStore(subscribe, getSessionReads, getSessionReads);
}

/** A session re-keyed: its read stamp follows the new id. */
export function moveSessionRead(oldId: string, newId: string): void {
  const at = reads[oldId];
  if (at === undefined) return;
  markSessionRead(newId, at);
}

/** Read the selected session (the one a session screen shows) up to its latest turn. */
export function readSelected(state: { selectedSessionId: string | null; sessions: ReadonlyMap<string, Session> }): void {
  const id = state.selectedSessionId;
  const session = id ? state.sessions.get(id) : undefined;
  if (id && session && session.status === 'waiting') markSessionRead(id, readStamp(session));
}

// Loaded only with the phone frame (lib/chat is phone code), and harmless after it.
useSessionStore.subscribe((state, prev) => {
  if (state.selectedSessionId !== prev.selectedSessionId || state.sessions !== prev.sessions) readSelected(state);
});

/** Tests: forget everything and re-read storage. */
export function resetSessionReadsForTest(): void {
  reads = load();
  listeners.forEach((l) => l());
}

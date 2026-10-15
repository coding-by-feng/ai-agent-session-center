/**
 * sessionReads.ts — when this phone last read each session (AASC-40).
 *
 * "Read" is per device: opening a session from the list, or "Mark read" on its
 * row, stamps it. A finished turn newer than the stamp is unread, which is what
 * keeps a session in the Sessions tab's Finished section (sessionsModel.ts).
 * Kept in localStorage (`aasc.phoneReads`, ids and times only), at most
 * MAX_READS entries, newest kept; one copy shared through useSyncExternalStore.
 */
import { useSyncExternalStore } from 'react';
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

/** Tests: forget everything and re-read storage. */
export function resetSessionReadsForTest(): void {
  reads = load();
  listeners.forEach((l) => l());
}

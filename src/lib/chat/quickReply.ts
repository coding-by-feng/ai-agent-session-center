/**
 * quickReply.ts — the phone composer's quick reply (Oct 21 2026): what its P button
 * sends in one tap. "proceed" unless this phone saved its own text, kept on this
 * phone only (`localStorage['aasc.quickReply']`), like the text size.
 */
import { useSyncExternalStore } from 'react';

export const QUICK_REPLY_KEY = 'aasc.quickReply';
export const DEFAULT_QUICK_REPLY = 'proceed';
export const QUICK_REPLY_MAX = 500;

const listeners = new Set<() => void>();

function clean(value: string | null): string {
  const text = (value ?? '').trim().slice(0, QUICK_REPLY_MAX);
  return text || DEFAULT_QUICK_REPLY;
}

export function readQuickReply(): string {
  try {
    return clean(localStorage.getItem(QUICK_REPLY_KEY));
  } catch {
    return DEFAULT_QUICK_REPLY;
  }
}

let current = readQuickReply();

/** Save `text` (trimmed, capped); blank or the default removes the key. Returns what was kept. */
export function setQuickReply(text: string): string {
  const next = clean(text);
  try {
    if (next === DEFAULT_QUICK_REPLY) localStorage.removeItem(QUICK_REPLY_KEY);
    else localStorage.setItem(QUICK_REPLY_KEY, next);
  } catch {
    /* storage unavailable: the text lasts until the page reloads */
  }
  current = next;
  listeners.forEach((l) => l());
  return next;
}

/** Tests: read storage again (it is read once at load). */
export function resetQuickReplyForTest(): void {
  current = readQuickReply();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

export function useQuickReply(): string {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

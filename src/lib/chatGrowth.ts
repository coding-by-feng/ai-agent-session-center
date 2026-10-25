/**
 * chatGrowth.ts — how many times the Mac said a session's conversation grew (`chat_grew`,
 * Oct 22 2026). The Mac watches a transcript while a phone reads its chat and says so the moment
 * Claude writes to it; `useChatLive` folds the count into its re-read cue, so a reply between tool
 * calls shows as soon as it is written instead of on the next hook or the 8 s poll.
 */
import { useSyncExternalStore } from 'react';

const counts = new Map<string, number>();
const listeners = new Set<() => void>();

/** The Mac said this session's transcript grew. */
export function noteChatGrew(sessionId: string): void {
  counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** How often this session's transcript grew since the app started (0 when never heard). */
export function useChatGrowth(sessionId: string): number {
  const read = () => counts.get(sessionId) ?? 0;
  return useSyncExternalStore(subscribe, read, read);
}

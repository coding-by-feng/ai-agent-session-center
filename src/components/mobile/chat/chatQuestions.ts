/**
 * chatQuestions — what the chat's question cards (items/QuestionCard) share with the rest of the
 * session screen (Nov 2 2026):
 *
 * - Which open requests a question card in the chat is answering. The waiting card above the
 *   composer reads it and stops repeating the same choices; while no card in the chat answers
 *   it (not loaded yet, scrolled out of the window), the waiting card keeps its buttons.
 * - How to open the terminal, for "Answer in Terminal": ChatView provides it, so the memoised
 *   rows need no new prop (as fileLinkContext does for file links).
 */
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';

const answering = new Map<string, number>();
const listeners = new Set<() => void>();
const keyOf = (sessionId: string, requestId: string) => `${sessionId}\n${requestId}`;
const notify = () => listeners.forEach((l) => l());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** A question card answers this request while it is mounted (null: it answers none). */
export function useAnswerInChat(sessionId: string, requestId: string | null): void {
  useEffect(() => {
    if (!requestId) return;
    const key = keyOf(sessionId, requestId);
    answering.set(key, (answering.get(key) ?? 0) + 1);
    notify();
    return () => {
      const left = (answering.get(key) ?? 1) - 1;
      if (left > 0) answering.set(key, left);
      else answering.delete(key);
      notify();
    };
  }, [sessionId, requestId]);
}

/** Is a question card in the chat answering this request? */
export function useAnsweredInChat(sessionId: string, requestId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => !!requestId && answering.has(keyOf(sessionId, requestId)));
}

export const ChatTerminalContext = createContext<(() => void) | null>(null);

export function useChatTerminal(): (() => void) | null {
  return useContext(ChatTerminalContext);
}

/**
 * queueAppend — put a prompt's text at the end of a session's shared queue
 * (Oct 28 2026). Prompt Trace on the desktop, a session's Prompts tab and Prompt
 * Trace on the phone, and the phone's saved prompts all add this way, so one
 * rule decides what an added item looks like and which sessions can take one.
 * It is queued, never sent here: the scheduler sends it when the session is free.
 */
import { useQueueStore, type QueueItem } from '@/stores/queueStore';
import type { Session } from '@/types';

let nextQueueId = Date.now();

/** Can this session take a queued prompt? Live (not ended) and not a floating fork. */
export function canQueuePromptFor(session: Pick<Session, 'status' | 'isFloating'> | undefined): boolean {
  return !!session && session.status !== 'ended' && !session.isFloating;
}

/** Append `text` to `sessionId`'s queue. Returns how many prompts now wait there. */
export function appendPromptToQueue(sessionId: string, text: string): number {
  const store = useQueueStore.getState();
  const position = store.queues.get(sessionId)?.length ?? 0;
  const item: QueueItem = {
    id: nextQueueId++,
    sessionId,
    text,
    position,
    createdAt: Date.now(),
    type: 'once',
    nextFireAt: 0,
  };
  store.add(sessionId, item);
  return useQueueStore.getState().queues.get(sessionId)?.length ?? position + 1;
}

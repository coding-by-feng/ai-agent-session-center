/**
 * queueSentStore — which prompts the queue sent, per session, as the Mac
 * records them (AASC-20).
 *
 * The CONVERSATION tab badges a prompt the queue sent. The record lived in each
 * browser's localStorage, so a phone never saw the badge for sends made by the
 * Mac's queue. Now the sender posts each send to the Mac, a window loads the
 * records for the session it shows, and `queue_sent` broadcasts add new ones
 * live. Matching is unchanged (`isQueueSent` in lib/queueSentLog.ts).
 */
import { create } from 'zustand';
import { appendQueueSent, type QueueSent } from '@/lib/queueSentLog';

interface QueueSentState {
  bySession: Map<string, QueueSent[]>;
  /** Fetch the Mac's records for one session (replaces what is held for it). */
  load: (sessionId: string) => Promise<void>;
  /** A `queue_sent` broadcast: add one record. */
  add: (sessionId: string, rec: QueueSent) => void;
}

function isRecord(value: unknown): value is QueueSent {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.text === 'string' && typeof r.sentAt === 'number' && Number.isFinite(r.sentAt);
}

export const useQueueSentStore = create<QueueSentState>((set) => ({
  bySession: new Map(),

  load: async (sessionId) => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/queue/sent`);
      if (!res.ok) return;
      const body = (await res.json()) as { sent?: unknown };
      // Untrusted shape: keep only well-formed records, normalized like appended ones.
      const sent = Array.isArray(body.sent) ? body.sent.filter(isRecord).reduce<QueueSent[]>(appendQueueSent, []) : [];
      set((s) => ({ bySession: new Map(s.bySession).set(sessionId, sent) }));
    } catch {
      /* the badge is a hint: no record means no badge, never an error */
    }
  },

  add: (sessionId, rec) => {
    if (!isRecord(rec)) return;
    set((s) => ({ bySession: new Map(s.bySession).set(sessionId, appendQueueSent(s.bySession.get(sessionId) ?? [], rec)) }));
  },
}));

/**
 * Tell the Mac the queue just sent this prompt to `sessionId`. Fire and forget:
 * the badge is a hint, never worth failing a send over. The Mac broadcasts it
 * back, so this window's store fills in through `add` like every other one.
 */
export function recordQueueSent(sessionId: string, rec: QueueSent): void {
  void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/queue/sent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: rec.text, sentAt: rec.sentAt }),
  }).catch(() => {});
}

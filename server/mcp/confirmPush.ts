// confirmPush.ts — the phone push for a central's confirmation (Ruling P5-14): the existing phone push
// (server/push/pushNotifier.ts, AASC-16), sent on the central's own card when a card opens that a phone may answer
// (phoneConfirmRoutes.ts `phoneMayAnswer`, P5-15).
//
// The message is the one the backend already sends for a session that needs approval:
//   kind         'approval'
//   sessionRef   the central's card (its id must be push-safe, as pushNotifier's own)
//   title        the central's card's title, cleaned the way pushNotifier cleans one (`cleanText`)
//   toolName     the tool's name, in the push charset
//   collapseKey  'mcp-confirm:' + the central's card id, cut to 64
//   ttlSeconds   the card's remaining time, at most 300
// and nothing else: no summary, no detail, no confirmId, no cardId, no target. Only for a central's card that is
// shared (`remoteVisible`) and not muted.
//
// At most one push per central per CONFIRM_PUSH_GAP_MS. A card that opens inside that gap is batched under the same
// collapse key: once the gap is over, one push is sent for the newest batched card that still waits and that a phone
// may still answer (the newest one answered on the Mac leaves an older one to tell). With no sink (no
// backend connected) nothing is sent and the Mac's card is unchanged. A card only the Mac can answer gets no push. A
// sink failure is logged without the title.

import { randomUUID } from 'node:crypto';
import { sessionDisplayTitle } from '../../src/lib/sessionDisplayTitle.js';
import type { Session } from '../../src/types/session.js';
import { SESSION_REF, TITLE_MAX, TOOL_MAX, cleanText, type PushMessage, type PushSink } from '../push/pushNotifier.js';
import type { ConfirmBook, PendingConfirm } from './confirm.js';

/** The least time between two pushes for one central's cards. */
export const CONFIRM_PUSH_GAP_MS = 30_000;
/** The longest a confirmation push lives: no card waits longer than 5 minutes. */
const TTL_MAX_SECONDS = 300;
const COLLAPSE_PREFIX = 'mcp-confirm:';

export interface ConfirmPushDeps {
  book: Pick<ConfirmBook, 'onChange' | 'pending'>;
  /** phoneConfirmRoutes.ts `phoneMayAnswer`, bound to the server's sessions. */
  mayPhoneAnswer(r: PendingConfirm): boolean;
  /** The card the central runs in, or null. */
  centralCard(centralId: string): Session | null;
  /** The backend sink, or null when no backend is connected. */
  sink(): PushSink | null;
  now?(): number;
  onError?(message: string): void;
}

/** The push for this card on this central card, or null when it cannot be said safely. */
function messageFor(r: PendingConfirm, card: Session, now: number): PushMessage | null {
  if (!SESSION_REF.test(card.sessionId)) return null;
  const remaining = Math.ceil((r.expiresAt - now) / 1000);
  if (remaining <= 0) return null;
  const message: PushMessage = {
    mutationId: randomUUID(),
    kind: 'approval',
    sessionRef: card.sessionId,
    title: cleanText(sessionDisplayTitle(card), TITLE_MAX) || 'Session',
    collapseKey: `${COLLAPSE_PREFIX}${card.sessionId}`.slice(0, 64),
    ttlSeconds: Math.min(TTL_MAX_SECONDS, remaining),
  };
  const tool = cleanText(r.tool, TOOL_MAX).replace(/[^A-Za-z0-9_.:-]/g, '');
  return tool ? { ...message, toolName: tool } : message;
}

/** Starts the push; answers the way to stop it (its listener and any batched push). */
export function startConfirmPush(deps: ConfirmPushDeps): () => void {
  const now = deps.now ?? Date.now;
  const lastSent = new Map<string, number>();
  // Central id → the card ids that opened inside its gap, and the timer that tells the newest one still waiting.
  const batched = new Map<string, ReadonlySet<string>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** The central's card, when a push may name it: shared with remote devices and not muted. */
  const shownCard = (centralId: string): Session | null => {
    const card = deps.centralCard(centralId);
    return card !== null && card.remoteVisible === true && card.muted !== true ? card : null;
  };

  const send = (r: PendingConfirm): void => {
    if (!deps.mayPhoneAnswer(r)) return;
    const card = shownCard(r.centralId);
    if (card === null) return;
    const sink = deps.sink();
    if (sink === null) return;
    const message = messageFor(r, card, now());
    if (message === null) return;
    lastSent.set(r.centralId, now());
    const failed = (err: unknown): void => {
      // Never the title or the card in a log line.
      deps.onError?.(`confirmation push failed: ${err instanceof Error ? err.message : String(err)}`);
    };
    try {
      sink.notify(message).catch(failed);
    } catch (err) {
      failed(err);
    }
  };

  const flushBatch = (centralId: string): void => {
    timers.delete(centralId);
    const ids = batched.get(centralId);
    batched.delete(centralId);
    if (ids === undefined) return;
    // The book's pending records, oldest first, as they are now: the newest one a phone may still answer.
    const waiting = deps.book.pending().filter((r) => ids.has(r.cardId) && deps.mayPhoneAnswer(r));
    const newest = waiting[waiting.length - 1];
    if (newest !== undefined) send(newest);
  };

  const onOpened = (r: PendingConfirm): void => {
    const last = lastSent.get(r.centralId);
    const wait = last === undefined ? 0 : last + CONFIRM_PUSH_GAP_MS - now();
    if (wait <= 0) {
      send(r);
      return;
    }
    if (!deps.mayPhoneAnswer(r)) return;
    batched.set(r.centralId, new Set([...(batched.get(r.centralId) ?? []), r.cardId]));
    if (timers.has(r.centralId)) return;
    const timer = setTimeout(() => flushBatch(r.centralId), wait);
    timer.unref?.();
    timers.set(r.centralId, timer);
  };

  const stopListening = deps.book.onChange((e) => {
    if (e.kind === 'opened') {
      onOpened(e.confirm);
      return;
    }
    const ids = batched.get(e.confirm.centralId);
    if (ids === undefined || !ids.has(e.confirm.cardId)) return;
    batched.set(e.confirm.centralId, new Set([...ids].filter((id) => id !== e.confirm.cardId)));
  });

  return () => {
    stopListening();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    batched.clear();
  };
}

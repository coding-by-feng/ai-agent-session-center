/**
 * usePromptSender — how the phone composer delivers a message (AASC-42).
 *
 * - send: the Mac's confirmed send (promptApi), then polling what became of it.
 *   A quiet inline state while it goes ("Sending…", "Sent"); a toast when it
 *   fails, with the text put back in the box so nothing typed is lost.
 * - queue: an ACTIVE item on the session's queue, the same store write the phone
 *   queue makes (PUT /sessions/:id/queue with its echo guard). The Mac's window
 *   sends it when the turn ends.
 * - denyAndTell: decline the waiting request through its card's route, give the
 *   CLI a moment to close the dialog, then send the text as a prompt. If the
 *   dialog is still up, the prompt goes as `interrupt` (the Mac presses Esc,
 *   which is "No", then types).
 * - stop: Esc to the agent, through the terminal write path the key bar uses
 *   (the server checks the control baton).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PendingRequest } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useQueueStore, type QueueImageAttachment, type QueueItem } from '@/stores/queueStore';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { showToast } from '@/components/ui/ToastContainer';
import { writeTerminal } from '@/lib/terminalCompose';
import { answerRequest } from '@/lib/chat/answerApi';
import { promptOutcome, sendPrompt, waitForPrompt, type PromptError, type PromptMode } from '@/lib/chat/promptApi';

export type SendPhase =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'pending' }
  | { phase: 'sent'; queued: boolean }
  | { phase: 'failed'; message: string; error?: PromptError };

export interface OutgoingMessage {
  text: string;
  images?: readonly QueueImageAttachment[];
}

/** How long "Sent" / "Queued" stays before the line clears. */
const DONE_LINGER_MS = 2500;
/** How long a declined dialog gets to close before the prompt is sent anyway (as an interrupt). */
const DIALOG_CLOSE_WAIT_MS = 3000;
const DIALOG_STATUSES = new Set(['approval', 'input']);

let nextQueueId = Date.now();

/** Resolves true once the session's status passes `test`, false after `timeoutMs`. */
function whenSession(sessionId: string, test: (status: string) => boolean, timeoutMs: number): Promise<boolean> {
  const now = useSessionStore.getState().sessions.get(sessionId);
  if (!now || test(now.status)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    const unsubscribe = useSessionStore.subscribe((state) => {
      const s = state.sessions.get(sessionId);
      if (!s || test(s.status)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(true);
      }
    });
  });
}

export function usePromptSender(sessionId: string) {
  const [state, setState] = useState<SendPhase>({ phase: 'idle' });
  const mounted = useRef(true);
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (lingerTimer.current) clearTimeout(lingerTimer.current);
    };
  }, []);

  const update = useCallback((next: SendPhase) => {
    if (!mounted.current) return;
    if (lingerTimer.current) clearTimeout(lingerTimer.current);
    setState(next);
    if (next.phase === 'sent') {
      lingerTimer.current = setTimeout(() => { if (mounted.current) setState({ phase: 'idle' }); }, DONE_LINGER_MS);
    }
  }, []);

  const dismiss = useCallback(() => update({ phase: 'idle' }), [update]);

  /** The text goes back into the box when a send fails after the box was cleared. */
  const putBack = useCallback((message: OutgoingMessage) => {
    useComposerDraftStore.getState().appendToDraft(sessionId, message.text);
  }, [sessionId]);

  const send = useCallback(async (message: OutgoingMessage, mode: PromptMode = 'now'): Promise<{ ok: boolean; error?: PromptError }> => {
    update({ phase: 'sending' });
    const result = await sendPrompt(sessionId, { text: message.text, images: message.images, mode });
    if (!result.ok) {
      update({ phase: 'failed', message: result.error.message, error: result.error });
      return { ok: false, error: result.error };
    }
    update({ phase: 'pending' });
    void waitForPrompt(sessionId, result.key).then((final) => {
      const outcome = promptOutcome(final);
      if (outcome.ok) {
        navigator.vibrate?.(10);
        update({ phase: 'sent', queued: false });
        return;
      }
      putBack(message);
      showToast(`${outcome.message} Your message is back in the box.`, 'error', 6000);
      update({ phase: 'failed', message: outcome.message });
    });
    return { ok: true };
  }, [sessionId, update, putBack]);

  const queue = useCallback((message: OutgoingMessage) => {
    const store = useQueueStore.getState();
    const items = store.queues.get(sessionId) ?? [];
    const item: QueueItem = {
      id: nextQueueId++,
      sessionId,
      text: message.text,
      position: items.length,
      createdAt: Date.now(),
      ...(message.images && message.images.length > 0 ? { images: [...message.images] } : {}),
      type: 'once',
      nextFireAt: 0,
    };
    store.add(sessionId, item);
    update({ phase: 'sent', queued: true });
  }, [sessionId, update]);

  const denyAndTell = useCallback(async (message: OutgoingMessage, request: PendingRequest | null | undefined) => {
    update({ phase: 'sending' });
    const answerable = !!request && request.source !== 'timer' && request.source !== 'notification' && !request.ambiguous;
    if (request && answerable) {
      const denied = await answerRequest(sessionId, request.id, { choice: 'deny' });
      // Stale (answered meanwhile) or not answerable here (the interrupt's Esc is the
      // "No" then): go on. Anything else stops here, with the text still in the box.
      if (!denied.ok && denied.code !== 'stale' && !denied.terminalOnly) {
        update({ phase: 'failed', message: denied.message });
        return { ok: false };
      }
    }
    const closed = await whenSession(sessionId, (status) => !DIALOG_STATUSES.has(status), answerable ? DIALOG_CLOSE_WAIT_MS : 0);
    return send(message, closed ? 'now' : 'interrupt');
  }, [sessionId, send, update]);

  const stop = useCallback(async (terminalId: string | null) => {
    if (!terminalId) {
      showToast('This session has no terminal to stop.', 'error');
      return;
    }
    const result = await writeTerminal(terminalId, '\x1b');
    if (!result.ok) showToast(result.message, 'error', 4000);
  }, []);

  return { state, send, queue, denyAndTell, stop, dismiss };
}

/**
 * usePromptSender — how the phone composer delivers a message (AASC-42).
 *
 * - send: the Mac's confirmed send (promptApi), then polling what became of it.
 *   A quiet inline state while it goes ("Sending…", "Still waiting for Claude to
 *   take it…", "Sent"); a toast when it surely went nowhere, with the text put
 *   back in the box so nothing typed is lost. While the Mac may still type it
 *   (it holds prompts for minutes behind a busy agent), the phone keeps asking
 *   and never puts the text back; past the Mac's memory of the key it just says
 *   "Check the chat". Only the newest send speaks on the status line, and
 *   leaving the chat stops the polling.
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
  | { phase: 'pending'; slow?: boolean }
  | { phase: 'sent'; queued: boolean }
  | { phase: 'failed'; message: string; error?: PromptError }
  /** No word from the Mac, which may still send it: nothing to retry. */
  | { phase: 'unsure'; message: string };

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
  // Aborted when the composer goes away: its polls stop with it.
  const polls = useRef<AbortController | null>(null);
  // The newest send (or queue): only it may change the status line.
  const latest = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    polls.current = controller;
    return () => {
      mounted.current = false;
      controller.abort();
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

  /** A status-line writer for one send: silent once a newer one has started. */
  const claimLine = useCallback(() => {
    const mine = ++latest.current;
    return (next: SendPhase) => { if (mine === latest.current) update(next); };
  }, [update]);

  const send = useCallback(async (message: OutgoingMessage, mode: PromptMode = 'now'): Promise<{ ok: boolean; error?: PromptError }> => {
    const line = claimLine();
    line({ phase: 'sending' });
    const result = await sendPrompt(sessionId, { text: message.text, images: message.images, mode });
    if (!result.ok) {
      line({ phase: 'failed', message: result.error.message, error: result.error });
      return { ok: false, error: result.error };
    }
    line({ phase: 'pending' });
    void waitForPrompt(sessionId, result.key, {
      signal: polls.current?.signal,
      onSlow: () => line({ phase: 'pending', slow: true }),
    }).then((final) => {
      if (final === 'aborted') return;
      const outcome = promptOutcome(final);
      if (outcome.ok) {
        navigator.vibrate?.(10);
        line({ phase: 'sent', queued: false });
        return;
      }
      if (outcome.unsure) {
        line({ phase: 'unsure', message: outcome.message });
        return;
      }
      putBack(message);
      showToast(`${outcome.message} Your message is back in the box.`, 'error', 6000);
      line({ phase: 'failed', message: outcome.message });
    });
    return { ok: true };
  }, [sessionId, claimLine, putBack]);

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
    claimLine()({ phase: 'sent', queued: true });
  }, [sessionId, claimLine]);

  const denyAndTell = useCallback(async (message: OutgoingMessage, request: PendingRequest | null | undefined) => {
    const line = claimLine();
    line({ phase: 'sending' });
    const answerable = !!request && request.source !== 'timer' && request.source !== 'notification' && !request.ambiguous;
    if (request && answerable) {
      const denied = await answerRequest(sessionId, request.id, { choice: 'deny' });
      // Stale (answered meanwhile) or not answerable here (the interrupt's Esc is the
      // "No" then): go on. Anything else stops here, with the text still in the box.
      if (!denied.ok && denied.code !== 'stale' && !denied.terminalOnly) {
        line({ phase: 'failed', message: denied.message });
        return { ok: false };
      }
    }
    const closed = await whenSession(sessionId, (status) => !DIALOG_STATUSES.has(status), answerable ? DIALOG_CLOSE_WAIT_MS : 0);
    return send(message, closed ? 'now' : 'interrupt');
  }, [sessionId, send, claimLine]);

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

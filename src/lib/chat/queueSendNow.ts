/**
 * queueSendNow.ts — ⚡ "Send now" from the phone's Queue tab (AASC-47), with the
 * session queue's own rules (QueueTab's handleTriggerNow):
 *
 *   a plain prompt   sent through the Mac's confirmed prompt route (AASC-42):
 *                    the Mac types it, presses Enter until the CLI takes it, and
 *                    refuses (409 awaiting_answer) while an approval or a
 *                    question is open. It leaves the queue only once the Mac
 *                    says it was sent. Never raw keystrokes: typed into an open
 *                    permission dialog, a prompt's Enter answers "Yes".
 *   a chain / loop / schedule   flagged `forceStart` on the shared queue: the
 *                    Mac's scheduler starts it (or sends the step a parked chain
 *                    waits on) on its next tick;
 *   refused          while the session waits on an answer, or paused, saying why.
 *
 * The route always submits: a phone's ⚡ sends the whole prompt whatever the
 * session's Auto-Enter (which shapes how the Mac's scheduler types). Every
 * outcome is a toast; a refusal is never a silent no-op.
 */
import type { Session } from '@/types';
import { DEFAULT_AUTOMATION, useQueueStore, type QueueItem } from '@/stores/queueStore';
import { recordQueueSent } from '@/stores/queueSentStore';
import { showToast } from '@/components/ui/ToastContainer';
import { isSendableStatus, currentChainStep, totalChainSteps } from '@/lib/queueScheduler';
import { MAX_PROMPT_IMAGES, promptOutcome, sendPrompt, waitForPrompt, type PromptError } from './promptApi';
import { sendNowPlan } from './queueTabModel';

/** A refusal from the prompt route, in the Queue tab's words. */
export function sendRefusalWords(error: PromptError): string {
  return error.code === 'awaiting_answer' ? 'Answer the waiting question first.' : error.message;
}

const sending = new Set<number>();

/** The session whose queue holds the item now. */
function queueOwner(itemId: number): string | null {
  for (const [sessionId, items] of useQueueStore.getState().queues) {
    if (items.some((i) => i.id === itemId)) return sessionId;
  }
  return null;
}

/** Run ⚡ for one item. Resolves to whether anything was sent or started. Never throws. */
export async function sendQueueItemNow(session: Session, item: QueueItem): Promise<boolean> {
  const store = useQueueStore.getState();
  const automation = store.automation.get(session.sessionId) ?? DEFAULT_AUTOMATION;
  const plan = sendNowPlan(item, automation, session);

  if (plan.kind === 'refuse') {
    showToast(plan.reason, 'info');
    return false;
  }
  if (plan.kind === 'resume') {
    store.updateItem(session.sessionId, item.id, { forceStart: true });
    const step = `step ${currentChainStep(item)} of ${totalChainSteps(item)}`;
    showToast(isSendableStatus(session.status) ? `Sending ${step} now…` : `The agent is busy: ${step} goes as soon as it’s free`, 'info');
    return true;
  }
  if (plan.kind === 'start') {
    // From the top: clear any cursor a previous run left.
    store.updateItem(session.sessionId, item.id, { forceStart: true, execState: undefined, execStepIdx: undefined });
    showToast(plan.steps > 1 ? `Starting now: ${plan.steps} steps in turn…` : 'Starting now…', 'info');
    return true;
  }

  const text = item.text.replace(/\\n/g, '\n');
  const images = item.images ?? [];
  if (!text.trim()) {
    showToast('Add some words to send it from the phone: photos alone can’t be sent.', 'info');
    return false;
  }
  if (images.length > MAX_PROMPT_IMAGES) {
    showToast(`A prompt sent from the phone takes at most ${MAX_PROMPT_IMAGES} photos. Remove one in its edit form.`, 'info');
    return false;
  }
  if (sending.has(item.id)) return false;
  sending.add(item.id);
  try {
    const posted = await sendPrompt(session.sessionId, { text, images, mode: 'now' });
    if (!posted.ok) {
      showToast(sendRefusalWords(posted.error), 'error');
      return false;
    }
    const result = await waitForPrompt(session.sessionId, posted.key);
    const outcome = promptOutcome(result);
    if (result !== 'submitted' && result !== 'unconfirmed') {
      showToast(`${outcome.message} It stays queued.`, 'error');
      return false;
    }
    // The session may have re-keyed while the Mac typed it (a /clear): the queue moved with it.
    const owner = queueOwner(item.id) ?? item.sessionId;
    recordQueueSent(owner, { text, sentAt: Date.now() });
    useQueueStore.getState().remove(owner, item.id);
    showToast('Sent', 'success');
    return true;
  } finally {
    sending.delete(item.id);
  }
}

/**
 * queueSendNow.ts — ⚡ "Send now" from the phone's Queue tab (AASC-47), with the
 * session queue's own rules (QueueTab's handleTriggerNow / sendItemToTerminal):
 *
 *   a plain prompt   typed into the session's terminal now (its photos uploaded
 *                    first, Enter pressed separately when Auto-Enter is on), then
 *                    taken off the queue;
 *   a chain / loop / schedule   flagged `forceStart` on the shared queue: the
 *                    Mac's scheduler starts it (or sends the step a parked chain
 *                    waits on) on its next tick;
 *   paused           refused, saying why.
 *
 * Every outcome is a toast; the Mac's refusal (another device drives, the agent
 * isn't running) reads as a failed send, never a silent no-op.
 */
import type { Session } from '@/types';
import { DEFAULT_AUTOMATION, useQueueStore, type QueueImageAttachment, type QueueItem } from '@/stores/queueStore';
import { recordQueueSent } from '@/stores/queueSentStore';
import { showToast } from '@/components/ui/ToastContainer';
import { sendPromptToTerminal, submitDelayFor } from '@/lib/terminalSend';
import { isSendableStatus, currentChainStep, totalChainSteps } from '@/lib/queueScheduler';
import { sendNowPlan } from './queueTabModel';

async function uploadImages(images: QueueImageAttachment[]): Promise<string[]> {
  try {
    const res = await fetch('/api/queue-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { paths?: unknown };
    return Array.isArray(data.paths) ? data.paths.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

const sending = new Set<number>();

/** Run ⚡ for one item. Resolves to whether anything was sent or started. Never throws. */
export async function sendQueueItemNow(session: Session, item: QueueItem): Promise<boolean> {
  const store = useQueueStore.getState();
  const automation = store.automation.get(session.sessionId) ?? DEFAULT_AUTOMATION;
  const plan = sendNowPlan(item, automation);

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

  if (!session.terminalId) {
    showToast('This session has no terminal on your Mac to type into.', 'error');
    return false;
  }
  if (sending.has(item.id)) return false;
  sending.add(item.id);
  try {
    const text = item.text.replace(/\\n/g, '\n');
    let toSend = text;
    let imageCount = 0;
    if (item.images?.length) {
      const paths = await uploadImages(item.images);
      // Never send it without its photos, or take it off the queue (a phone's
      // upload budget can refuse them: 429).
      if (paths.length < item.images.length) {
        showToast('Couldn’t upload its photos to your Mac. It stays queued; try again in a moment.', 'error');
        return false;
      }
      toSend += `\n${paths.join('\n')}`;
      imageCount = paths.length;
    }
    const ok = await sendPromptToTerminal(session.terminalId, toSend, automation.autoEnter, submitDelayFor(imageCount));
    if (!ok) {
      showToast('Couldn’t send it: your Mac refused, or another device is driving this session.', 'error');
      return false;
    }
    if (automation.autoEnter) recordQueueSent(item.sessionId, { text, sentAt: Date.now() });
    useQueueStore.getState().remove(session.sessionId, item.id);
    showToast(automation.autoEnter ? 'Sent' : 'Typed into the session: press Enter there to send it', 'success');
    return true;
  } finally {
    sending.delete(item.id);
  }
}

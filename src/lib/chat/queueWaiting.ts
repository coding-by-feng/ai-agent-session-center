/**
 * queueWaiting.ts — how many prompts a session's queue will still send by itself.
 * While any wait, the phone composer queues a new prompt behind them instead of
 * sending it ahead (composerAction). Pure.
 *
 * Only plain prompts count: a loop or a scheduled prompt fires on its own clock,
 * and a paused one not at all. A queue that is paused, or has Auto-send off, sends
 * nothing by itself, so nothing waits in it: a prompt queued behind it would sit there.
 */
import type { QueueAutomationConfig, QueueItem } from '@/stores/queueStore';

export function queueWaiting(
  items: readonly Pick<QueueItem, 'type' | 'disabled'>[],
  automation: Pick<QueueAutomationConfig, 'paused' | 'autoSend'>,
): number {
  if (automation.paused || !automation.autoSend) return 0;
  return items.filter((item) => (item.type ?? 'once') === 'once' && !item.disabled).length;
}

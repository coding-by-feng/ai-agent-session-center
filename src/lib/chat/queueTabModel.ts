/**
 * queueTabModel.ts — the phone's Queue tab (AASC-47): every session's queue in
 * one list, who sends queued prompts, and what ⚡ "Send now" does with an item.
 * Pure.
 *
 * The Mac's queue scheduler (not the phone) sends queued prompts (principle 5),
 * so the tab always says whether it is there to do it: a workspace writer
 * connected means AASC is open on that device.
 */
import type { Session, DevicePresence } from '@/types';
import type { QueueAutomationConfig, QueueItem } from '@/stores/queueStore';
import { numberedSessions } from '@/lib/sessionSort';
import { hasChain, isExecuting, itemType, totalChainSteps } from '@/lib/queueScheduler';

export interface QueueGroup {
  session: Session;
  items: QueueItem[];
}

/**
 * The sessions with queued prompts, in the desktop's order (live first, by
 * status; then ended ones). Only sessions this device can see: a queue whose
 * session isn't listed here isn't shown.
 */
export function queueGroups(queues: ReadonlyMap<string, readonly QueueItem[]>, sessions: ReadonlyMap<string, Session>): QueueGroup[] {
  const withItems = [...sessions.values()].filter((s) => (queues.get(s.sessionId)?.length ?? 0) > 0 && !s.isFloating);
  const live = numberedSessions(withItems);
  const ended = withItems
    .filter((s) => s.status === 'ended')
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  return [...live, ...ended].map((session) => ({
    session,
    items: [...(queues.get(session.sessionId) ?? [])].sort((a, b) => a.position - b.position),
  }));
}

export type SenderTone = 'ok' | 'warning';

export interface SenderLine {
  tone: SenderTone;
  title: string;
  detail: string;
}

/** Who sends queued prompts, from presence: is a workspace writer connected? */
export function senderLine(
  presence: { received: boolean; workspaceWriter: string | null; devices: readonly DevicePresence[] },
  myClientId: string,
): SenderLine {
  if (!presence.received) {
    return { tone: 'warning', title: 'Checking who sends queued prompts…', detail: 'Waiting for your Mac to say who is connected.' };
  }
  const writer = presence.workspaceWriter
    ? presence.devices.find((d) => d.clientId === presence.workspaceWriter)
    : undefined;
  if (!writer) {
    return { tone: 'warning', title: 'Open AASC on your Mac', detail: 'Queued prompts wait until AASC is open there to send them.' };
  }
  if (writer.clientId === myClientId) {
    return { tone: 'ok', title: 'This device sends queued prompts', detail: 'Keep it open: nothing is sent while it is closed.' };
  }
  if (writer.isLocal) {
    return { tone: 'ok', title: 'Your Mac sends queued prompts', detail: `AASC is open on your Mac (${writer.label}).` };
  }
  return { tone: 'ok', title: `${writer.label} sends queued prompts`, detail: 'AASC is open there.' };
}

/** "Every 10 min · 3 steps · paused": what kind of item this is, in words. */
export function itemSummary(item: QueueItem, now: number = Date.now()): string {
  const parts: string[] = [];
  const type = itemType(item);
  if (type === 'loop') parts.push(`Every ${intervalWords(item.intervalMs)}`);
  else if (type === 'schedule') parts.push(item.runAt ? `At ${clock(item.runAt, now)}` : 'Scheduled');
  const steps = totalChainSteps(item);
  if (steps > 1) parts.push(`${steps} steps`);
  if (item.images?.length) parts.push(`${item.images.length} ${item.images.length === 1 ? 'photo' : 'photos'}`);
  if (isExecuting(item)) parts.push('running now');
  if (item.disabled) parts.push('paused');
  return parts.join(' · ');
}

function intervalWords(ms: number | undefined): string {
  if (!ms || ms <= 0) return '—';
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)} s`;
}

function clock(ts: number, now: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString()
    ? time
    : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}

/** "Auto-send on · Auto-Enter on", or "Paused": the group's header line. */
export function automationWords(a: QueueAutomationConfig): string {
  if (a.paused) return 'Paused';
  return `Auto-send ${a.autoSend ? 'on' : 'off'} · Auto-Enter ${a.autoEnter ? 'on' : 'off'}`;
}

/**
 * What ⚡ "Send now" does with an item (the same rules as the session queue's
 * ⚡ NOW, QueueTab's handleTriggerNow):
 *   send     a plain once item: type it now, then take it off the queue
 *   start    a chain, loop or schedule: the Mac's scheduler starts it at once
 *   resume   a chain parked mid-way: send the step it waits on
 *   refuse   paused (the item, or the session's automation), with why
 */
export type SendNowPlan =
  | { kind: 'send' }
  | { kind: 'start'; steps: number }
  | { kind: 'resume' }
  | { kind: 'refuse'; reason: string };

export function sendNowPlan(item: QueueItem, automation: Pick<QueueAutomationConfig, 'paused'>): SendNowPlan {
  if (item.disabled) return { kind: 'refuse', reason: 'This prompt is paused. Turn it back on first.' };
  // A plain prompt is typed straight away, as the session queue's SEND does, paused session or not.
  if (itemType(item) === 'once' && !hasChain(item)) return { kind: 'send' };
  if (automation.paused) return { kind: 'refuse', reason: 'This session’s queue is paused. Resume it first.' };
  if (isExecuting(item)) return { kind: 'resume' };
  return { kind: 'start', steps: totalChainSteps(item) };
}

/** The ids in their new order after moving `from` to `to` (indexes clamped). */
export function moveId(ids: readonly number[], from: number, to: number): number[] {
  if (from < 0 || from >= ids.length) return [...ids];
  const target = Math.max(0, Math.min(ids.length - 1, to));
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * Where a held row lands: `mids` are every row's vertical centres when the hold
 * started (list order), `from` the held row, `dy` how far it has been dragged.
 * It lands after every other row whose centre its own centre has passed, so rows
 * of different heights (a summary line) are counted right.
 */
export function dropIndex(mids: readonly number[], from: number, dy: number): number {
  if (from < 0 || from >= mids.length) return from;
  const centre = mids[from] + dy;
  let target = 0;
  mids.forEach((mid, i) => {
    if (i !== from && mid < centre) target += 1;
  });
  return target;
}

/** The first line of a prompt, for a row (the full text is in the edit form). */
export function promptLine(item: QueueItem): string {
  const text = item.text.replace(/\\n/g, '\n');
  return text.split('\n').map((l) => l.trim()).find(Boolean) ?? (item.images?.length ? 'Photos only' : '(empty)');
}

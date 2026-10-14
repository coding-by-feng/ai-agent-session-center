// pushRules.ts — when a session state change is worth a phone notification (AASC-16).
//
// Import-free on purpose: pure rules over a tiny view of the session, so every
// transition is testable without the session store, timers or a backend.

import { justCompleted } from '../../src/lib/sessionAttention.js';

export type PushKind = 'approval' | 'input' | 'finished' | 'interrupted';

/** How the session came to need approval. The timeout guess is the least reliable. */
export type ApprovalSource = 'permission_request' | 'notification' | 'timer';

export interface PushView {
  status: string;
  approvalSource?: ApprovalSource | null;
  hasInterruption: boolean;
}

/**
 * The kind of notification a transition calls for, or null.
 * A first sighting (no `prev`) never notifies: on startup every restored session
 * is "new" to the notifier, and none of them just changed.
 */
export function decidePush(prev: PushView | undefined, next: PushView): PushKind | null {
  if (!prev) return null;
  if (next.hasInterruption && !prev.hasInterruption) return 'interrupted';
  if (next.status === 'approval' && prev.status !== 'approval') return 'approval';
  if (next.status === 'input' && prev.status !== 'input') return 'input';
  if (justCompleted(prev.status, next.status)) return 'finished';
  return null;
}

/**
 * How long to wait before sending, so states that resolve on their own never
 * buzz a phone:
 * - approval from the timeout guess: auto-approved long commands (npm install,
 *   builds) look like approval for ~8 s until PostToolUse arrives.
 * - finished: a queued prompt usually fires within a couple of seconds, and a
 *   529 ends in Stop too, with its interruption marker landing just after.
 */
export function settleMs(kind: PushKind, view: PushView): number {
  switch (kind) {
    case 'approval':
      return view.approvalSource === 'permission_request' || view.approvalSource === 'notification' ? 0 : 10_000;
    case 'input':
      return 5_000;
    case 'finished':
      return 8_000;
    case 'interrupted':
      return 3_000;
  }
}

/** Minimum gap between two notifications of the same kind for one session. */
export function cooldownMs(kind: PushKind): number {
  switch (kind) {
    case 'approval':
    case 'input':
      return 60_000;
    case 'finished':
      return 120_000;
    case 'interrupted':
      return 300_000;
  }
}

/** Is the reason for the notification still true when the settle time is up? */
export function stillApplies(kind: PushKind, view: PushView): boolean {
  switch (kind) {
    case 'approval':
      return view.status === 'approval';
    case 'input':
      return view.status === 'input';
    case 'finished':
      return (view.status === 'waiting' || view.status === 'idle') && !view.hasInterruption;
    case 'interrupted':
      return view.hasInterruption;
  }
}

/** How long Apple/Google should keep trying to deliver it. */
export function ttlSeconds(kind: PushKind): number {
  return kind === 'finished' ? 3600 : kind === 'interrupted' ? 1800 : 600;
}

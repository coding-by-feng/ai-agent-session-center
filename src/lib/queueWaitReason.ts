/**
 * Why a plain (Once-only) queue with Auto-send on is not sending right now, in one line, or null when it
 * is free to send or another notice already says why (Nov 28 2026: a phone showed "Auto-send on" over a
 * queue that waited, silently, for the session to finish its turn).
 *
 * Pure: the caller reads presence, the platform and the session. The order is the order a user would
 * fix things in: no sender at all, then nothing switched on, then the session's own state.
 */

export interface QueueWaitItem {
  type?: string;
  disabled?: boolean;
}

export interface QueueWaitInput {
  items: readonly QueueWaitItem[];
  autoSend: boolean;
  /** The session's automation is paused (its own control and notice). */
  automationPaused: boolean;
  /** The held-queue banner is up (it explains the wait itself). */
  held: boolean;
  sessionStatus: string;
  /** "Claude", "Codex" or "the agent". */
  cliName: string;
  /** In the phone app with no other device to send: the phone app never fires the queue. */
  noSender: boolean;
}

export type QueueWaitKind = 'no-sender' | 'all-off' | 'busy' | 'approval';

export interface QueueWaitReason {
  kind: QueueWaitKind;
  text: string;
}

export function queueWaitReason(input: QueueWaitInput): QueueWaitReason | null {
  const { items, autoSend, automationPaused, held, sessionStatus, cliName, noSender } = input;
  if (!autoSend || automationPaused || held || items.length === 0) return null;
  // A Loop or Schedule item brings the automation status row, which already names the wait.
  if (items.some((it) => (it.type ?? 'once') !== 'once')) return null;
  if (noSender) {
    return {
      kind: 'no-sender',
      text: 'Nothing sends until AASC is open on the Mac: the Mac sends queued prompts, not the phone.',
    };
  }
  if (items.every((it) => it.disabled)) {
    return {
      kind: 'all-off',
      text:
        items.length === 1
          ? 'The prompt is switched off. Turn it on (⏻) to send it.'
          : `All ${items.length} prompts are switched off. Turn one on (⏻) to send it.`,
    };
  }
  if (sessionStatus === 'working' || sessionStatus === 'prompting') {
    return { kind: 'busy', text: `Sends the next prompt when ${cliName} finishes this turn.` };
  }
  if (sessionStatus === 'approval') {
    return { kind: 'approval', text: `Sends the next prompt after you answer ${cliName}.` };
  }
  return null;
}

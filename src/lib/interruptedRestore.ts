/**
 * interruptedRestore — the reminder to continue sessions that quitting AASC cut off.
 *
 * Quitting the desktop app flushes the workspace snapshot (`app:before-close` →
 * `flushSave`), so each saved session carries the status it had at that moment. On
 * the next launch `useWorkspaceAutoLoad` restores them (`claude --resume …`), but a
 * resumed agent just sits at its prompt: the turn it was in the middle of is gone.
 * This module picks the ones that were mid-turn, holds the offer for the reminder
 * modal, and — only after the user clicks Continue — types a continuation prompt
 * into each once its CLI has actually started again.
 *
 * Kept free of React and of Three.js-touching imports so App.tsx can read the offer
 * without pulling anything heavy into the eager chunk; the modal itself is lazy.
 */
import { showToast } from '@/components/ui/ToastContainer';
import { sendPromptToTerminal } from '@/lib/terminalSend';
import { isSendableStatus, latestSessionStartAt } from '@/lib/queueScheduler';
import { useSessionStore } from '@/stores/sessionStore';
import type { SessionSnapshot } from '@/lib/workspaceSnapshot';

/**
 * Saved statuses that mean the turn was still running when AASC quit. `input` is left
 * out on purpose: the agent had asked the user something, and "continue" isn't an
 * answer. Idle, waiting and ended sessions had finished.
 */
export const INTERRUPTED_STATUSES: ReadonlySet<string> = new Set(['working', 'prompting', 'approval']);

export const CONTINUE_AFTER_RESTART_PROMPT =
  'AASC was restarted and interrupted your previous turn. ' +
  'Continue from exactly where you left off — do not restart the task and do not repeat completed work.';

/** How long after the resumed CLI's SessionStart before typing (its screen is still drawing). */
export const READY_SETTLE_MS = 3_000;
/** A resume that hasn't started by now is left for the user to continue by hand. */
export const READY_TIMEOUT_MS = 3 * 60_000;
const POLL_MS = 1_000;

export interface InterruptedItem {
  /** The restored terminal. Stable across the session's re-key (`term-*` → the CLI's id). */
  terminalId: string;
  title: string;
  /** The status saved at quit time. */
  status: string;
}

export interface InterruptedOffer {
  items: InterruptedItem[];
  /** When the restore began: a SessionStart before this belongs to the old process. */
  restoreStartedAt: number;
}

function folderName(dir: string | undefined): string {
  if (!dir) return '';
  const parts = dir.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** The restored sessions whose saved status says their turn was cut off, in restore order. */
export function pickInterrupted(
  created: ReadonlyArray<{ terminalId: string; snap: SessionSnapshot }>,
): InterruptedItem[] {
  return created
    .filter(({ snap }) => snap.status !== undefined && INTERRUPTED_STATUSES.has(snap.status))
    .map(({ terminalId, snap }) => ({
      terminalId,
      title: snap.title?.trim() || folderName(snap.sshConfig?.workingDir) || 'Untitled session',
      status: snap.status as string,
    }));
}

interface ReadinessView {
  status: string;
  events?: ReadonlyArray<{ type: string; timestamp?: number }>;
}

/**
 * Has the resumed CLI started (a SessionStart since the restore began, still its latest
 * meaningful event), settled for READY_SETTLE_MS, and is it waiting for a prompt? A
 * restored card can read `idle` before `claude --resume` has drawn anything; typing
 * then would land in the shell.
 */
export function isReadyToContinue(session: ReadinessView | undefined, restoreStartedAt: number, now: number): boolean {
  if (!session) return false;
  if (!isSendableStatus(session.status) || session.status === 'input') return false;
  const startedAt = latestSessionStartAt(session.events);
  if (startedAt === null || startedAt < restoreStartedAt) return false;
  return now - startedAt >= READY_SETTLE_MS;
}

// ---------------------------------------------------------------------------
// The offer: set by the restore, read by the (lazy) modal. Held until dismissed,
// so a modal that mounts after the restore finished still sees it.
// ---------------------------------------------------------------------------

let offer: InterruptedOffer | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function offerInterrupted(next: InterruptedOffer): void {
  if (next.items.length === 0) return;
  offer = next;
  notify();
}

export function dismissInterrupted(): void {
  if (offer === null) return;
  offer = null;
  notify();
}

export function getInterruptedOffer(): InterruptedOffer | null {
  return offer;
}

export function subscribeInterrupted(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// The runner: after the user's click, continue each session once it is ready.
// ---------------------------------------------------------------------------

function sessionOnTerminal(terminalId: string): ReadinessView | undefined {
  for (const s of useSessionStore.getState().sessions.values()) {
    if (s.terminalId === terminalId) return s;
  }
  return undefined;
}

const plural = (n: number) => `${n} session${n === 1 ? '' : 's'}`;

/**
 * Type the continuation prompt (with Enter) into each terminal once its session is
 * ready, one at a time; give up on any that isn't ready within READY_TIMEOUT_MS.
 * Ends with one toast saying what happened.
 */
export async function continueInterrupted(
  items: readonly InterruptedItem[],
  restoreStartedAt: number,
): Promise<{ sent: string[]; skipped: string[] }> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const pending = new Map(items.map((i) => [i.terminalId, i]));
  const sent: string[] = [];
  const skipped: string[] = [];

  while (pending.size > 0 && Date.now() <= deadline) {
    for (const item of [...pending.values()]) {
      if (!isReadyToContinue(sessionOnTerminal(item.terminalId), restoreStartedAt, Date.now())) continue;
      pending.delete(item.terminalId);
      const ok = await sendPromptToTerminal(item.terminalId, CONTINUE_AFTER_RESTART_PROMPT, true);
      (ok ? sent : skipped).push(item.title);
    }
    if (pending.size > 0) await new Promise((r) => setTimeout(r, POLL_MS));
  }
  for (const item of pending.values()) skipped.push(item.title);

  if (skipped.length === 0) {
    showToast(`Sent "continue" to ${plural(sent.length)}.`, 'success');
  } else {
    const names = skipped.slice(0, 3).join(', ') + (skipped.length > 3 ? '…' : '');
    showToast(
      `Sent "continue" to ${plural(sent.length)}. ${plural(skipped.length)} wasn't ready — continue by hand: ${names}`,
      'warning',
      10_000,
    );
  }
  return { sent, skipped };
}

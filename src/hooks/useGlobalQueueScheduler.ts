/**
 * useGlobalQueueScheduler — app-level 1-second scheduler tick that evaluates
 * EVERY session's queue, not just the currently focused one.
 *
 * Why this lives at app level:
 * - Previously the scheduler lived inside `QueueTab.tsx` and was bound to the
 *   selected session. Backgrounded sessions had their `QueueTab` unmounted,
 *   which stopped their `setInterval` and silently paused all loops and
 *   schedule items until the user switched back.
 * - This hook mounts once in `Dashboard` and iterates every session in
 *   `useSessionStore` on each tick, so background sessions keep firing.
 *
 * Per-session state:
 * - `firingRefs` — re-entrance guard so a slow `await` inside one session's
 *   send doesn't block another session's send AND doesn't double-fire its own
 *   queue on the next tick.
 * - `coolDownRefs` — 800ms post-fire buffer per session so a chain of `once`
 *   items doesn't flood the CLI input before the first one's
 *   UserPromptSubmit hook has flipped status away from `waiting`.
 *
 * `autoSend` / `autoEnter` are read straight from `localStorage` each tick —
 * they're persisted by `QueueTab` and live as global preferences. Reading
 * once per tick is cheap and means user toggles take effect on the next tick
 * without any cross-component wiring.
 */

import { useEffect, useRef } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import {
  useQueueStore,
  DEFAULT_AUTOMATION,
  type QueueItem,
  type QueueImageAttachment,
} from '@/stores/queueStore';
import {
  pickNext,
  advanceAfterFire,
  advanceBlockedLoops,
  itemType,
  getActiveStep,
  isExecuting,
  isSendableStatus,
  totalChainSteps,
  currentChainStep,
} from '@/lib/queueScheduler';
import { showToast } from '@/components/ui/ToastContainer';

const AUTO_SEND_KEY = 'queue-auto-send';
const AUTO_ENTER_KEY = 'queue-auto-enter';

function readBoolPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === '1';
  } catch {
    return fallback;
  }
}

async function uploadImages(images: QueueImageAttachment[]): Promise<string[]> {
  try {
    const res = await fetch('/api/queue-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.paths ?? [];
    }
  } catch {
    /* ignore */
  }
  return [];
}

async function sendToTerminal(
  terminalId: string,
  item: QueueItem,
  autoEnter: boolean,
): Promise<boolean> {
  let textToSend = item.text.replace(/\\n/g, '\n');
  if (item.images && item.images.length > 0) {
    const paths = await uploadImages(item.images);
    if (paths.length > 0) textToSend += '\n' + paths.join('\n');
  }
  const terminator = autoEnter ? '\r' : '';
  try {
    const res = await fetch(`/api/terminals/${terminalId}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: textToSend + terminator }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function useGlobalQueueScheduler(): void {
  const firingRefs = useRef<Map<string, boolean>>(new Map());
  const coolDownRefs = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;

    const evaluateSession = async (sessionId: string): Promise<void> => {
      const firing = firingRefs.current.get(sessionId);
      if (firing) return;

      const sessions = useSessionStore.getState().sessions;
      const session = sessions.get(sessionId);
      if (!session) return;

      const queueState = useQueueStore.getState();
      const items = queueState.queues.get(sessionId);
      if (!items || items.length === 0) return;

      const automationConfig =
        queueState.automation.get(sessionId) ?? DEFAULT_AUTOMATION;
      if (automationConfig.paused) return;

      const terminalId = session.terminalId;
      if (!terminalId) return;

      const now = Date.now();
      const cooldownUntil = coolDownRefs.current.get(sessionId) ?? 0;
      if (now < cooldownUntil) return;

      const sessionStatus = session.status;
      const sessionWaiting = isSendableStatus(sessionStatus);
      const blockedByPrompting =
        automationConfig.skipWhenPrompting && sessionStatus === 'prompting';

      if (blockedByPrompting) {
        const advances = advanceBlockedLoops(items, now);
        for (const a of advances) {
          queueState.updateItem(sessionId, a.id, a.patch);
        }
        return;
      }

      const pick = pickNext(
        items,
        now,
        sessionWaiting,
        automationConfig.idleGuard,
        automationConfig.loopExcludeWindows,
      );
      if (!pick) return;

      // Read autoEnter at fire time so toggles take effect immediately.
      const autoEnter = readBoolPref(AUTO_ENTER_KEY, true);

      firingRefs.current.set(sessionId, true);
      try {
        const active = getActiveStep(pick);
        const send = { ...pick, text: active.text, images: active.images };
        const sent = await sendToTerminal(terminalId, send, autoEnter);
        if (!sent || cancelled) return;

        coolDownRefs.current.set(sessionId, Date.now() + 800);

        const advance = advanceAfterFire(pick, Date.now());
        if (advance.action === 'remove') {
          useQueueStore.getState().remove(sessionId, pick.id);
        } else {
          useQueueStore.getState().updateItem(sessionId, pick.id, advance.patch);
        }

        // Toast — always prefixed with session name so background fires are
        // attributable. (When this fired inside QueueTab, the user was always
        // looking at the session that fired; now they might not be.)
        const totalSteps = totalChainSteps(pick);
        let label: string;
        if (advance.action === 'continue') {
          const wasExecuting = isExecuting(pick);
          const phaseLabel = wasExecuting
            ? pick.execState === 'main'
              ? 'main'
              : pick.execState === 'after'
                ? `after-step ${(pick.execStepIdx ?? 0) + 1}`
                : `before-step ${(pick.execStepIdx ?? 0) + 1}`
            : (pick.beforeChain?.length ?? 0) > 0
              ? 'before-step 1'
              : 'main';
          label = `Chain ${phaseLabel} sent (${currentChainStep({ ...pick, execState: pick.execState ?? 'idle' })} / ${totalSteps})`;
        } else {
          label =
            itemType(pick) === 'once'
              ? 'Auto-sent queued prompt'
              : itemType(pick) === 'loop'
                ? totalSteps > 1
                  ? 'Loop chain complete'
                  : 'Loop fired'
                : totalSteps > 1
                  ? 'Schedule chain complete'
                  : 'Scheduled prompt fired';
        }
        const sessionName = session.title?.trim() || sessionId.slice(0, 6);
        showToast(`[${sessionName}] ${label}`, 'info', 2000);
      } finally {
        firingRefs.current.set(sessionId, false);
      }
    };

    const evaluateAll = (): void => {
      if (cancelled) return;
      if (!readBoolPref(AUTO_SEND_KEY, true)) return;
      const sessionIds = Array.from(useSessionStore.getState().sessions.keys());
      // Fire-and-forget per session — independent firingRefs let multiple
      // sessions fire in parallel without blocking each other.
      for (const sid of sessionIds) {
        void evaluateSession(sid);
      }
    };

    evaluateAll();
    const interval = setInterval(evaluateAll, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
}

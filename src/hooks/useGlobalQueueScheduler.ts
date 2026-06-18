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
 * `autoSend` / `autoEnter` are read PER SESSION from that session's
 * `QueueAutomationConfig` each tick — the SAME reactive value the QueueTab
 * toggle writes (persisted per session to the `queueAutomation` IndexedDB
 * table). It is the single source of truth for AUTOMATIC firing in that
 * session: a visible "Auto-send OFF" halts every auto-fire for THAT session
 * only, leaving other sessions untouched. Two things still run while OFF: a
 * manual force-start (the "⚡ NOW" button — a deliberate user action that hands
 * an item's full before→main→after chain to this scheduler) and an already
 * in-flight chain (chains are atomic and finish what they started). Reading
 * once per tick is cheap and means user toggles take effect on the next tick.
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
  chainGateDecision,
  itemType,
  getActiveStep,
  isExecuting,
  isSendableStatus,
  totalChainSteps,
  currentChainStep,
  type ChainGate,
} from '@/lib/queueScheduler';
import { sendPromptToTerminal } from '@/lib/terminalSend';
import { showToast } from '@/components/ui/ToastContainer';

/**
 * How long the chain gate will wait for a step to visibly go to "work" before
 * giving up and firing the next step anyway. Covers the rare step that the
 * agent answers instantly without ever flipping status to working/prompting —
 * without this, such a step would stall the whole chain forever. Generous
 * enough not to fire inside the stale-status window right after a send.
 */
const NO_WORK_FALLBACK_MS = 12_000;

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
  // Auto-Enter submits with a SEPARATE Enter keystroke — concatenating "\r" onto
  // the text makes the TUI insert a newline instead of submitting. See
  // sendPromptToTerminal.
  return sendPromptToTerminal(terminalId, textToSend, autoEnter);
}

export function useGlobalQueueScheduler(): void {
  const firingRefs = useRef<Map<string, boolean>>(new Map());
  const coolDownRefs = useRef<Map<string, number>>(new Map());
  // Per-session chain gate: holds the next chain step until the step we just
  // sent has actually finished running (observed go busy → back to sendable).
  const chainGateRefs = useRef<Map<string, ChainGate>>(new Map());

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

      // Auto-send OFF halts all AUTOMATIC firing, but a manual force-start and
      // an already in-flight chain must still run (see header). Bail early when
      // OFF and there is neither, so an idle/disabled queue costs ~nothing per
      // tick (one scan) instead of walking the whole evaluation. Per-session:
      // read off THIS session's automation config, not a global flag.
      const autoSend = automationConfig.autoSend;
      const hasActiveWork = items.some(
        (it) => !it.disabled && (it.forceStart || isExecuting(it)),
      );
      if (!autoSend && !hasActiveWork) return;

      const sessionStatus = session.status;
      const sessionWaiting = isSendableStatus(sessionStatus);

      // Chain-gate observation: if a gate is open for this session and the
      // session is currently busy, record that the prior step's work has
      // begun. This MUST run before any early-return below (idle-guard,
      // skip-prompting) so a busy tick is never missed just because no item
      // was picked this cycle.
      const openGate = chainGateRefs.current.get(sessionId);
      if (openGate && !sessionWaiting && !openGate.sawWork) {
        chainGateRefs.current.set(sessionId, { ...openGate, sawWork: true });
      }

      // A FRESH force-start (manual ⚡ NOW) bypasses skip-prompting too — it is
      // a deliberate user action. Disabled rows never force-fire.
      const hasFreshForce = items.some(
        (it) => !it.disabled && it.forceStart && !isExecuting(it),
      );

      const blockedByPrompting =
        automationConfig.skipWhenPrompting && sessionStatus === 'prompting';

      if (blockedByPrompting && !hasFreshForce) {
        // Only roll loop cadence forward while auto-send is ON — when OFF the
        // loops are frozen and must not silently lose their scheduled offset.
        if (autoSend) {
          const advances = advanceBlockedLoops(items, now);
          for (const a of advances) {
            queueState.updateItem(sessionId, a.id, a.patch);
          }
        }
        return;
      }

      // SKIP-while-running: if ANY chain is mid-flight in this session, the
      // in-flight cycle must finish before any new cycle starts — and a loop
      // cycle that comes due in the meantime is DROPPED, not deferred. Rolling
      // every OTHER due loop's nextFireAt forward each tick (advanceBlockedLoops
      // excludes the executing item) means a blocked loop never fires a stale
      // cycle the instant the session frees up. The in-flight item's own steps
      // are still HELD step-by-step by the chain gate below — they complete the
      // current cycle, they aren't skipped. Cadence is only advanced while
      // auto-send is ON (a force-started chain running with auto-send OFF must
      // not roll other loops forward).
      const hasInFlightChain = items.some(isExecuting);
      if (autoSend && hasInFlightChain) {
        const skips = advanceBlockedLoops(items, now);
        for (const s of skips) {
          queueState.updateItem(sessionId, s.id, s.patch);
        }
      }

      const pick = pickNext(
        items,
        now,
        sessionWaiting,
        automationConfig.idleGuard,
        automationConfig.loopExcludeWindows,
      );
      if (!pick) return;

      // Auto-send OFF gate: only a manual force-start or an in-flight chain may
      // fire. Normal due loops/schedules/once items are held until the user
      // turns auto-send back on.
      if (!autoSend && !pick.forceStart && !isExecuting(pick)) return;

      // Chain gate: a mid-chain step must wait for the PREVIOUS step's work to
      // finish before firing. Fresh (non-executing) picks clear any stale gate
      // and fire immediately.
      if (isExecuting(pick)) {
        // `atRest` (status === 'waiting') is the genuine Stop signal — the only
        // reliable "prior step finished" marker. Decayed `idle` must not count.
        const atRest = sessionStatus === 'waiting';
        const decision = chainGateDecision(
          chainGateRefs.current.get(sessionId),
          pick.id,
          atRest,
          sessionWaiting,
          now,
          NO_WORK_FALLBACK_MS,
        );
        if (decision === 'hold') return;
      } else {
        chainGateRefs.current.delete(sessionId);
      }

      // Read this session's autoEnter at fire time so toggles take effect
      // immediately (per-session, from the same automation config).
      const autoEnter = automationConfig.autoEnter;

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
          chainGateRefs.current.delete(sessionId);
        } else if (advance.action === 'continue') {
          useQueueStore.getState().updateItem(sessionId, pick.id, advance.patch);
          // Open a gate so the NEXT step waits for THIS step's work to finish.
          chainGateRefs.current.set(sessionId, {
            itemId: pick.id,
            sawWork: false,
            openedAt: Date.now(),
          });
        } else {
          // reschedule — chain completed, no gate needed for the next cycle.
          useQueueStore.getState().updateItem(sessionId, pick.id, advance.patch);
          chainGateRefs.current.delete(sessionId);
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
      // The auto-send gate now lives INSIDE evaluateSession: a manual
      // force-start or an in-flight chain must run even while auto-send is OFF,
      // so we no longer short-circuit the whole tick on the toggle here. Each
      // session re-reads `autoSend` and bails early when there's nothing to do.
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

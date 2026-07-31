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
  type QueueAutomationConfig,
} from '@/stores/queueStore';
import type { Session } from '@/types';
import {
  pickNext,
  advanceAfterFire,
  advanceBlockedLoops,
  chainGateDecision,
  onceGateDecision,
  NO_WORK_FALLBACK_MS,
  itemType,
  getActiveStep,
  isExecuting,
  isSendableStatus,
  totalChainSteps,
  currentChainStep,
  type ChainGate,
  type OnceGate,
} from '@/lib/queueScheduler';
import { sendPromptToTerminal } from '@/lib/terminalSend';
import {
  decideResume,
  faultLabel,
  DEFAULT_RESUME_PROMPT,
  type WatchdogState,
} from '@/lib/resumeWatchdog';
import { showToast } from '@/components/ui/ToastContainer';

// NO_WORK_FALLBACK_MS lives in queueScheduler.ts next to the gate logic it
// parameterizes, so the gate tests can assert against the REAL value. Its
// length is load-bearing (it must outlast a hook-less /compact), and a value
// defined only here was invisible to every test.

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
  // Per-session auto-resume watchdog state. Holds the attempt ledger that caps
  // how often a transient fault may be auto-continued — see resumeWatchdog.ts.
  const resumeRefs = useRef<Map<string, WatchdogState>>(new Map());
  // Per-session chain gate: holds the next chain step until the step we just
  // sent has actually finished running (observed go busy → back to sendable).
  const chainGateRefs = useRef<Map<string, ChainGate>>(new Map());
  // Per-session once gate: holds the NEXT 'once' item until the previous once's
  // task has actually finished, so multiple queued once items drain one-at-a-
  // time instead of flooding the CLI in a burst.
  const onceGateRefs = useRef<Map<string, OnceGate>>(new Map());

  useEffect(() => {
    let cancelled = false;

    /**
     * Evaluate (and possibly act on) the auto-resume watchdog for one session.
     * Returns true when a resume prompt was sent, so the caller skips the queue
     * this tick rather than typing a second thing into the same prompt box.
     */
    const maybeAutoResume = async (
      sessionId: string,
      session: Session,
      terminalId: string,
      config: QueueAutomationConfig,
      now: number,
    ): Promise<boolean> => {
      const prev = resumeRefs.current.get(sessionId);
      const decision = decideResume(prev, {
        interruption: session.interruption ?? null,
        status: session.status,
        now,
        enabled: config.autoResume,
        maxRetries: config.resumeMaxRetries,
        // Fresh spread per evaluation so sessions that faulted together in a
        // provider-wide outage don't retry in lockstep.
        jitter: Math.random(),
      });

      if (decision.state) resumeRefs.current.set(sessionId, decision.state);
      else resumeRefs.current.delete(sessionId);

      const sessionName = session.title?.trim() || sessionId.slice(0, 6);

      if (decision.justExhausted) {
        showToast(
          `[${sessionName}] Auto-resume gave up after ${config.resumeMaxRetries} attempts — needs you`,
          'error',
          8000,
        );
        return false;
      }

      if (!decision.send) return false;

      const prompt = config.resumePrompt.trim() || DEFAULT_RESUME_PROMPT;
      const attempt = decision.state?.attempts.length ?? 1;

      firingRefs.current.set(sessionId, true);
      try {
        // Always auto-Enter: a resume prompt typed but not submitted leaves the
        // session exactly as stuck as it was, with the extra confusion of text
        // sitting in the box.
        const sent = await sendPromptToTerminal(terminalId, prompt, true);
        if (!sent) {
          // Undo the ledger entry — nothing was actually delivered, so this
          // must not consume the budget. Re-arm for the next tick.
          resumeRefs.current.set(sessionId, {
            ...decision.state!,
            phase: 'armed',
            attempts: decision.state!.attempts.slice(0, -1),
            nextAttemptAt: now + 5_000,
          });
          return false;
        }
        coolDownRefs.current.set(sessionId, Date.now() + 800);
        const reason = faultLabel(session.interruption?.kind ?? 'api_error');
        showToast(
          `[${sessionName}] Auto-resumed after ${reason} (${attempt}/${config.resumeMaxRetries})`,
          'info',
          4000,
        );
        return true;
      } finally {
        firingRefs.current.set(sessionId, false);
      }
    };

    const evaluateSession = async (sessionId: string): Promise<void> => {
      const firing = firingRefs.current.get(sessionId);
      if (firing) return;

      const sessions = useSessionStore.getState().sessions;
      const session = sessions.get(sessionId);
      if (!session) return;

      const queueState = useQueueStore.getState();

      const automationConfig =
        queueState.automation.get(sessionId) ?? DEFAULT_AUTOMATION;
      if (automationConfig.paused) return;

      const terminalId = session.terminalId;
      if (!terminalId) return;

      const now = Date.now();
      const cooldownUntil = coolDownRefs.current.get(sessionId) ?? 0;
      if (now < cooldownUntil) return;

      // ── Auto-resume watchdog ──────────────────────────────────────────────
      // Runs BEFORE the queue and independently of it: a session interrupted by
      // a 529 needs rescuing whether or not it has queued items, so this must
      // sit above the `items.length === 0` bail-out below. It shares
      // `firingRefs` / `coolDownRefs` with the queue so a resume and a queue
      // fire can never interleave into the same PTY.
      const resumed = await maybeAutoResume(
        sessionId,
        session,
        terminalId,
        automationConfig,
        now,
      );
      if (resumed || cancelled) return;

      const items = queueState.queues.get(sessionId);
      if (!items || items.length === 0) return;

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

      // Same observation for the once gate: record that the previously-sent
      // once item's task has begun the moment the session goes busy. Must also
      // run before any early-return so a busy tick is never missed.
      const openOnceGate = onceGateRefs.current.get(sessionId);
      if (openOnceGate && !sessionWaiting && !openOnceGate.sawWork) {
        onceGateRefs.current.set(sessionId, { ...openOnceGate, sawWork: true });
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
          session.lastActivityAt,
          // ⚡ NOW pressed on an already-executing row: release the gate for
          // this one step. The item keeps its execState/execStepIdx, so it
          // resumes where it is parked instead of re-typing step 1 over a
          // running agent. One-shot — `advanceAfterFire` clears `forceStart`
          // in every branch. The idle-guard still applies (PRIORITY 0), so a
          // genuinely busy session is not typed over.
          pick.forceStart === true,
        );
        if (decision === 'hold') return;
      } else {
        // Fresh (non-executing) pick. Sequence 'once' items: hold the next one
        // until the PREVIOUS once's task has finished (observed busy → back to
        // 'waiting'). Other item types keep their existing pacing.
        if (itemType(pick) === 'once') {
          const onceDecision = onceGateDecision(
            onceGateRefs.current.get(sessionId),
            sessionStatus === 'waiting',
            sessionWaiting,
            now,
            NO_WORK_FALLBACK_MS,
            session.lastActivityAt,
          );
          if (onceDecision === 'hold') return;
          onceGateRefs.current.delete(sessionId);
        }
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
          // If we just sent a 'once' item, open the once gate so the NEXT once
          // waits for THIS one's task to finish before it fires.
          if (itemType(pick) === 'once') {
            onceGateRefs.current.set(sessionId, {
              sawWork: false,
              openedAt: Date.now(),
              // Pre-send stamp: any later hook event moves lastActivityAt past
              // this, proving the CLI took the prompt.
              activityAtOpen: session.lastActivityAt,
            });
          }
        } else if (advance.action === 'continue') {
          useQueueStore.getState().updateItem(sessionId, pick.id, advance.patch);
          // Open a gate so the NEXT step waits for THIS step's work to finish.
          chainGateRefs.current.set(sessionId, {
            itemId: pick.id,
            sawWork: false,
            openedAt: Date.now(),
            // Pre-send stamp — see the once gate above.
            activityAtOpen: session.lastActivityAt,
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

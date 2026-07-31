/**
 * Auto-resume watchdog: decides IF and WHEN to send a continuation prompt into
 * a session whose turn died on a transient fault (see `server/interruptionDetector.ts`,
 * which decides only THAT a fault happened).
 *
 * Pure by design — no React, no store, no clock of its own — so every branch of
 * the loop guard below is testable without a PTY. `useGlobalQueueScheduler`
 * owns the ref map and the actual send.
 *
 * **The attempt ledger is the real loop guard, not the phase.** A tempting
 * design keys the retry count off the current fault and resets it whenever a
 * new fault arrives. That self-destructs: the resume prompt makes the session
 * work briefly, the server clears `interruption`, the SAME outage 529s the very
 * next turn — a brand-new fault with a fresh budget, forever. So `attempts`
 * holds the timestamps of resume prompts actually sent within a rolling
 * `ATTEMPT_WINDOW_MS` and survives both recovery and re-fault. The budget can
 * only be regained by the window sliding, never by a new fault.
 */
import { isSendableStatus } from './queueScheduler';
import type { FaultKind, SessionInterruption } from '@/types/session';

// Re-exported so consumers (and tests) can pull the whole watchdog vocabulary
// from one module, while the shapes stay defined once in src/types.
export type { FaultKind, SessionInterruption };

export type WatchdogPhase = 'idle' | 'armed' | 'resuming' | 'exhausted';

export interface WatchdogState {
  phase: WatchdogPhase;
  /** Timestamps of resume prompts sent inside the rolling window. */
  attempts: number[];
  /** Earliest time the next resume may be sent (`armed`). */
  nextAttemptAt: number;
  /** When the last resume prompt went out (`resuming`). */
  sentAt: number;
  /** `detectedAt` of the fault this phase belongs to. */
  faultAt: number;
}

/**
 * Quiet period the output must hold after the banner before arming. An agent
 * that is merely *printing* the words (quoting a log, echoing a queued prompt)
 * keeps producing output; a turn that actually died goes silent. This is the
 * main false-positive filter, alongside the sendable-status check.
 */
export const SETTLE_MS = 5_000;

/** How long a sent resume gets to clear the fault before it counts as failed. */
export const VERIFY_WINDOW_MS = 60_000;

/** Backoff before attempt 1, 2, 3… Last value repeats. */
export const BACKOFF_MS: readonly number[] = [30_000, 120_000, 480_000];

/**
 * Random spread added to every backoff. A provider-wide 529 hits every session
 * at once; without jitter all of them would retry in lockstep and hammer an
 * already-overloaded API.
 */
export const MAX_JITTER_MS = 15_000;

/** Rolling window over which `maxRetries` is counted. */
export const ATTEMPT_WINDOW_MS = 30 * 60_000;

export const DEFAULT_MAX_RETRIES = 3;

export const DEFAULT_RESUME_PROMPT =
  'The previous turn was interrupted by a transient error, not by you finishing. ' +
  'Continue from exactly where you left off — do not restart the task and do not repeat completed work.';

export interface WatchdogInput {
  /** `session.interruption`, or null once the server clears it. */
  interruption: SessionInterruption | null;
  status: string;
  now: number;
  /** Per-session auto-resume toggle. */
  enabled: boolean;
  maxRetries: number;
  /** 0..1, injected so tests are deterministic. */
  jitter: number;
}

export interface WatchdogDecision {
  /** State to store for this session; null drops the entry entirely. */
  state: WatchdogState | null;
  /** Send the resume prompt on this tick. */
  send: boolean;
  /** Fires once, on the transition into `exhausted`, so the alert isn't spammed. */
  justExhausted: boolean;
}

/** Drop attempts that have aged out of the rolling window. */
export function pruneAttempts(attempts: readonly number[], now: number): number[] {
  const cutoff = now - ATTEMPT_WINDOW_MS;
  return attempts.filter((t) => t > cutoff);
}

/** Backoff for the Nth attempt (0-based), with jitter folded in. */
export function backoffFor(attemptIndex: number, jitter: number): number {
  const idx = Math.min(Math.max(attemptIndex, 0), BACKOFF_MS.length - 1);
  const spread = Math.min(Math.max(jitter, 0), 1) * MAX_JITTER_MS;
  return BACKOFF_MS[idx] + spread;
}

/** Human-readable reason for the UI badge. */
export function faultLabel(kind: FaultKind): string {
  return kind === 'rate_limit' ? 'rate limit' : kind === 'network' ? 'network' : 'API error';
}

export function decideResume(
  prev: WatchdogState | null | undefined,
  input: WatchdogInput,
): WatchdogDecision {
  const { interruption, status, now, enabled, maxRetries, jitter } = input;
  const cap = Math.max(1, maxRetries);
  const attempts = pruneAttempts(prev?.attempts ?? [], now);

  // Toggle off (or cancelled by the user) — forget everything, including the
  // ledger. Turning it back on is a deliberate act and starts fresh.
  if (!enabled) return { state: null, send: false, justExhausted: false };

  // No active fault. The server clears `interruption` the moment the session
  // goes back to work, so this is the recovery path — but the ledger is KEPT
  // (see the module header) until its entries age out on their own.
  if (!interruption) {
    if (attempts.length === 0) return { state: null, send: false, justExhausted: false };
    return {
      state: { phase: 'idle', attempts, nextAttemptAt: 0, sentAt: 0, faultAt: 0 },
      send: false,
      justExhausted: false,
    };
  }

  // A different `detectedAt` is a NEW fault: the phase restarts, the ledger does not.
  const sameFault = !!prev && prev.faultAt === interruption.detectedAt;
  const base: WatchdogState = {
    phase: sameFault ? prev!.phase : 'idle',
    attempts,
    nextAttemptAt: sameFault ? prev!.nextAttemptAt : 0,
    sentAt: sameFault ? prev!.sentAt : 0,
    faultAt: interruption.detectedAt,
  };
  const keep: WatchdogDecision = { state: base, send: false, justExhausted: false };

  if (base.phase === 'exhausted') return keep;

  if (base.phase === 'resuming') {
    // Still inside the verify window — give the resume a chance to land.
    if (now - base.sentAt < VERIFY_WINDOW_MS) return keep;
    // Window elapsed with the fault still standing: the resume did not take.
    if (attempts.length >= cap) {
      return { state: { ...base, phase: 'exhausted' }, send: false, justExhausted: true };
    }
    return {
      state: { ...base, phase: 'armed', nextAttemptAt: now + backoffFor(attempts.length, jitter) },
      send: false,
      justExhausted: false,
    };
  }

  if (base.phase === 'idle') {
    if (attempts.length >= cap) {
      return {
        state: { ...base, phase: 'exhausted' },
        send: false,
        justExhausted: prev?.phase !== 'exhausted',
      };
    }
    // Settle: the banner must be followed by silence, not more output.
    if (now - interruption.detectedAt < SETTLE_MS) return keep;
    // And the turn must actually be over — never type over a running agent, and
    // never answer an approval/input prompt the user is being asked.
    if (!isSendableStatus(status)) return keep;
    return {
      state: { ...base, phase: 'armed', nextAttemptAt: now + backoffFor(attempts.length, jitter) },
      send: false,
      justExhausted: false,
    };
  }

  // phase === 'armed'
  if (now < base.nextAttemptAt) return keep;
  // Session went busy again while we waited out the backoff — hold, don't type
  // over it. The next tick re-evaluates.
  if (!isSendableStatus(status)) return keep;
  return {
    state: { ...base, phase: 'resuming', sentAt: now, attempts: [...attempts, now] },
    send: true,
    justExhausted: false,
  };
}

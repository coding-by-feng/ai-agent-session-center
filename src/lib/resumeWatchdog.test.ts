import { describe, it, expect } from 'vitest';
import {
  decideResume,
  pruneAttempts,
  backoffFor,
  faultLabel,
  SETTLE_MS,
  VERIFY_WINDOW_MS,
  BACKOFF_MS,
  MAX_JITTER_MS,
  ATTEMPT_WINDOW_MS,
  type SessionInterruption,
  type WatchdogInput,
  type WatchdogState,
} from './resumeWatchdog';

const T0 = 1_000_000;

const fault = (at = T0): SessionInterruption => ({
  kind: 'api_error',
  line: 'API Error: 529 Overloaded',
  detectedAt: at,
});

const input = (over: Partial<WatchdogInput> = {}): WatchdogInput => ({
  interruption: fault(),
  status: 'waiting',
  now: T0 + SETTLE_MS,
  enabled: true,
  maxRetries: 3,
  jitter: 0,
  ...over,
});

/** Drive the machine to `armed` (the state right after the settle gate opens). */
function armed(): WatchdogState {
  const d = decideResume(null, input());
  expect(d.state?.phase).toBe('armed');
  return d.state!;
}

describe('pruneAttempts / backoffFor', () => {
  it('drops attempts older than the rolling window', () => {
    const now = T0;
    expect(pruneAttempts([now - ATTEMPT_WINDOW_MS - 1, now - 5], now)).toEqual([now - 5]);
  });

  it('escalates the backoff and repeats the last step', () => {
    expect(backoffFor(0, 0)).toBe(BACKOFF_MS[0]);
    expect(backoffFor(1, 0)).toBe(BACKOFF_MS[1]);
    expect(backoffFor(99, 0)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1]);
  });

  it('adds jitter so a fleet-wide outage does not retry in lockstep', () => {
    expect(backoffFor(0, 1)).toBe(BACKOFF_MS[0] + MAX_JITTER_MS);
    expect(backoffFor(0, 0.5)).toBe(BACKOFF_MS[0] + MAX_JITTER_MS / 2);
    // Out-of-range jitter is clamped, never negative.
    expect(backoffFor(0, -5)).toBe(BACKOFF_MS[0]);
    expect(backoffFor(0, 9)).toBe(BACKOFF_MS[0] + MAX_JITTER_MS);
  });
});

describe('decideResume — arming', () => {
  it('does nothing when the feature is off, and forgets any ledger', () => {
    const prev: WatchdogState = {
      phase: 'armed', attempts: [T0], nextAttemptAt: T0, sentAt: 0, faultAt: T0,
    };
    expect(decideResume(prev, input({ enabled: false }))).toEqual({
      state: null, send: false, justExhausted: false,
    });
  });

  it('does nothing when there is no fault and nothing was ever sent', () => {
    expect(decideResume(null, input({ interruption: null }))).toEqual({
      state: null, send: false, justExhausted: false,
    });
  });

  it('holds during the settle window — output may still be flowing', () => {
    const d = decideResume(null, input({ now: T0 + SETTLE_MS - 1 }));
    expect(d.state?.phase).toBe('idle');
    expect(d.send).toBe(false);
  });

  it('will not arm while the session is still working', () => {
    expect(decideResume(null, input({ status: 'working' })).state?.phase).toBe('idle');
  });

  it.each(['approval', 'input'])('will not arm while the session is at a %s prompt', (status) => {
    // `input` IS sendable for the queue, but an approval prompt must never be
    // auto-answered — that is the queue's own gate, asserted here so a change
    // to isSendableStatus is caught.
    const d = decideResume(null, input({ status }));
    if (status === 'approval') expect(d.state?.phase).toBe('idle');
    else expect(d.state?.phase).toBe('armed');
  });

  it('arms once settled and at rest', () => {
    const s = armed();
    expect(s.nextAttemptAt).toBe(T0 + SETTLE_MS + BACKOFF_MS[0]);
    expect(s.attempts).toEqual([]);
  });
});

describe('decideResume — firing', () => {
  it('holds until the backoff elapses', () => {
    const s = armed();
    const d = decideResume(s, input({ now: s.nextAttemptAt - 1 }));
    expect(d.send).toBe(false);
    expect(d.state?.phase).toBe('armed');
  });

  it('sends once the backoff elapses and records the attempt', () => {
    const s = armed();
    const now = s.nextAttemptAt;
    const d = decideResume(s, input({ now }));
    expect(d.send).toBe(true);
    expect(d.state?.phase).toBe('resuming');
    expect(d.state?.attempts).toEqual([now]);
    expect(d.state?.sentAt).toBe(now);
  });

  it('holds instead of typing over a session that went busy during the backoff', () => {
    const s = armed();
    const d = decideResume(s, input({ now: s.nextAttemptAt, status: 'working' }));
    expect(d.send).toBe(false);
    expect(d.state?.phase).toBe('armed');
  });

  it('does not send twice inside the verify window', () => {
    const s = armed();
    const sent = decideResume(s, input({ now: s.nextAttemptAt })).state!;
    const d = decideResume(sent, input({ now: sent.sentAt + VERIFY_WINDOW_MS - 1 }));
    expect(d.send).toBe(false);
    expect(d.state?.phase).toBe('resuming');
  });
});

describe('decideResume — recovery', () => {
  it('parks the phase but KEEPS the ledger when the fault clears', () => {
    const s = armed();
    const sent = decideResume(s, input({ now: s.nextAttemptAt })).state!;
    const d = decideResume(sent, input({ interruption: null, now: sent.sentAt + 5_000 }));
    expect(d.state?.phase).toBe('idle');
    expect(d.state?.attempts).toEqual(sent.attempts);
  });

  it('drops the entry entirely once the ledger ages out', () => {
    const stale: WatchdogState = {
      phase: 'idle', attempts: [T0], nextAttemptAt: 0, sentAt: 0, faultAt: T0,
    };
    const d = decideResume(stale, input({
      interruption: null, now: T0 + ATTEMPT_WINDOW_MS + 1,
    }));
    expect(d.state).toBeNull();
  });
});

describe('decideResume — the loop guard', () => {
  it('cannot be reset by a fresh fault right after a resume (the runaway case)', () => {
    // Attempt 1 goes out.
    const s = armed();
    let st = decideResume(s, input({ now: s.nextAttemptAt })).state!;
    expect(st.attempts).toHaveLength(1);

    // The resume works for a moment, so the server clears the fault…
    st = decideResume(st, input({ interruption: null, now: st.sentAt + 1_000 })).state!;
    // …then the SAME outage kills the very next turn: a brand-new fault.
    const f2 = fault(st.attempts[0] + 10_000);
    let now = f2.detectedAt + SETTLE_MS;
    const d = decideResume(st, input({ interruption: f2, now }));
    expect(d.state?.phase).toBe('armed');
    // The budget did NOT reset — attempt 1 is still on the ledger.
    expect(d.state?.attempts).toHaveLength(1);

    // Drive attempts 2 and 3 through the same cycle.
    st = d.state!;
    for (let i = 0; i < 2; i++) {
      now = st.nextAttemptAt;
      st = decideResume(st, input({ interruption: f2, now })).state!;
      expect(st.phase).toBe('resuming');
      now = st.sentAt + VERIFY_WINDOW_MS;
      st = decideResume(st, input({ interruption: f2, now })).state!;
    }
    expect(st.attempts).toHaveLength(3);

    // Fourth attempt is refused.
    now = st.nextAttemptAt ?? now;
    const final = decideResume(
      { ...st, phase: 'resuming', sentAt: now - VERIFY_WINDOW_MS },
      input({ interruption: f2, now }),
    );
    expect(final.send).toBe(false);
    expect(final.state?.phase).toBe('exhausted');
    expect(final.justExhausted).toBe(true);
  });

  it('reports justExhausted exactly once', () => {
    const spent: WatchdogState = {
      phase: 'resuming',
      attempts: [T0, T0 + 1, T0 + 2],
      nextAttemptAt: 0,
      sentAt: T0 + 2,
      faultAt: T0,
    };
    const now = spent.sentAt + VERIFY_WINDOW_MS;
    const first = decideResume(spent, input({ now }));
    expect(first.justExhausted).toBe(true);
    const second = decideResume(first.state, input({ now: now + 1_000 }));
    expect(second.justExhausted).toBe(false);
    expect(second.send).toBe(false);
    expect(second.state?.phase).toBe('exhausted');
  });

  it('stays exhausted for a NEW fault while the ledger is still full', () => {
    const spent: WatchdogState = {
      phase: 'exhausted',
      attempts: [T0, T0 + 1, T0 + 2],
      nextAttemptAt: 0,
      sentAt: T0 + 2,
      faultAt: T0,
    };
    const f2 = fault(T0 + 100_000);
    const d = decideResume(spent, input({ interruption: f2, now: f2.detectedAt + SETTLE_MS }));
    expect(d.send).toBe(false);
    expect(d.state?.phase).toBe('exhausted');
  });

  it('recovers on its own once the attempts age out of the window', () => {
    const spent: WatchdogState = {
      phase: 'exhausted',
      attempts: [T0, T0 + 1, T0 + 2],
      nextAttemptAt: 0,
      sentAt: T0 + 2,
      faultAt: T0,
    };
    const f2 = fault(T0 + ATTEMPT_WINDOW_MS + 10_000);
    const d = decideResume(spent, input({ interruption: f2, now: f2.detectedAt + SETTLE_MS }));
    expect(d.state?.attempts).toEqual([]);
    expect(d.state?.phase).toBe('armed');
  });

  it('honours a maxRetries of 1', () => {
    const s = armed();
    const sent = decideResume(s, input({ now: s.nextAttemptAt, maxRetries: 1 })).state!;
    const d = decideResume(sent, input({ now: sent.sentAt + VERIFY_WINDOW_MS, maxRetries: 1 }));
    expect(d.state?.phase).toBe('exhausted');
  });

  it('treats maxRetries of 0 as 1 rather than firing forever', () => {
    const s = armed();
    const sent = decideResume(s, input({ now: s.nextAttemptAt, maxRetries: 0 })).state!;
    const d = decideResume(sent, input({ now: sent.sentAt + VERIFY_WINDOW_MS, maxRetries: 0 }));
    expect(d.state?.phase).toBe('exhausted');
  });
});

describe('faultLabel', () => {
  it('maps each kind to prose', () => {
    expect(faultLabel('api_error')).toBe('API error');
    expect(faultLabel('rate_limit')).toBe('rate limit');
    expect(faultLabel('network')).toBe('network');
  });
});

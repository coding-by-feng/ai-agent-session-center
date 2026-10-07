import { describe, it, expect } from 'vitest';
import {
  SUBMIT_GIVE_UP_GRACE_MS,
  SUBMIT_RETRY_AFTER_MS,
  mayConfirmSubmit,
  retriesElapsed,
  submitRetryDecision,
  type PendingSubmit,
  type SubmitObservation,
} from './submitConfirm';
import { NO_WORK_FALLBACK_MS } from './queueScheduler';

const SENT = 1_800_000_000_000;

function pending(over: Partial<PendingSubmit> = {}): PendingSubmit {
  return { terminalId: 'term-1', enterAt: SENT, activityAtOpen: SENT - 5_000, attempts: 0, ...over };
}

function seen(over: Partial<SubmitObservation> = {}): SubmitObservation {
  return {
    now: SENT + 1_000,
    status: 'waiting',
    activityAt: SENT - 5_000,
    terminalId: 'term-1',
    userCancelled: false,
    autoEnter: true,
    ...over,
  };
}

const LAST = SUBMIT_RETRY_AFTER_MS[SUBMIT_RETRY_AFTER_MS.length - 1];

describe('mayConfirmSubmit', () => {
  it('confirms an ordinary prompt sent with Auto-Enter', () => {
    expect(mayConfirmSubmit('fix the build /rar', true)).toBe(true);
    expect(mayConfirmSubmit('line one\n/tmp/claude-queue-images/a.png', true)).toBe(true);
  });

  it('never confirms without Auto-Enter: the human submits on purpose', () => {
    expect(mayConfirmSubmit('fix the build', false)).toBe(false);
  });

  it('never confirms a slash command: an extra Enter would act on its picker', () => {
    expect(mayConfirmSubmit('/clear', true)).toBe(false);
    expect(mayConfirmSubmit('  /model', true)).toBe(false);
    expect(mayConfirmSubmit('\n/config', true)).toBe(false);
  });
});

describe('submitRetryDecision', () => {
  it('waits before the first retry is due', () => {
    expect(submitRetryDecision(pending(), seen({ now: SENT + SUBMIT_RETRY_AFTER_MS[0] - 1 }))).toBe('wait');
  });

  it('presses Enter again once the first retry is due and nothing acknowledged the prompt', () => {
    expect(submitRetryDecision(pending(), seen({ now: SENT + SUBMIT_RETRY_AFTER_MS[0] }))).toBe('retry');
  });

  it('spaces later retries by the schedule, measured from the original Enter', () => {
    const p = pending({ attempts: 1 });
    expect(submitRetryDecision(p, seen({ now: SENT + SUBMIT_RETRY_AFTER_MS[1] - 1 }))).toBe('wait');
    expect(submitRetryDecision(p, seen({ now: SENT + SUBMIT_RETRY_AFTER_MS[1] }))).toBe('retry');
  });

  it('waits out a grace period after the last retry, then gives up so the caller can say so', () => {
    const p = pending({ attempts: SUBMIT_RETRY_AFTER_MS.length });
    expect(submitRetryDecision(p, seen({ now: SENT + LAST + SUBMIT_GIVE_UP_GRACE_MS - 1 }))).toBe('wait');
    expect(submitRetryDecision(p, seen({ now: SENT + LAST + SUBMIT_GIVE_UP_GRACE_MS }))).toBe('give-up');
  });

  it('an acknowledgement still wins over giving up', () => {
    const p = pending({ attempts: SUBMIT_RETRY_AFTER_MS.length });
    expect(submitRetryDecision(p, seen({ now: SENT + 10 * 60_000, activityAt: SENT + 70_000 }))).toBe('done');
  });

  it('stops the moment Auto-Enter is switched off: the user has taken over the input box', () => {
    const due = SENT + SUBMIT_RETRY_AFTER_MS[0];
    expect(submitRetryDecision(pending(), seen({ now: due, autoEnter: false }))).toBe('done');
  });

  it('is done as soon as a hook stamps activity after the send', () => {
    const due = SENT + SUBMIT_RETRY_AFTER_MS[0];
    expect(submitRetryDecision(pending(), seen({ now: due, activityAt: SENT + 400 }))).toBe('done');
  });

  it('is done once the session is busy with the prompt', () => {
    const due = SENT + SUBMIT_RETRY_AFTER_MS[0];
    expect(submitRetryDecision(pending(), seen({ now: due, status: 'prompting' }))).toBe('done');
    expect(submitRetryDecision(pending(), seen({ now: due, status: 'working' }))).toBe('done');
  });

  it('treats an unchanged or missing activity stamp as no acknowledgement', () => {
    const due = SENT + SUBMIT_RETRY_AFTER_MS[0];
    expect(submitRetryDecision(pending(), seen({ now: due, activityAt: SENT - 5_000 }))).toBe('retry');
    expect(submitRetryDecision(pending({ activityAtOpen: undefined }), seen({ now: due, activityAt: undefined }))).toBe('retry');
  });

  it('retries from idle as well as waiting', () => {
    const due = SENT + SUBMIT_RETRY_AFTER_MS[0];
    expect(submitRetryDecision(pending(), seen({ now: due, status: 'idle' }))).toBe('retry');
  });

  it('never presses Enter into a question or an approval dialog', () => {
    const due = SENT + SUBMIT_RETRY_AFTER_MS[0];
    expect(submitRetryDecision(pending(), seen({ now: due, status: 'input' }))).toBe('done');
    expect(submitRetryDecision(pending(), seen({ now: due, status: 'approval' }))).toBe('done');
  });

  it('stops when the session ended, is reconnecting, or moved to another terminal', () => {
    const due = SENT + SUBMIT_RETRY_AFTER_MS[0];
    expect(submitRetryDecision(pending(), seen({ now: due, status: 'ended' }))).toBe('done');
    expect(submitRetryDecision(pending(), seen({ now: due, status: 'connecting' }))).toBe('done');
    expect(submitRetryDecision(pending(), seen({ now: due, terminalId: 'term-2' }))).toBe('done');
  });

  it('stops when the user cancelled the turn', () => {
    const due = SENT + SUBMIT_RETRY_AFTER_MS[0];
    expect(submitRetryDecision(pending(), seen({ now: due, userCancelled: true }))).toBe('done');
  });

  it('counts the retry slots already passed, so a late tick presses Enter once instead of catching up', () => {
    expect(retriesElapsed(0)).toBe(0);
    expect(retriesElapsed(SUBMIT_RETRY_AFTER_MS[0])).toBe(1);
    expect(retriesElapsed(SUBMIT_RETRY_AFTER_MS[1] + 1)).toBe(2);
    expect(retriesElapsed(10 * 60_000)).toBe(SUBMIT_RETRY_AFTER_MS.length);
    // A throttled window wakes 65 s after the Enter: one press, then out of retries
    // (no catch-up presses — it only waits out the grace before giving up).
    const late = pending({ attempts: 0 });
    const at = SENT + 65_000;
    expect(submitRetryDecision(late, seen({ now: at }))).toBe('retry');
    expect(submitRetryDecision({ ...late, attempts: retriesElapsed(at - SENT) }, seen({ now: at + 1_000 }))).toBe('wait');
  });

  it('keeps every retry and the give-up inside the no-work fallback that would type the next item', () => {
    // The REAL constant, not a local copy: a test with its own fallback value
    // once passed against the buggy build (queue-scheduler.md).
    expect(LAST + SUBMIT_GIVE_UP_GRACE_MS).toBeLessThan(NO_WORK_FALLBACK_MS);
    expect([...SUBMIT_RETRY_AFTER_MS].sort((a, b) => a - b)).toEqual([...SUBMIT_RETRY_AFTER_MS]);
  });
});

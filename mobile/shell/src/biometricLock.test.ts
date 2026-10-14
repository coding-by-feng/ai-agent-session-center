// biometricLock.test.ts — AASC-21 M4: when the app asks for biometrics again.
import { describe, it, expect } from 'vitest';
import {
  decideLock, parseLockSettings, needsStepUp, onUnlocked, onLocked, onBackground, onForeground, onTapStarted, onTapFinished,
  DEFAULT_LOCK_SETTINGS, INITIAL_LOCK_STATE, TAP_FLIGHT_MAX_MS, type LockSettings,
} from './biometricLock';

const MIN = 60_000;
const T0 = 1_760_000_000_000;
const BOOT = 'boot-1';
const ON: LockSettings = { enabled: true, relockAfterMinutes: 5 };
const unlocked = onUnlocked(INITIAL_LOCK_STATE, T0, BOOT);

describe('decideLock', () => {
  it('never locks when the setting is off', () => {
    expect(decideLock('launch', DEFAULT_LOCK_SETTINGS, INITIAL_LOCK_STATE, T0, BOOT)).toEqual({ lock: false, reason: 'disabled' });
  });

  it('locks on the first launch and after a reboot', () => {
    expect(decideLock('launch', ON, INITIAL_LOCK_STATE, T0, BOOT)).toEqual({ lock: true, reason: 'never-unlocked' });
    expect(decideLock('launch', ON, unlocked, T0 + MIN, 'boot-2')).toEqual({ lock: true, reason: 'reboot' });
    expect(decideLock('launch', ON, unlocked, T0 + MIN, null)).toEqual({ lock: true, reason: 'reboot' });
  });

  it('locks on resume after N minutes in the background, not before', () => {
    const away = onBackground(unlocked, T0 + MIN);
    expect(decideLock('resume', ON, away, T0 + MIN + 4 * MIN, BOOT)).toEqual({ lock: false, reason: 'within-grace' });
    expect(decideLock('resume', ON, away, T0 + MIN + 5 * MIN, BOOT)).toEqual({ lock: true, reason: 'background-timeout' });
  });

  it('locks on every resume when N is 0', () => {
    const away = onBackground(unlocked, T0);
    expect(decideLock('resume', { enabled: true, relockAfterMinutes: 0 }, away, T0 + 1, BOOT).lock).toBe(true);
  });

  it('does not lock on a resume without a real background (the prompt bounce)', () => {
    expect(decideLock('resume', ON, unlocked, T0 + 60 * MIN, BOOT)).toEqual({ lock: false, reason: 'not-backgrounded' });
  });

  it('lets a cold start within the grace period through, counting from the unlock', () => {
    expect(decideLock('launch', ON, unlocked, T0 + 2 * MIN, BOOT)).toEqual({ lock: false, reason: 'within-grace' });
    expect(decideLock('launch', ON, unlocked, T0 + 6 * MIN, BOOT)).toEqual({ lock: true, reason: 'background-timeout' });
  });

  it('fails closed when the clock went backwards', () => {
    const away = onBackground(unlocked, T0 + MIN);
    expect(decideLock('resume', ON, away, T0 - MIN, BOOT)).toEqual({ lock: true, reason: 'clock-changed' });
  });

  it('never locks while a tap is being opened, but only for so long', () => {
    const away = onBackground(unlocked, T0);
    const tapping = onTapStarted(away, T0 + 10 * MIN);
    expect(decideLock('resume', ON, tapping, T0 + 10 * MIN + 2_000, BOOT)).toEqual({ lock: false, reason: 'tap-in-flight' });
    expect(decideLock('resume', ON, tapping, T0 + 10 * MIN + TAP_FLIGHT_MAX_MS, BOOT).lock).toBe(true);
    expect(decideLock('resume', ON, onTapFinished(tapping), T0 + 10 * MIN + 2_000, BOOT).lock).toBe(true);
  });

  it('ignores a tap left "in flight" by a killed process on the next cold start', () => {
    const tapping = onTapStarted(onBackground(unlocked, T0), T0 + 10 * MIN);
    expect(decideLock('launch', ON, tapping, T0 + 10 * MIN + 2_000, BOOT)).toEqual({ lock: true, reason: 'background-timeout' });
  });

  it('a tap never exempts a phone that is locked, rebooted or whose clock moved back', () => {
    const tapping = onTapStarted(onLocked(unlocked), T0 + MIN);
    expect(decideLock('resume', ON, tapping, T0 + MIN + 1_000, BOOT)).toEqual({ lock: true, reason: 'never-unlocked' });
    const rebooted = onTapStarted(unlocked, T0 + MIN);
    expect(decideLock('resume', ON, rebooted, T0 + MIN + 1_000, 'boot-2')).toEqual({ lock: true, reason: 'reboot' });
  });

  it('a tap on a locked phone still asks: the tap starts only after the unlock', () => {
    const away = onBackground(unlocked, T0);
    // Resume caused by the tap: the decision comes first, the tap is not in flight yet.
    expect(decideLock('resume', ON, away, T0 + 10 * MIN, BOOT).lock).toBe(true);
  });
});

describe('state reducers', () => {
  it('records and forgets without mutating', () => {
    const away = onBackground(unlocked, T0 + 1);
    expect(away).not.toBe(unlocked);
    expect(unlocked.backgroundedAt).toBeNull();
    expect(onForeground(away).backgroundedAt).toBeNull();
    expect(onLocked(away)).toEqual({ ...INITIAL_LOCK_STATE, tapStartedAt: null });
    expect(onUnlocked(away, T0 + 2, BOOT)).toMatchObject({ unlockedAt: T0 + 2, backgroundedAt: null });
  });
});

describe('settings', () => {
  it('reads stored settings and falls back on anything odd', () => {
    expect(parseLockSettings({ enabled: true, relockAfterMinutes: 15 })).toEqual({ enabled: true, relockAfterMinutes: 15 });
    expect(parseLockSettings({ enabled: 'yes', relockAfterMinutes: 7 })).toEqual(DEFAULT_LOCK_SETTINGS);
    expect(parseLockSettings(null)).toEqual(DEFAULT_LOCK_SETTINGS);
  });

  it('asks again before kill, room kill-all and restart, only with the lock on', () => {
    expect(['kill', 'room-kill-all', 'restart', 'rename'].map((a) => needsStepUp(a, ON))).toEqual([true, true, true, false]);
    expect(needsStepUp('kill', DEFAULT_LOCK_SETTINGS)).toBe(false);
  });
});

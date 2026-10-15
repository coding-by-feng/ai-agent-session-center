// lockGate.ts — the biometric lock on the phone (AASC-21 M4): biometricLock.ts decides, this keeps
// its settings and state in Preferences (timestamps and a boot id, nothing secret) and asks the
// native BiometricGate.
//
// When it is asked: at every start of the shell (cold start, and the native resume path, which
// sends the WebView back to the shell as ?resume=1&away=<pause time>&back=<path> while the Mac's
// page was showing), and on 'resume' while the shell itself is showing.
import {
  decideLock, DEFAULT_LOCK_SETTINGS, INITIAL_LOCK_STATE, onBackground, onForeground, onLocked, onTapFinished,
  onTapStarted, onUnlocked, parseLockSettings, type LockSettings, type LockState, type RelockMinutes,
} from './biometricLock.js';
import type { BiometricGate } from './native.js';
import type { KeyValueStore } from './pushRegistration.js';

export const LOCK_SETTINGS_KEY = 'aasc.lock.settings';
export const LOCK_STATE_KEY = 'aasc.lock.state';

function time(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Stored state; anything odd reads as "never unlocked", which locks (fail closed). */
export function parseLockState(raw: string | null): LockState {
  try {
    const s = JSON.parse(raw ?? 'null') as Record<string, unknown> | null;
    if (!s || typeof s !== 'object') return INITIAL_LOCK_STATE;
    return {
      unlockedAt: time(s.unlockedAt),
      unlockedBootId: typeof s.unlockedBootId === 'string' ? s.unlockedBootId : null,
      backgroundedAt: time(s.backgroundedAt),
      tapStartedAt: time(s.tapStartedAt),
    };
  } catch {
    return INITIAL_LOCK_STATE;
  }
}

/** ?resume=1&away=<ms>: the native side's pause time, used only when it is a sane past time. */
export function resumeAway(search: string, now: number): number | null {
  const p = new URLSearchParams(search);
  if (p.get('resume') !== '1') return null;
  const away = Number(p.get('away'));
  return Number.isFinite(away) && away > 0 && away <= now ? away : null;
}

export function createLockGate(gate: BiometricGate, store: KeyValueStore, now: () => number = Date.now) {
  let settings: LockSettings = DEFAULT_LOCK_SETTINGS;
  let state: LockState = INITIAL_LOCK_STATE;

  async function save(next: LockState): Promise<void> {
    state = next;
    await store.set(LOCK_STATE_KEY, JSON.stringify(state));
  }

  return {
    settings: (): LockSettings => settings,

    async load(): Promise<void> {
      try {
        settings = parseLockSettings(JSON.parse((await store.get(LOCK_SETTINGS_KEY)) ?? 'null'));
      } catch {
        settings = DEFAULT_LOCK_SETTINGS;
      }
      state = parseLockState(await store.get(LOCK_STATE_KEY));
    },

    /** Should the shell lock now? `awayFrom`: the native pause time when the Mac's page was showing. */
    async check(event: 'launch' | 'resume', awayFrom: number | null = null): Promise<boolean> {
      const at = now();
      const current = awayFrom !== null ? { ...state, backgroundedAt: awayFrom } : state;
      const decision = decideLock(event, settings, current, at, await gate.bootId().catch(() => null));
      if (decision.lock) await save(onLocked(state));
      else if (event === 'resume' && settings.enabled) await save(onForeground(current));
      return decision.lock;
    },

    /** The biometric prompt; true when the user passed (the state then counts from now). */
    async unlock(reason = 'Unlock AASC'): Promise<boolean> {
      const ok = await gate.authenticate(reason).catch(() => false);
      if (ok) await save(onUnlocked(state, now(), await gate.bootId().catch(() => null)));
      return ok;
    },

    async paused(): Promise<void> {
      if (settings.enabled) await save(onBackground(state, now()));
    },

    async tapStarted(): Promise<void> {
      if (settings.enabled) await save(onTapStarted(state, now()));
    },

    async tapFinished(): Promise<void> {
      if (settings.enabled) await save(onTapFinished(state));
    },

    /** Turning the lock on asks once first, so a phone without working biometrics can't lock itself out. */
    async setEnabled(enabled: boolean): Promise<boolean> {
      if (enabled) {
        if (!(await gate.available().catch(() => false))) return false;
        if (!(await gate.authenticate('Turn on the lock for AASC').catch(() => false))) return false;
        await save(onUnlocked(state, now(), await gate.bootId().catch(() => null)));
      }
      settings = { ...settings, enabled };
      await store.set(LOCK_SETTINGS_KEY, JSON.stringify(settings));
      return true;
    },

    async setRelockMinutes(relockAfterMinutes: RelockMinutes): Promise<void> {
      settings = parseLockSettings({ ...settings, relockAfterMinutes });
      await store.set(LOCK_SETTINGS_KEY, JSON.stringify(settings));
    },
  };
}

export type LockGate = ReturnType<typeof createLockGate>;

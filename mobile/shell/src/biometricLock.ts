// biometricLock.ts — when the app must ask for Face ID / fingerprint again (AASC-21 M4).
//
// With the lock on, the DeviceVault items are readable only after biometrics
// (Keychain .biometryCurrentSet / Keystore setUserAuthenticationRequired), so
// "locked" means the shell can't sign in to any Mac until the user unlocks.
// This file is the policy only; the App pause/resume events, the boot id and the
// prompt are native (README "Native hooks").
//
// Ask again:
//   - on a cold start, unless unlocked within the grace period during this boot
//   - after a device reboot (a new boot id), always
//   - on resume after N minutes in the background (N = 0: every time)
// Never while a notification tap is being opened. The tap itself waits for the
// unlock before it starts, so a tap on a locked phone still asks; once it is
// under way, the prompt's own inactive → active bounce must not lock again and
// drop it. A tap "in flight" longer than TAP_FLIGHT_MAX_MS stops counting.
// Anything odd (clock moved back, no boot id) locks: fail closed.

export const RELOCK_CHOICES = [0, 1, 5, 15, 60] as const;
export type RelockMinutes = (typeof RELOCK_CHOICES)[number];

export interface LockSettings {
  enabled: boolean;
  /** Minutes in the background before resuming asks again; the setting's choices are RELOCK_CHOICES. */
  relockAfterMinutes: RelockMinutes;
}

export const DEFAULT_LOCK_SETTINGS: LockSettings = { enabled: false, relockAfterMinutes: 5 };
export const TAP_FLIGHT_MAX_MS = 30_000;

/** Kept in Preferences (timestamps and a boot id: nothing secret). */
export interface LockState {
  unlockedAt: number | null;
  unlockedBootId: string | null;
  backgroundedAt: number | null;
  tapStartedAt: number | null;
}

export const INITIAL_LOCK_STATE: LockState = { unlockedAt: null, unlockedBootId: null, backgroundedAt: null, tapStartedAt: null };

export type LockReason =
  | 'disabled' | 'tap-in-flight' | 'never-unlocked' | 'reboot' | 'clock-changed'
  | 'background-timeout' | 'within-grace' | 'not-backgrounded';

export interface LockDecision {
  lock: boolean;
  reason: LockReason;
}

/** Settings from storage; anything unexpected falls back to the defaults (lock off, 5 minutes). */
export function parseLockSettings(raw: unknown): LockSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_LOCK_SETTINGS;
  const s = raw as Record<string, unknown>;
  const minutes = RELOCK_CHOICES.find((m) => m === s.relockAfterMinutes) ?? DEFAULT_LOCK_SETTINGS.relockAfterMinutes;
  return { enabled: s.enabled === true, relockAfterMinutes: minutes };
}

function tapInFlight(state: LockState, now: number): boolean {
  return state.tapStartedAt !== null && now >= state.tapStartedAt && now - state.tapStartedAt < TAP_FLIGHT_MAX_MS;
}

export function decideLock(
  event: 'launch' | 'resume', settings: LockSettings, state: LockState, now: number, bootId: string | null,
): LockDecision {
  if (!settings.enabled) return { lock: false, reason: 'disabled' };
  if (state.unlockedAt === null) return { lock: true, reason: 'never-unlocked' };
  if (!bootId || state.unlockedBootId !== bootId) return { lock: true, reason: 'reboot' };
  // A cold start without a recorded background time counts from the unlock.
  const away = event === 'resume' ? state.backgroundedAt : state.backgroundedAt ?? state.unlockedAt;
  if (now < state.unlockedAt || (away !== null && now < away)) return { lock: true, reason: 'clock-changed' };
  // Only an unlocked app can have a tap under way, and a tap doesn't survive the process.
  if (event === 'resume' && tapInFlight(state, now)) return { lock: false, reason: 'tap-in-flight' };
  if (away === null) return { lock: false, reason: 'not-backgrounded' };
  if (now - away >= settings.relockAfterMinutes * 60_000) return { lock: true, reason: 'background-timeout' };
  return { lock: false, reason: 'within-grace' };
}

// Reducers: each returns a new state.

export function onUnlocked(state: LockState, now: number, bootId: string | null): LockState {
  return { ...state, unlockedAt: now, unlockedBootId: bootId, backgroundedAt: null };
}

/** The decision said lock: forget the unlock until the user unlocks again. */
export function onLocked(state: LockState): LockState {
  return { ...state, unlockedAt: null, unlockedBootId: null, backgroundedAt: null };
}

/** App 'pause' (really in the background; an inactive bounce is not one). */
export function onBackground(state: LockState, now: number): LockState {
  return { ...state, backgroundedAt: now };
}

/** App 'resume' when the decision kept it unlocked. */
export function onForeground(state: LockState): LockState {
  return { ...state, backgroundedAt: null };
}

export function onTapStarted(state: LockState, now: number): LockState {
  return { ...state, tapStartedAt: now };
}

export function onTapFinished(state: LockState): LockState {
  return { ...state, tapStartedAt: null };
}

/** Destructive actions that ask for biometrics first when the lock is on (plan 08 §4). */
export const STEP_UP_ACTIONS: ReadonlySet<string> = new Set(['kill', 'room-kill-all', 'restart']);

export function needsStepUp(action: string, settings: LockSettings): boolean {
  return settings.enabled && STEP_UP_ACTIONS.has(action);
}

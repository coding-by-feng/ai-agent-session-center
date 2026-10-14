// haptics.ts — which session changes buzz the phone, and when not (AASC-21 M8).
//
//   needs approval / input → warning     finished → success     interrupted → error
// The same transitions as the Mac's push rules (server/push/pushRules.ts
// decidePush; a test keeps them equal), but with no settle time: the user is
// looking at the app. Only while the app is in the foreground, never for a
// muted session, never for the first sighting of a session, never within
// OWN_ACTION_WINDOW_MS of the phone's own action on that session (typing,
// approving, Esc, kill, restart), and rate-limited.
// Implemented with @capacitor/haptics Haptics.notification({ type }).

export type Haptic = 'warning' | 'success' | 'error';

export interface HapticView {
  status: string;
  hasInterruption: boolean;
}

/** At most one haptic in this window, across all sessions. */
export const HAPTIC_MIN_GAP_MS = 1_500;
/** At most one haptic per session in this window. */
export const HAPTIC_SESSION_COOLDOWN_MS = 15_000;
export const OWN_ACTION_WINDOW_MS = 4_000;

/** = src/lib/sessionAttention.ts justCompleted. */
function justCompleted(prev: string, next: string): boolean {
  return prev !== 'waiting' && prev !== 'ended' && next === 'waiting';
}

export function hapticForTransition(prev: HapticView | undefined, next: HapticView): Haptic | null {
  if (!prev) return null;
  if (next.hasInterruption && !prev.hasInterruption) return 'error';
  if (next.status === 'approval' && prev.status !== 'approval') return 'warning';
  if (next.status === 'input' && prev.status !== 'input') return 'warning';
  if (justCompleted(prev.status, next.status)) return 'success';
  return null;
}

export interface HapticsState {
  lastAt: number | null;
  /** sessionId → when it last buzzed. */
  bySession: Readonly<Record<string, number>>;
  /** sessionId → when the phone itself last acted on it. */
  ownActions: Readonly<Record<string, number>>;
}

export const INITIAL_HAPTICS_STATE: HapticsState = { lastAt: null, bySession: {}, ownActions: {} };

/** Drop timestamps older than `keepMs` so the maps stay small. */
function prune(map: Readonly<Record<string, number>>, now: number, keepMs: number): Record<string, number> {
  return Object.fromEntries(Object.entries(map).filter(([, at]) => now - at < keepMs && at <= now));
}

/** The phone typed, approved, cancelled, killed or restarted this session. */
export function noteOwnAction(state: HapticsState, sessionId: string, now: number): HapticsState {
  return { ...state, ownActions: { ...prune(state.ownActions, now, OWN_ACTION_WINDOW_MS), [sessionId]: now } };
}

export interface HapticInput {
  sessionId: string;
  prev: HapticView | undefined;
  next: HapticView;
  muted: boolean;
  appActive: boolean;
}

export function decideHaptic(state: HapticsState, input: HapticInput, now: number): { haptic: Haptic | null; state: HapticsState } {
  const none = { haptic: null, state };
  const haptic = hapticForTransition(input.prev, input.next);
  if (!haptic || !input.appActive || input.muted) return none;
  const own = state.ownActions[input.sessionId];
  if (own !== undefined && now >= own && now - own < OWN_ACTION_WINDOW_MS) return none;
  if (state.lastAt !== null && now >= state.lastAt && now - state.lastAt < HAPTIC_MIN_GAP_MS) return none;
  const last = state.bySession[input.sessionId];
  if (last !== undefined && now >= last && now - last < HAPTIC_SESSION_COOLDOWN_MS) return none;
  return {
    haptic,
    state: {
      lastAt: now,
      bySession: { ...prune(state.bySession, now, HAPTIC_SESSION_COOLDOWN_MS), [input.sessionId]: now },
      ownActions: prune(state.ownActions, now, OWN_ACTION_WINDOW_MS),
    },
  };
}

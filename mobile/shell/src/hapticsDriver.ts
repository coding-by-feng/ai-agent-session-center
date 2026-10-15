// hapticsDriver.ts — haptics.ts's decisions played on the phone (AASC-21 M8).
//
// The caller feeds every session change it sees and the phone's own actions; the driver keeps
// the rate-limit state and plays at most what decideHaptic allows. Who calls it: the Mac UI
// through src/lib/nativeBridge.ts, once the bridge reaches the Mac's page (plan 07 §9 S3, not
// built); today only the shell could, and it doesn't show sessions.
import { decideHaptic, INITIAL_HAPTICS_STATE, noteOwnAction, type Haptic, type HapticInput, type HapticsState } from './haptics.js';
import type { HapticsPlatform } from './native.js';

export function createHapticsDriver(platform: HapticsPlatform, now: () => number = Date.now) {
  let state: HapticsState = INITIAL_HAPTICS_STATE;
  return {
    /** A session changed; returns what was played (null: nothing). */
    sessionChanged(input: HapticInput): Haptic | null {
      const decision = decideHaptic(state, input, now());
      state = decision.state;
      if (decision.haptic) void platform.notify(decision.haptic).catch(() => undefined);
      return decision.haptic;
    },
    /** The phone itself typed, approved, cancelled, killed or restarted this session. */
    ownAction(sessionId: string): void {
      state = noteOwnAction(state, sessionId, now());
    },
  };
}

export type HapticsDriver = ReturnType<typeof createHapticsDriver>;

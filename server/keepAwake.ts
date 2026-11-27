// keepAwake.ts — keep this computer from sleeping (AASC-16; "always" since Nov 27 2026).
//
// A phone can only reach a computer that is awake: an approval prompt that arrives
// while it idles into sleep is never pushed and can't be answered. Three modes:
//   off     never hold anything (the default where nothing was chosen);
//   busy    hold while any session is working, prompting, or waiting on an
//           approval or an answer;
//   always  hold for as long as AASC runs (a home server, a Mac mini).
// The desktop app's main process holds a `prevent-app-suspension` power blocker
// (electron/main.ts); a server with no window starts the platform's own holder
// (keepAwakeHolder.ts). Neither keeps the display on, and both end when AASC does.
// The mode is saved in server-config.json (`keepAwake`), so it holds without a window.

export const KEEP_AWAKE_MODES = ['off', 'busy', 'always'] as const;
export type KeepAwakeMode = (typeof KEEP_AWAKE_MODES)[number];

/** A saved or sent mode, or null when it is none of the three. */
export function parseKeepAwakeMode(value: unknown): KeepAwakeMode | null {
  return typeof value === 'string' && (KEEP_AWAKE_MODES as readonly string[]).includes(value) ? (value as KeepAwakeMode) : null;
}

/** Statuses during which a sleeping Mac would strand the session. */
const BUSY_STATUSES = new Set(['working', 'prompting', 'approval', 'input']);

export function anySessionBusy(sessions: Iterable<{ status?: string | null }>): boolean {
  for (const s of sessions) {
    if (s && typeof s.status === 'string' && BUSY_STATUSES.has(s.status)) return true;
  }
  return false;
}

export interface KeepAwakeController {
  /** Choose the mode. Off releases at once; always holds at once. */
  setMode(mode: KeepAwakeMode): void;
  getMode(): KeepAwakeMode;
  /** The older on/off switch: on is `busy`. */
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  /** Re-check the sessions; call on every session change. */
  evaluate(): void;
  isAwake(): boolean;
  /** Listen for awake/asleep changes; returns an unsubscribe. */
  onChange(listener: (awake: boolean) => void): () => void;
  /** Someone is listening (the desktop app's blocker, or the holder). */
  hasListener(): boolean;
  /**
   * How to tell whether the hold is really in place (the holder's child still running). Without one, being
   * awake counts as holding: the desktop app's power blocker doesn't stop on its own.
   */
  setHoldCheck(check: () => boolean): void;
  /** Awake and actually held; false when a holder that should hold has stopped (review, Nov 27 2026). */
  isHolding(): boolean;
}

export function createKeepAwake(listSessions: () => Iterable<{ status?: string | null }>): KeepAwakeController {
  let mode: KeepAwakeMode = 'off';
  let awake = false;
  let holdCheck: (() => boolean) | null = null;
  const listeners = new Set<(awake: boolean) => void>();

  function evaluate(): void {
    const want = mode === 'always' || (mode === 'busy' && anySessionBusy(listSessions()));
    if (want === awake) return;
    awake = want;
    for (const listener of listeners) {
      try {
        listener(awake);
      } catch {
        /* a broken listener must not stop the others */
      }
    }
  }

  return {
    setMode(next) {
      mode = next;
      evaluate();
    },
    getMode: () => mode,
    setEnabled(next) {
      mode = next ? 'busy' : 'off';
      evaluate();
    },
    isEnabled: () => mode !== 'off',
    evaluate,
    isAwake: () => awake,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hasListener: () => listeners.size > 0,
    setHoldCheck(check) {
      holdCheck = check;
    },
    isHolding: () => awake && (holdCheck ? holdCheck() : true),
  };
}

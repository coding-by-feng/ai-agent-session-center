// keepAwake.ts — keep the Mac from sleeping while an agent is busy (AASC-16, optional).
//
// A phone can only reach a Mac that is awake: an approval prompt that arrives
// while the Mac idles into sleep is never pushed and can't be answered. When the
// user turns this on (Settings, desktop app only), the server reports "keep
// awake" while any session is working, prompting, or waiting on an approval or
// an answer, and the Electron main process holds a `prevent-app-suspension`
// power blocker for exactly that long. It never keeps the display on.

/** Statuses during which a sleeping Mac would strand the session. */
const BUSY_STATUSES = new Set(['working', 'prompting', 'approval', 'input']);

export function anySessionBusy(sessions: Iterable<{ status?: string | null }>): boolean {
  for (const s of sessions) {
    if (s && typeof s.status === 'string' && BUSY_STATUSES.has(s.status)) return true;
  }
  return false;
}

export interface KeepAwakeController {
  /** Turn the feature on or off (the desktop setting). Off releases at once. */
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  /** Re-check the sessions; call on every session change. */
  evaluate(): void;
  isAwake(): boolean;
  /** Listen for awake/asleep changes; returns an unsubscribe. */
  onChange(listener: (awake: boolean) => void): () => void;
}

export function createKeepAwake(listSessions: () => Iterable<{ status?: string | null }>): KeepAwakeController {
  let enabled = false;
  let awake = false;
  const listeners = new Set<(awake: boolean) => void>();

  function evaluate(): void {
    const want = enabled && anySessionBusy(listSessions());
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
    setEnabled(next) {
      enabled = next;
      evaluate();
    },
    isEnabled: () => enabled,
    evaluate,
    isAwake: () => awake,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

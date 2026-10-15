/**
 * clock.ts — one shared clock for the phone's "2m ago" ages and run times
 * (AASC-40): every subscriber reads the same tick, from one timer that runs only
 * while something is listening. Render stays pure (no Date.now() in a render).
 */
import { useSyncExternalStore } from 'react';

export const CLOCK_TICK_MS = 30_000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, CLOCK_TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const snapshot = () => now;

/** The time, at most CLOCK_TICK_MS old. */
export function useClock(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

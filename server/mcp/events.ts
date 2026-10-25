// events.ts — one hub over the server's broadcasts, so a tool can wait for something to happen.
//
// The hub sits on one feed, `onBroadcast` (wsManager.ts), handed in as `subscribe` so it needs no
// running server. It attaches to the feed when its first listener arrives and detaches when the last
// one leaves, so between waits it costs the broadcast nothing.
//
// A listener that throws is logged and keeps neither the others nor the broadcast from running. A
// wait whose matcher throws is rejected with that error (a matcher bug should surface, not look like
// a timeout); the other waits carry on.
//
// No wait lasts longer than MAX_WAIT_MS: Codex stops a tool call at 60 s by default, and a wait must
// end, with an answer, before the call does. A wait given the call's signal (`ToolContext.signal`) also
// ends when the central cancels the call or its MCP session closes.

import log from '../logger.js';

/** A broadcast message, the way `onBroadcast` hands it to its listeners. */
export type BroadcastMessage = { type: string; [key: string]: unknown };

/** Starts a listener on the broadcast feed and returns the function that stops it: `onBroadcast`'s shape. */
export type BroadcastSubscribe = (listener: (m: BroadcastMessage) => void) => () => void;

/** The longest any wait lasts, whatever a caller asks for. */
export const MAX_WAIT_MS = 50_000;

export interface EventHub {
  /** Every broadcast from now on, until the returned function is called (once is enough; more is harmless). */
  on(listener: (m: BroadcastMessage) => void): () => void;
  /**
   * The first broadcast `match` answers for (anything but null or undefined), or null when none
   * comes within `timeoutMs`, capped at MAX_WAIT_MS. A wait of zero, less or not a number answers
   * null at once. Only broadcasts sent after the call are seen. When `signal` aborts (the tool call
   * was cancelled, its session closed) the wait answers null at once and stops listening; a signal
   * that has already aborted answers null without listening at all.
   */
  waitFor<T>(
    match: (m: BroadcastMessage) => T | null,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T | null>;
}

/** How long a wait really lasts: no longer than MAX_WAIT_MS, and zero for a value that is not a positive number. */
function waitLength(timeoutMs: number): number {
  if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs) || timeoutMs <= 0) return 0;
  return Math.min(timeoutMs, MAX_WAIT_MS);
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createEventHub(subscribe: BroadcastSubscribe): EventHub {
  const listeners = new Set<(m: BroadcastMessage) => void>();
  let detach: (() => void) | null = null;

  function dispatch(m: BroadcastMessage): void {
    // A copy, so a listener may stop itself (or another) while this runs; one stopped before its
    // turn is skipped.
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(m);
      } catch (err) {
        log.warn('mcp', `An event listener failed on ${m.type}: ${describe(err)}`);
      }
    }
  }

  function on(listener: (m: BroadcastMessage) => void): () => void {
    // Wrapped, so the same function added twice is two subscriptions that end separately.
    const subscription = (m: BroadcastMessage): void => listener(m);
    listeners.add(subscription);
    if (detach === null) detach = subscribe(dispatch);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      listeners.delete(subscription);
      if (listeners.size === 0 && detach !== null) {
        const stopFeed = detach;
        detach = null;
        stopFeed();
      }
    };
  }

  function waitFor<T>(
    match: (m: BroadcastMessage) => T | null,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T | null> {
    const ms = waitLength(timeoutMs);
    if (ms === 0 || signal?.aborted) return Promise.resolve(null);
    return new Promise<T | null>((resolve, reject) => {
      let settled = false;
      let stop: () => void = () => {};
      const timer = setTimeout(() => settle(() => resolve(null)), ms);
      // A wait never keeps the process alive on its own.
      timer.unref?.();
      const onAbort = (): void => settle(() => resolve(null));
      signal?.addEventListener('abort', onAbort, { once: true });

      function settle(answer: () => void): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        stop();
        answer();
      }

      stop = on((m) => {
        let found: T | null | undefined;
        try {
          found = match(m);
        } catch (err) {
          settle(() => reject(err));
          return;
        }
        if (found !== null && found !== undefined) settle(() => resolve(found as T));
      });
      // Settled while `on` was still subscribing (a feed that replays): `stop` was not set yet then.
      if (settled) stop();
    });
  }

  return { on, waitFor };
}

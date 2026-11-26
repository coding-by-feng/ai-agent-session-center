/**
 * launchQueue — paces the agent launches a workspace restore types (Nov 25 2026).
 *
 * A restore used to type every `claude --resume …` within a second: on Nov 25 2026, 61 of them
 * started together, each shell's ready check timed out (2 s), and the CLIs took 12 s to 6 min to
 * report SessionStart while they fought over CPU and disk. Every card's terminal stayed blank
 * until its own CLI got there.
 *
 * Here at most `max` restored launches run at once, in the order the restore asked for them (the
 * client sends pinned sessions first). A card a device opens while it waits starts at once
 * (`promote`, from the WS terminal subscribe), even past `max`: nothing is on screen when a
 * desktop restore begins, so what the user opens is the only sign of what matters. A slot frees
 * when the terminal's CLI sends its first hook (`releaseRestoreLaunch` from `handleEvent`), when
 * the terminal goes away, or after
 * `slotTimeoutMs`: a CLI that never reports (a failed resume falling back to a fresh start, a
 * plain command) must not stall the rest.
 *
 * Only workspace restore uses it (`restoreBatch` on POST /api/terminals). A Restart, a pinned
 * respawn or a central's relaunch is typed at once and never waits behind a restore.
 */
import log from './logger.js';

export const MAX_CONCURRENT_LAUNCHES = 4;
export const LAUNCH_SLOT_TIMEOUT_MS = 20_000;

export interface LaunchQueue {
  /** Run `start` now if a slot is free, else once one frees. A second enqueue for one terminal is ignored. */
  enqueue(terminalId: string, start: () => void): void;
  /** The terminal's CLI reported, or the terminal is gone: free its slot, or drop it from the line. */
  release(terminalId: string): void;
  /** Someone opened this card: if it is still waiting, start it now. */
  promote(terminalId: string): void;
  /** For tests and logs. */
  stats(): { running: number; waiting: number };
}

export function createLaunchQueue(
  { max = MAX_CONCURRENT_LAUNCHES, slotTimeoutMs = LAUNCH_SLOT_TIMEOUT_MS }: { max?: number; slotTimeoutMs?: number } = {},
): LaunchQueue {
  const running = new Map<string, ReturnType<typeof setTimeout>>();
  let waiting: Array<{ terminalId: string; start: () => void }> = [];

  function startOne(next: { terminalId: string; start: () => void }): void {
    const timer = setTimeout(() => {
      log.debug('pty', `Launch slot for ${next.terminalId} timed out after ${slotTimeoutMs}ms — starting the next restore`);
      release(next.terminalId);
    }, slotTimeoutMs);
    timer.unref?.();
    running.set(next.terminalId, timer);
    try {
      next.start();
    } catch (err: unknown) {
      log.warn('pty', `Restored launch for ${next.terminalId} failed to start: ${err instanceof Error ? err.message : String(err)}`);
      release(next.terminalId);
    }
  }

  function pump(): void {
    while (running.size < max && waiting.length > 0) {
      const [next, ...rest] = waiting;
      waiting = rest;
      startOne(next);
    }
  }

  function promote(terminalId: string): void {
    const entry = waiting.find((w) => w.terminalId === terminalId);
    if (!entry) return;
    waiting = waiting.filter((w) => w !== entry);
    startOne(entry);
  }

  function release(terminalId: string): void {
    const timer = running.get(terminalId);
    if (timer !== undefined) {
      clearTimeout(timer);
      running.delete(terminalId);
      pump();
      return;
    }
    if (waiting.some((w) => w.terminalId === terminalId)) {
      waiting = waiting.filter((w) => w.terminalId !== terminalId);
    }
  }

  function enqueue(terminalId: string, start: () => void): void {
    if (running.has(terminalId) || waiting.some((w) => w.terminalId === terminalId)) return;
    waiting = [...waiting, { terminalId, start }];
    pump();
  }

  return { enqueue, release, promote, stats: () => ({ running: running.size, waiting: waiting.length }) };
}

const restoreLaunches = createLaunchQueue();

export function enqueueRestoreLaunch(terminalId: string, start: () => void): void {
  restoreLaunches.enqueue(terminalId, start);
}

/** A device opened this card (WS terminal subscribe). */
export function promoteRestoreLaunch(terminalId: string): void {
  restoreLaunches.promote(terminalId);
}

/** Cheap for a terminal with no slot: called on every hook event. */
export function releaseRestoreLaunch(terminalId: string): void {
  restoreLaunches.release(terminalId);
}

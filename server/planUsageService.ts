/**
 * @module planUsageService
 * Keeps each AI CLI's plan limits (what `/usage` and `/status` show) current and
 * hands them to the sessions that run it.
 *
 * Plan limits belong to the ACCOUNT: they move when any session of that CLI does
 * work, whichever one. So the freshest observation per CLI is kept here and put
 * on every live session of that CLI (`applyUsageToSessions`), rather than each
 * session hunting for its own — which Codex cards on this install could not do
 * anyway, since they never receive a hook and so are never matched to a rollout.
 * The field rides the ordinary session update, so every visibility gate that
 * guards a session guards this too.
 *
 * Polling is cheap by construction — see planUsageSources.ts — and runs only for
 * a CLI that has a live session.
 */
import log from './logger.js';
import { EVENT_TYPES } from './constants.js';
import { MAX_FUTURE_SKEW_MS, mergeObservations, planCliOf, sameNumbers, sanitizeObservation } from './planUsageCodec.js';
import type { UsageSource } from './planUsageSources.js';
import type { PlanCli, PlanUsage, Session } from '../src/types/session.js';

const DEFAULT_INTERVAL_MS = 15_000;

/**
 * How long one read of one source may take before the service stops waiting for
 * it. A hung filesystem call would otherwise pin the CLI's in-flight read forever
 * and freeze its chip. The read itself is not cancelled — it cannot be — so a source
 * that is still reading is not asked again (see `readSource`).
 */
export const SOURCE_TIMEOUT_MS = 10_000;

/**
 * A session whose copy says the same thing is still given a newer `asOf` once it
 * is this far behind, so the chip's "as of" and its stale cue keep telling the
 * truth while the numbers hold still — without a broadcast per observation.
 */
export const REFRESH_ASOF_MS = 5 * 60 * 1000;

/**
 * Claude Code runs its status line once the assistant message has landed, which
 * can be a beat after the Stop hook fires; reading at once would see the numbers
 * from before the turn that just ended.
 */
export const STOP_KICK_DELAY_MS = 2500;

/**
 * A source saying new numbers landed opens a window this long; every write inside it
 * folds into the one read at its end (a fixed window, not a debounce: a steady stream
 * of writes cannot postpone the read). It caps watch reads at four a second per CLI
 * while every busy session's status line writes several times a second, and costs
 * nothing anyone can see: the broadcast after the read waits 300 ms anyway.
 */
export const WATCH_READ_WINDOW_MS = 250;

/** A host that cannot say which CLIs are live is reported at most this often (watch reads ask it several times a second). */
export const LIVE_CLIS_WARN_INTERVAL_MS = 60_000;

/**
 * When to re-read plan usage after a hook event, in ms from now — null when the
 * event does not move the numbers. Only the edges of a turn do; tool calls fire
 * constantly and the interval already covers a long turn.
 */
export function kickDelayFor(eventName: string | undefined): number | null {
  switch (eventName) {
    case EVENT_TYPES.STOP:
      return STOP_KICK_DELAY_MS;
    case EVENT_TYPES.USER_PROMPT_SUBMIT:
    case EVENT_TYPES.SESSION_START:
      return 0;
    default:
      return null;
  }
}

export interface PlanUsageHost {
  /** CLIs with a live session: nothing is read for a CLI nobody is using. */
  liveClis(): ReadonlySet<PlanCli>;
  /** The freshest usage for a CLI. Idempotent: the host updates only the sessions that need it. */
  apply(cli: PlanCli, usage: PlanUsage): void;
}

export interface PlanUsageService {
  /** Read once now, then on an interval; arm the sources' watches. Does nothing if already started. */
  start(): void;
  /** Stop the interval, cancel pending kicks and watch reads, and close the watches. */
  stop(): void;
  /** Re-read a CLI's sources; a read already under way is shared rather than repeated. */
  refresh(cli: PlanCli): Promise<void>;
  /**
   * Re-read soon — a turn just ended and has probably moved the numbers. One
   * read is pending per CLI: the first request decides when, later ones fold in.
   */
  kick(cli: PlanCli, delayMs?: number): void;
  /** The freshest usage known for a CLI, or null before anything has reported. */
  latest(cli: PlanCli): PlanUsage | null;
}

export function createPlanUsageService(
  host: PlanUsageHost,
  sources: readonly UsageSource[],
  options: { intervalMs?: number } = {},
): PlanUsageService {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const latest = new Map<PlanCli, PlanUsage>();
  const inflight = new Map<PlanCli, Promise<void>>();
  const kicks = new Map<PlanCli, ReturnType<typeof setTimeout>>();
  /** Reads that have been started and have not ended — whether or not anyone is still waiting for them. */
  const pendingReads = new Map<UsageSource, Promise<unknown>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Each watching source's stop function; null (or absent) while it has no watch to arm. */
  const watches = new Map<UsageSource, (() => void) | null>();
  /** One pending watch-triggered read per CLI. Not `kicks`: a pending 2.5 s Stop kick must not hold it back. */
  const watchReads = new Map<PlanCli, ReturnType<typeof setTimeout>>();
  let liveWarnedAt = Number.NEGATIVE_INFINITY;

  /**
   * One source's observations, or nothing if it fails, takes longer than
   * `SOURCE_TIMEOUT_MS`, or is still working on an earlier read that was given up on
   * (a second read behind a hung one would only add another hung call every poll).
   */
  async function readSource(source: UsageSource, now: number): Promise<PlanUsage[]> {
    if (pendingReads.has(source)) {
      log.debug('plan-usage', `${source.cli} source is still reading — not asking again`);
      return [];
    }
    const read = source.read(now);
    pendingReads.set(source, read);
    void read.then(
      () => undefined,
      () => undefined, // its own failure is reported through the race below; this keeps a late one from going unhandled
    ).finally(() => {
      if (pendingReads.get(source) === read) pendingReads.delete(source);
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`timed out after ${SOURCE_TIMEOUT_MS} ms`)), SOURCE_TIMEOUT_MS);
      timeout.unref?.();
    });
    try {
      return await Promise.race([read, expired]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function readAndPublish(cli: PlanCli): Promise<void> {
    const now = Date.now();
    const observations: PlanUsage[] = [];
    for (const source of sources) {
      if (source.cli !== cli) continue;
      try {
        for (const raw of await readSource(source, now)) {
          const usable = sanitizeObservation(raw, now);
          if (usable) observations.push(usable);
        }
      } catch (err) {
        log.debug('plan-usage', `${cli} source failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // What was already known is NOT an observation. With none on disk right now (a swept
    // snapshot) the chip keeps it; with some, it can only raise the percent of the same
    // window (mergeObservations) — fed back in as one it was re-stamped with the newest
    // time on every poll, so a window that was no longer current could never age out.
    const known = latest.get(cli) ?? null;
    const merged = observations.length > 0 ? mergeObservations(observations, known) : known;
    if (!merged) return;
    latest.set(cli, merged);
    try {
      host.apply(cli, merged);
    } catch (err) {
      log.warn('plan-usage', `could not apply ${cli} usage: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function refresh(cli: PlanCli): Promise<void> {
    const running = inflight.get(cli);
    if (running) return running;
    const run = readAndPublish(cli).finally(() => { inflight.delete(cli); });
    inflight.set(cli, run);
    return run;
  }

  function liveClis(): ReadonlySet<PlanCli> | null {
    try {
      return host.liveClis();
    } catch (err) {
      // One bad session must not stop plan usage for every CLI: try again next time. Said at
      // most once a minute — watch reads ask several times a second, and each line is a
      // synchronous write to server.log (abs: a clock stepped back must not mute it).
      const now = Date.now();
      if (Math.abs(now - liveWarnedAt) >= LIVE_CLIS_WARN_INTERVAL_MS) {
        liveWarnedAt = now;
        log.warn('plan-usage', `could not tell which CLIs are live: ${err instanceof Error ? err.message : String(err)}`);
      }
      return null;
    }
  }

  /** A source says new numbers landed: read them shortly, once, if anyone is using the CLI. */
  function onWritten(cli: PlanCli): void {
    if (!timer || watchReads.has(cli)) return; // stopped (a late callback), or a read is already due
    const pending = setTimeout(() => {
      watchReads.delete(cli);
      if (!liveClis()?.has(cli)) return;
      // A read already under way may have listed the files before this write: read again
      // after it — unless stop() came first (shutdown saves the sessions right after it).
      const reread = (): void => { if (timer) void refresh(cli); };
      const running = inflight.get(cli);
      if (running) void running.then(reread, reread);
      else reread();
    }, WATCH_READ_WINDOW_MS);
    pending.unref?.();
    watchReads.set(cli, pending);
  }

  /** Arm every watch that is not running: the first time, and again after one could not start or was lost. */
  function armWatches(): void {
    for (const source of sources) {
      if (!source.watch || watches.get(source)) continue;
      let stop: (() => void) | null = null;
      try {
        stop = source.watch(
          () => onWritten(source.cli),
          () => { watches.set(source, null); }, // lost: armed again on the next tick
        );
      } catch (err) {
        log.debug('plan-usage', `${source.cli} watch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      watches.set(source, stop);
    }
  }

  function tick(): void {
    armWatches();
    const clis = liveClis();
    if (!clis) return;
    for (const cli of clis) void refresh(cli);
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const pending of kicks.values()) clearTimeout(pending);
      kicks.clear();
      for (const pending of watchReads.values()) clearTimeout(pending);
      watchReads.clear();
      for (const [source, stopWatch] of watches) {
        // One that fails to close must not keep the rest open, nor stop the shutdown that called this.
        try {
          stopWatch?.();
        } catch (err) {
          log.debug('plan-usage', `${source.cli} watch did not close: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      watches.clear();
    },
    refresh,
    kick(cli, delayMs = 0) {
      if (kicks.has(cli)) return;
      const pending = setTimeout(() => {
        kicks.delete(cli);
        void refresh(cli);
      }, delayMs);
      pending.unref?.();
      kicks.set(cli, pending);
    },
    latest: (cli) => latest.get(cli) ?? null,
  };
}

/**
 * Put `usage` on every live session of `cli` that should have it, replacing
 * `planUsage` with the new value (the object itself is never edited). A session
 * is left alone when its copy is newer than `usage`, and otherwise updated when
 * the numbers differ or its copy is `REFRESH_ASOF_MS` behind. A copy dated further
 * ahead of `now` than any clock skew explains counts as no copy at all: the
 * sessions snapshot carries `planUsage` across a restart, and one bad time must not
 * outlast it. Returns the sessions that changed, so the caller broadcasts exactly those.
 */
export function applyUsageToSessions(
  sessions: Iterable<Session>,
  cli: PlanCli,
  usage: PlanUsage,
  isLive: (session: Session) => boolean,
  now: number = Date.now(),
): Session[] {
  const changed: Session[] = [];
  for (const session of sessions) {
    if (!isLive(session) || planCliOf(session) !== cli) continue;
    const have = session.planUsage && session.planUsage.asOf <= now + MAX_FUTURE_SKEW_MS ? session.planUsage : undefined;
    if (have) {
      if (usage.asOf < have.asOf) continue;
      if (sameNumbers(have, usage) && usage.asOf - have.asOf < REFRESH_ASOF_MS) continue;
    }
    session.planUsage = usage;
    changed.push(session);
  }
  return changed;
}

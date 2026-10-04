import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPlanUsageService,
  applyUsageToSessions,
  kickDelayFor,
  REFRESH_ASOF_MS,
  STOP_KICK_DELAY_MS,
  SOURCE_TIMEOUT_MS,
  type PlanUsageHost,
} from '../server/planUsageService.js';
import { MAX_FUTURE_SKEW_MS, MAX_RESET_AHEAD_MS } from '../server/planUsageCodec.js';
import type { UsageSource } from '../server/planUsageSources.js';
import type { PlanCli, PlanUsage, Session } from '../src/types/session.js';

// The service drops readings that cannot be right about NOW (dated in the future, a window that
// resets years ahead), so the fixtures live on a fixed clock instead of an arbitrary far-future constant.
const NOW = 1_791_500_000_000;
const H = 3_600_000;
const D = 24 * H;
const R = NOW + 3 * D;
const usage = (cli: PlanCli, pct: number, asOf: number, minutes = 300): PlanUsage => ({
  cli,
  windows: [{ minutes, usedPercent: pct, resetsAt: R }],
  asOf,
});

const source = (cli: PlanCli, read: UsageSource['read']): UsageSource & { read: ReturnType<typeof vi.fn> } =>
  ({ cli, read: vi.fn(read) });

const host = (live: PlanCli[] | (() => PlanCli[])): PlanUsageHost & { apply: ReturnType<typeof vi.fn> } => ({
  liveClis: () => new Set(typeof live === 'function' ? live() : live),
  apply: vi.fn(),
});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('createPlanUsageService', () => {
  it('reads at start, for the CLIs somebody is using and no others', async () => {
    const claude = source('claude', async () => [usage('claude', 40, 1000)]);
    const codex = source('codex', async () => [usage('codex', 10, 1000, 10080)]);
    const h = host(['claude']);
    const service = createPlanUsageService(h, [claude, codex]);
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(claude.read).toHaveBeenCalledTimes(1);
    expect(codex.read).not.toHaveBeenCalled();
    expect(h.apply).toHaveBeenCalledWith('claude', expect.objectContaining({ cli: 'claude', asOf: 1000 }));
    service.stop();
  });

  it('polls on its interval and stops when told to', async () => {
    const claude = source('claude', async () => [usage('claude', 40, 1000)]);
    const service = createPlanUsageService(host(['claude']), [claude], { intervalMs: 15_000 });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(claude.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(claude.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(claude.read).toHaveBeenCalledTimes(2);
    service.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claude.read).toHaveBeenCalledTimes(2);
  });

  it('reads nothing while no session is using a CLI, and starts once one does', async () => {
    let live: PlanCli[] = [];
    const claude = source('claude', async () => [usage('claude', 40, 1000)]);
    const service = createPlanUsageService(host(() => live), [claude], { intervalMs: 1000 });
    service.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(claude.read).not.toHaveBeenCalled();
    live = ['claude'];
    await vi.advanceTimersByTimeAsync(1000);
    expect(claude.read).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('start is idempotent: a second call does not stack a second timer', async () => {
    const claude = source('claude', async () => []);
    const service = createPlanUsageService(host(['claude']), [claude], { intervalMs: 1000 });
    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(claude.read).toHaveBeenCalledTimes(3); // start + 2 ticks, not doubled
    service.stop();
  });

  it('merges the observations of several sources into one', async () => {
    const a = source('claude', async () => [usage('claude', 45, 1000)]);
    const b = source('claude', async () => [usage('claude', 40, 5000)]); // stale re-render, later stamp
    const h = host(['claude']);
    const service = createPlanUsageService(h, [a, b]);
    await service.refresh('claude');
    expect(h.apply).toHaveBeenCalledWith('claude', expect.objectContaining({ asOf: 5000, windows: [expect.objectContaining({ usedPercent: 45 })] }));
    expect(service.latest('claude')?.windows[0].usedPercent).toBe(45);
  });

  it('has nothing to say until a source does, and says nothing it does not know', async () => {
    const h = host(['claude']);
    const service = createPlanUsageService(h, [source('claude', async () => [])]);
    expect(service.latest('claude')).toBeNull();
    await service.refresh('claude');
    expect(h.apply).not.toHaveBeenCalled();
    expect(service.latest('claude')).toBeNull();
  });

  it('keeps what it knew when a source later has nothing (a swept snapshot), and tells the host again so a session that missed it is healed', async () => {
    let reading: PlanUsage[] = [usage('claude', 50, 5000)];
    const h = host(['claude']);
    const service = createPlanUsageService(h, [source('claude', async () => reading)]);
    await service.refresh('claude');
    reading = [];
    await service.refresh('claude');
    expect(service.latest('claude')?.windows[0].usedPercent).toBe(50);
    expect(service.latest('claude')?.asOf).toBe(5000);
    expect(h.apply).toHaveBeenCalledTimes(2);
  });

  it('an older, lower reading of the same window cannot lower what was known', async () => {
    let reading: PlanUsage[] = [usage('claude', 50, 5000)];
    const service = createPlanUsageService(host(['claude']), [source('claude', async () => reading)]);
    await service.refresh('claude');
    reading = [usage('claude', 10, 1000)];
    await service.refresh('claude');
    expect(service.latest('claude')?.windows[0].usedPercent).toBe(50);
  });

  it('follows a window that rolls over', async () => {
    let reading = [usage('claude', 90, 1000)];
    const service = createPlanUsageService(host(['claude']), [source('claude', async () => reading)]);
    await service.refresh('claude');
    reading = [{ cli: 'claude', windows: [{ minutes: 300, usedPercent: 3, resetsAt: R + 18_000_000 }], asOf: 9000 }];
    await service.refresh('claude');
    expect(service.latest('claude')?.windows[0].usedPercent).toBe(3);
  });

  describe('over time, through the service', () => {
    const W = 10_080;
    const week = (pct: number, resetsAt: number, asOf: number, cli: PlanCli = 'claude'): PlanUsage =>
      ({ cli, windows: [{ minutes: W, usedPercent: pct, resetsAt }], asOf });

    it('does not keep another login\'s numbers on screen — 72 h of the new account working, the old one\'s file still on disk', async () => {
      // Account A: weekly 80%, resets in 5 days. The user switches to B (resets in 4 days — SOONER than A) and
      // works on for 72 h, a fresh snapshot every 15 minutes; A's last snapshot is never rewritten.
      const A = week(80, NOW + 5 * D, NOW);
      const b = (t: number) => week(5 + Math.floor((t - NOW) / (12 * H)), NOW + 4 * D, t);
      let feed: PlanUsage[] = [A];
      const service = createPlanUsageService(host(['claude']), [source('claude', async () => feed)]);
      await service.refresh('claude');

      const shown = new Map<number, number | undefined>();
      for (let q = 0; q <= 72 * 4; q++) {
        const t = NOW + 10 * 60_000 + q * 15 * 60_000;
        vi.setSystemTime(t);
        feed = [A, b(t)];
        await service.refresh('claude');
        if (q % 4 === 0) shown.set(q / 4, service.latest('claude')?.windows[0].usedPercent);
      }
      // Inside the horizon the two logins cannot be told apart (the later reset wins); past it only B is on screen.
      for (const hours of [7, 12, 24, 48, 72]) {
        expect(shown.get(hours), `after ${hours} h`).toBe(b(NOW + 10 * 60_000 + hours * H).windows[0].usedPercent);
      }
      expect(service.latest('claude')?.asOf).toBe(NOW + 10 * 60_000 + 72 * H);
    });

    it('forgets another login as soon as its readings are gone: what was known cannot revive a window that is not the current one', async () => {
      let feed: PlanUsage[] = [week(80, NOW + 5 * D, NOW)];
      const service = createPlanUsageService(host(['claude']), [source('claude', async () => feed)]);
      await service.refresh('claude');
      expect(service.latest('claude')?.windows[0].usedPercent).toBe(80);
      vi.setSystemTime(NOW + 10 * 60_000);
      feed = [week(5, NOW + 4 * D, NOW + 10 * 60_000)]; // A swept, B writing
      await service.refresh('claude');
      expect(service.latest('claude')?.windows[0].usedPercent).toBe(5);
    });

    it('a stale re-render after a quiet night cannot undercut what was already known', async () => {
      // The same session file is rewritten by a mere status-line re-render: the evening's 35% is no longer on
      // disk, only remembered — and a remembered reading may raise, never lower, the same window.
      let feed: PlanUsage[] = [week(35, R, NOW)];
      const service = createPlanUsageService(host(['claude']), [source('claude', async () => feed)]);
      await service.refresh('claude');
      vi.setSystemTime(NOW + 9 * H);
      feed = [week(30, R, NOW + 9 * H)];
      await service.refresh('claude');
      expect(service.latest('claude')?.windows[0].usedPercent).toBe(35);
      expect(service.latest('claude')?.asOf).toBe(NOW + 9 * H);
    });

    for (const cli of ['claude', 'codex'] as const) {
      it(`a reset time that flips by a second does not hold the chip below the truth (${cli})`, async () => {
        const resetsAt = NOW + 2 * D;
        let feed: PlanUsage[] = [];
        const service = createPlanUsageService(host([cli]), [source(cli, async () => feed)]);
        for (let i = 0; i < 8; i++) {
          const t = NOW + i * 60_000;
          vi.setSystemTime(t);
          feed = [week(28 + i * 3, resetsAt + (i % 2 === 0 ? 1000 : 0), t, cli)];
          await service.refresh(cli);
          expect(service.latest(cli)?.windows[0].usedPercent, `reading ${i}`).toBe(28 + i * 3);
        }
      });
    }

    it('ignores a reading dated in the future: one bad timestamp must not win every merge', async () => {
      const h = host(['claude']);
      let feed: PlanUsage[] = [week(12, R, 9e15)];
      const service = createPlanUsageService(h, [source('claude', async () => feed)]);
      await service.refresh('claude');
      expect(service.latest('claude')).toBeNull();
      expect(h.apply).not.toHaveBeenCalled();
      feed = [week(12, R, 9e15), week(97, R, NOW - 1000)];
      await service.refresh('claude');
      expect(service.latest('claude')?.windows[0].usedPercent).toBe(97);
      // …and inside the allowed skew a reading is believed
      vi.setSystemTime(NOW + 60_000);
      feed = [week(98, R, NOW + 60_000 + MAX_FUTURE_SKEW_MS)];
      await service.refresh('claude');
      expect(service.latest('claude')?.windows[0].usedPercent).toBe(98);
    });

    it('ignores a window that resets implausibly far ahead; a reading left with no window is dropped', async () => {
      const h = host(['claude']);
      let feed: PlanUsage[] = [week(40, NOW + MAX_RESET_AHEAD_MS + H, NOW - 1000)];
      const service = createPlanUsageService(h, [source('claude', async () => feed)]);
      await service.refresh('claude');
      expect(service.latest('claude')).toBeNull();
      feed = [{ cli: 'claude', asOf: NOW - 1000, windows: [
        { minutes: 300, usedPercent: 11, resetsAt: NOW + H },
        { minutes: W, usedPercent: 40, resetsAt: NOW + MAX_RESET_AHEAD_MS + H },
      ] }];
      await service.refresh('claude');
      expect(service.latest('claude')?.windows.map((w) => w.minutes)).toEqual([300]);
    });
  });

  it('stops waiting for a source that never answers, and does not pile up reads behind it', async () => {
    let calls = 0;
    const hung = source('claude', () => { calls++; return new Promise<PlanUsage[]>(() => undefined); });
    const fine = source('claude', async () => [usage('claude', 40, NOW - 1000)]);
    const service = createPlanUsageService(host(['claude']), [hung, fine]);

    const first = service.refresh('claude');
    await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS);
    await expect(first).resolves.toBeUndefined();
    expect(service.latest('claude')?.windows[0].usedPercent).toBe(40); // the other source still served
    expect(calls).toBe(1);

    await service.refresh('claude'); // the first read is still pending: it is not repeated
    await service.refresh('claude');
    expect(calls).toBe(1);
  });

  it('does not freeze a CLI behind a hung read: the next refresh is not stuck on it', async () => {
    const hung = source('claude', () => new Promise<PlanUsage[]>(() => undefined));
    const service = createPlanUsageService(host(['claude']), [hung]);
    const first = service.refresh('claude');
    await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS - 1);
    let settled = false;
    void first.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const second = service.refresh('claude');
    await expect(second).resolves.toBeUndefined();
  });

  it('reads a source again once its slow read has finished', async () => {
    let release: (v: PlanUsage[]) => void = () => undefined;
    let calls = 0;
    const slow = source('claude', () => { calls++; return calls === 1 ? new Promise<PlanUsage[]>((r) => { release = r; }) : Promise.resolve([usage('claude', 41, NOW - 1000)]); });
    const service = createPlanUsageService(host(['claude']), [slow]);
    const first = service.refresh('claude');
    await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS);
    await first;
    await service.refresh('claude');
    expect(calls).toBe(1);
    release([usage('claude', 40, NOW - 2000)]);
    await vi.advanceTimersByTimeAsync(0);
    await service.refresh('claude');
    expect(calls).toBe(2);
    expect(service.latest('claude')?.windows[0].usedPercent).toBe(41);
  });

  it('keeps polling when the host cannot say which CLIs are live (one throw must not stop usage for every CLI)', async () => {
    let broken = true;
    const h = {
      liveClis: (): ReadonlySet<PlanCli> => { if (broken) throw new Error('boom'); return new Set<PlanCli>(['claude']); },
      apply: vi.fn(),
    };
    const claude = source('claude', async () => [usage('claude', 40, NOW - 1000)]);
    const service = createPlanUsageService(h, [claude], { intervalMs: 1000 });
    expect(() => service.start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(2500);
    expect(claude.read).not.toHaveBeenCalled();
    broken = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(claude.read).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('shares one read between simultaneous refreshes of a CLI', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const claude = source('claude', async () => { await gate; return [usage('claude', 40, 1000)]; });
    const service = createPlanUsageService(host(['claude']), [claude]);
    const first = service.refresh('claude');
    const second = service.refresh('claude');
    release();
    await Promise.all([first, second]);
    expect(claude.read).toHaveBeenCalledTimes(1);
    await service.refresh('claude');
    expect(claude.read).toHaveBeenCalledTimes(2);
  });

  it('survives a source that throws, and still uses the others', async () => {
    const broken = source('claude', async () => { throw new Error('EACCES'); });
    const fine = source('claude', async () => [usage('claude', 40, 1000)]);
    const h = host(['claude']);
    const service = createPlanUsageService(h, [broken, fine]);
    await expect(service.refresh('claude')).resolves.toBeUndefined();
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it('survives a host that throws', async () => {
    const h = host(['claude']);
    h.apply.mockImplementation(() => { throw new Error('boom'); });
    const service = createPlanUsageService(h, [source('claude', async () => [usage('claude', 40, 1000)])]);
    await expect(service.refresh('claude')).resolves.toBeUndefined();
    expect(service.latest('claude')?.windows[0].usedPercent).toBe(40);
  });

  it('keeps the two CLIs apart', async () => {
    const service = createPlanUsageService(host(['claude', 'codex']), [
      source('claude', async () => [usage('claude', 40, 1000)]),
      source('codex', async () => [usage('codex', 7, 2000, 10080)]),
    ]);
    await service.refresh('claude');
    await service.refresh('codex');
    expect(service.latest('claude')?.cli).toBe('claude');
    expect(service.latest('codex')?.windows[0].minutes).toBe(10080);
  });

  it('kick waits for its delay before reading', async () => {
    const claude = source('claude', async () => [usage('claude', 40, 1000)]);
    const service = createPlanUsageService(host(['claude']), [claude]);
    service.kick('claude', 2500);
    await vi.advanceTimersByTimeAsync(2499);
    expect(claude.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(claude.read).toHaveBeenCalledTimes(1);
  });

  it('kick keeps one pending read per CLI: the first request decides when, later ones fold into it', async () => {
    const claude = source('claude', async () => [usage('claude', 40, 1000)]);
    const service = createPlanUsageService(host(['claude']), [claude]);
    service.kick('claude', 2500);
    service.kick('claude', 2500);
    service.kick('claude'); // would be immediate on its own
    await vi.advanceTimersByTimeAsync(2499);
    expect(claude.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(claude.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(claude.read).toHaveBeenCalledTimes(1);
    // Once it has fired, the next request schedules a new one.
    service.kick('claude');
    await vi.advanceTimersByTimeAsync(0);
    expect(claude.read).toHaveBeenCalledTimes(2);
  });

  it('kick is per CLI', async () => {
    const claude = source('claude', async () => [usage('claude', 40, 1000)]);
    const codex = source('codex', async () => [usage('codex', 7, 1000, 10080)]);
    const service = createPlanUsageService(host(['claude', 'codex']), [claude, codex]);
    service.kick('claude', 1000);
    service.kick('codex', 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(claude.read).toHaveBeenCalledTimes(1);
    expect(codex.read).toHaveBeenCalledTimes(1);
  });

  it('stop cancels a pending kick', async () => {
    const claude = source('claude', async () => [usage('claude', 40, 1000)]);
    const service = createPlanUsageService(host(['claude']), [claude]);
    service.kick('claude', 2500);
    service.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(claude.read).not.toHaveBeenCalled();
  });
});

describe('applyUsageToSessions', () => {
  const sess = (sessionId: string, over: Partial<Session> = {}): Session =>
    ({ sessionId, status: 'idle', cliSource: 'claude', ...over }) as Session;
  const live = (s: Session): boolean => s.status !== 'ended';

  it('gives the usage to live sessions of that CLI only', () => {
    const mine = sess('a');
    const otherCli = sess('b', { cliSource: 'codex' });
    const ended = sess('c', { status: 'ended' });
    const unknown = sess('d', { cliSource: undefined, model: '', startupCommand: 'zsh' });
    const u = usage('claude', 40, 1000);
    const changed = applyUsageToSessions([mine, otherCli, ended, unknown], 'claude', u, live);
    expect(changed).toEqual([mine]);
    expect(mine.planUsage).toBe(u);
    expect(otherCli.planUsage).toBeUndefined();
    expect(ended.planUsage).toBeUndefined();
    expect(unknown.planUsage).toBeUndefined();
  });

  it('is idempotent: a second pass changes nothing', () => {
    const a = sess('a');
    const u = usage('claude', 40, 1000);
    expect(applyUsageToSessions([a], 'claude', u, live)).toHaveLength(1);
    expect(applyUsageToSessions([a], 'claude', u, live)).toEqual([]);
    expect(applyUsageToSessions([a], 'claude', { ...u, windows: u.windows.map((w) => ({ ...w })) }, live)).toEqual([]);
  });

  it('updates a session whose numbers are different', () => {
    const a = sess('a', { planUsage: usage('claude', 40, 1000) });
    const next = usage('claude', 55, 2000);
    expect(applyUsageToSessions([a], 'claude', next, live)).toEqual([a]);
    expect(a.planUsage).toBe(next);
  });

  it('never replaces a copy that is newer than what it is given', () => {
    const newer = usage('claude', 40, 9000);
    const a = sess('a', { planUsage: newer });
    expect(applyUsageToSessions([a], 'claude', usage('claude', 90, 1000), live)).toEqual([]);
    expect(a.planUsage).toBe(newer);
  });

  it('brings the time forward on unchanged numbers only once the copy is a while behind', () => {
    const a = sess('a', { planUsage: usage('claude', 40, 1000) });
    expect(applyUsageToSessions([a], 'claude', usage('claude', 40, 1000 + REFRESH_ASOF_MS - 1), live)).toEqual([]);
    expect(applyUsageToSessions([a], 'claude', usage('claude', 40, 1000 + REFRESH_ASOF_MS), live)).toEqual([a]);
    expect(a.planUsage?.asOf).toBe(1000 + REFRESH_ASOF_MS);
  });

  it('treats a copy dated far in the future as absent: a bad value restored from the snapshot must not block updates', () => {
    const bad = usage('claude', 99, 9e15);
    const a = sess('a', { planUsage: bad });
    const fresh = usage('claude', 40, 1000);
    expect(applyUsageToSessions([a], 'claude', fresh, live, 5000)).toEqual([a]);
    expect(a.planUsage).toBe(fresh);
    // inside the allowed skew a copy still counts as newer
    const near = usage('claude', 70, 5000 + MAX_FUTURE_SKEW_MS);
    const b = sess('b', { planUsage: near });
    expect(applyUsageToSessions([b], 'claude', fresh, live, 5000)).toEqual([]);
    expect(b.planUsage).toBe(near);
  });

  it('judges a copy against the real clock unless told otherwise', () => {
    const bad = sess('a', { planUsage: usage('claude', 99, 9e15) });
    expect(applyUsageToSessions([bad], 'claude', usage('claude', 40, NOW - 1000), live)).toEqual([bad]);
  });

  it('does not edit the usage it replaces', () => {
    const old = Object.freeze(usage('claude', 40, 1000));
    const a = sess('a', { planUsage: old });
    expect(() => applyUsageToSessions([a], 'claude', usage('claude', 55, 2000), live)).not.toThrow();
    expect(old.windows[0].usedPercent).toBe(40);
  });

  it('recognises a Codex card by its launch command when cliSource is missing', () => {
    const codex = sess('x', { cliSource: undefined, startupCommand: '/opt/homebrew/bin/codex --search' });
    expect(applyUsageToSessions([codex], 'codex', usage('codex', 7, 1000, 10080), live)).toEqual([codex]);
  });
});

describe('kickDelayFor', () => {
  it('asks for a reading straight away when a prompt goes in or a session starts', () => {
    expect(kickDelayFor('UserPromptSubmit')).toBe(0);
    expect(kickDelayFor('SessionStart')).toBe(0);
  });

  it('gives the status line a moment to render the finished turn before reading', () => {
    expect(kickDelayFor('Stop')).toBe(STOP_KICK_DELAY_MS);
    expect(STOP_KICK_DELAY_MS).toBeGreaterThan(0);
  });

  it('leaves every other event alone: tool calls fire constantly and the poll covers them', () => {
    for (const event of ['PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'SessionEnd', '', undefined]) {
      expect(kickDelayFor(event)).toBeNull();
    }
  });
});

import { describe, it, expect } from 'vitest';
import {
  pickNext,
  advanceAfterFire,
  advanceBlockedLoops,
  chainGateDecision,
  onceGateDecision,
  applyTypeDefaults,
  itemType,
  getActiveStep,
  isBeforeDailyStart,
  isExecuting,
  isInExcludeWindow,
  isItemInQuietHours,
  totalChainSteps,
  currentChainStep,
} from './queueScheduler';
import type { ChainStep, ExcludeWindow, QueueItem } from '@/stores/queueStore';

/** Build a unix-ms timestamp for "today at HH:MM" in local time. */
function todayAt(hour: number, minute: number): number {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function win(id: number, start: string, end: string): ExcludeWindow {
  return { id, startHHMM: start, endHHMM: end };
}

function step(id: number, text: string): ChainStep {
  return { id, text };
}

function mkItem(p: Partial<QueueItem>): QueueItem {
  return {
    id: p.id ?? 1,
    sessionId: 'sess',
    text: p.text ?? 'hello',
    position: p.position ?? 0,
    createdAt: p.createdAt ?? 0,
    ...p,
  };
}

describe('queueScheduler', () => {
  describe('itemType', () => {
    it('defaults to once when type missing', () => {
      expect(itemType(mkItem({}))).toBe('once');
    });
    it('respects explicit type', () => {
      expect(itemType(mkItem({ type: 'loop', intervalMs: 60_000 }))).toBe('loop');
    });
  });

  describe('chainGateDecision', () => {
    const FALLBACK = 12_000;
    // args: (gate, pickId, atRest, sessionSendable, now, fallbackMs)

    it('fires when there is no gate (not mid-chain or gate lost)', () => {
      expect(chainGateDecision(undefined, 7, true, true, 1000, FALLBACK)).toBe('fire');
    });

    it('fires when the gate guards a different item', () => {
      const gate = { itemId: 99, sawWork: false, openedAt: 0 };
      expect(chainGateDecision(gate, 7, true, true, 1000, FALLBACK)).toBe('fire');
    });

    it('holds during the stale-status window (sendable, work not yet seen)', () => {
      // Just sent the prior step; status still reads sendable but the hook
      // hasn't flipped it to working yet. Must NOT fire the next step.
      const gate = { itemId: 7, sawWork: false, openedAt: 1000 };
      expect(chainGateDecision(gate, 7, true, true, 1500, FALLBACK)).toBe('hold');
    });

    it('holds while the prior step is still running (working, not at rest)', () => {
      const gate = { itemId: 7, sawWork: true, openedAt: 1000 };
      // atRest=false (status='working'), sendable=false
      expect(chainGateDecision(gate, 7, false, false, 5000, FALLBACK)).toBe('hold');
    });

    it('fires once work was seen and the session reaches waiting (Stop)', () => {
      const gate = { itemId: 7, sawWork: true, openedAt: 1000 };
      // atRest=true (status='waiting'), sendable=true
      expect(chainGateDecision(gate, 7, true, true, 5000, FALLBACK)).toBe('fire');
    });

    it('HOLDS on decayed idle — a busy step that auto-idled is not done', () => {
      const gate = { itemId: 7, sawWork: true, openedAt: 1000 };
      // status='idle' → sendable=true but atRest=false. Long task that the
      // 3-min working→idle timeout flipped to idle must NOT release, even far
      // past the no-work fallback window.
      expect(chainGateDecision(gate, 7, false, true, 1_000_000, FALLBACK)).toBe('hold');
    });

    it('HOLDS on input — the running agent is asking the user, not finished', () => {
      const gate = { itemId: 7, sawWork: true, openedAt: 1000 };
      // status='input' → sendable=true, atRest=false
      expect(chainGateDecision(gate, 7, false, true, 5000, FALLBACK)).toBe('hold');
    });

    it('fires via the no-work fallback for a step that never goes busy', () => {
      const gate = { itemId: 7, sawWork: false, openedAt: 1000 };
      // Local slash command (e.g. /clear): never observed busy, stays sendable.
      // atRest=false the whole time; only the fallback can release it.
      expect(chainGateDecision(gate, 7, false, true, 1000 + FALLBACK, FALLBACK)).toBe('fire');
      // One ms short of the fallback → still holding.
      expect(chainGateDecision(gate, 7, false, true, 1000 + FALLBACK - 1, FALLBACK)).toBe('hold');
    });

    it('no fallback escape once work was seen (waits strictly for Stop)', () => {
      const gate = { itemId: 7, sawWork: true, openedAt: 1000 };
      // Even way past the fallback, a real running turn (working) must hold.
      expect(chainGateDecision(gate, 7, false, false, 1000 + FALLBACK * 100, FALLBACK)).toBe('hold');
    });
  });

  describe('onceGateDecision (sequential once dispatch)', () => {
    const FALLBACK = 12_000;
    // args: (gate, atRest, sessionSendable, now, fallbackMs)

    it('fires when there is no gate (first once, nothing pending before it)', () => {
      expect(onceGateDecision(undefined, true, true, 1000, FALLBACK)).toBe('fire');
    });

    it('holds in the stale-status window right after the prior once was sent', () => {
      // once#1 just sent; status still reads sendable but work has not begun.
      const gate = { sawWork: false, openedAt: 1000 };
      expect(onceGateDecision(gate, true, true, 1500, FALLBACK)).toBe('hold');
    });

    it('holds while the prior once is still running (working)', () => {
      const gate = { sawWork: true, openedAt: 1000 };
      expect(onceGateDecision(gate, false, false, 5000, FALLBACK)).toBe('hold');
    });

    it('fires the next once only after the prior one reaches waiting (Stop)', () => {
      const gate = { sawWork: true, openedAt: 1000 };
      expect(onceGateDecision(gate, true, true, 5000, FALLBACK)).toBe('fire');
    });

    it('HOLDS on decayed idle — a long once task that auto-idled is not done', () => {
      const gate = { sawWork: true, openedAt: 1000 };
      // status='idle' → sendable but atRest=false; must not release the next once.
      expect(onceGateDecision(gate, false, true, 1_000_000, FALLBACK)).toBe('hold');
    });

    it('fires via the no-work fallback for an instant no-op once', () => {
      const gate = { sawWork: false, openedAt: 1000 };
      expect(onceGateDecision(gate, false, true, 1000 + FALLBACK, FALLBACK)).toBe('fire');
      expect(onceGateDecision(gate, false, true, 1000 + FALLBACK - 1, FALLBACK)).toBe('hold');
    });
  });

  describe('pickNext priority rules', () => {
    it('drains once items first when session is waiting', () => {
      const items = [
        mkItem({ id: 10, type: 'loop', intervalMs: 60_000, nextFireAt: 0 }),
        mkItem({ id: 11, type: 'once' }),
        mkItem({ id: 12, type: 'schedule', runAt: 0, nextFireAt: 0 }),
      ];
      expect(pickNext(items, 1000, true, true)?.id).toBe(11);
    });

    it('returns null while session is busy when the only items are once (once needs sessionWaiting)', () => {
      const items = [mkItem({ id: 11, type: 'once' })];
      expect(pickNext(items, 1000, false, true)).toBeNull();
    });

    it('falls through to loop/schedule when session is busy AND idleGuard=false, even with a once item present', () => {
      const items = [
        mkItem({ id: 11, type: 'once' }),
        mkItem({ id: 12, type: 'loop', intervalMs: 60_000, nextFireAt: 0 }),
      ];
      // Session is NOT waiting, idleGuard is OFF — loop item with idleGuard=false
      // must still fire instead of being starved behind the stuck once.
      expect(pickNext(items, 5000, false, false)?.id).toBe(12);
    });

    it('once item still wins when session IS waiting, even if loop is also due', () => {
      const items = [
        mkItem({ id: 11, type: 'once' }),
        mkItem({ id: 12, type: 'loop', intervalMs: 60_000, nextFireAt: 0 }),
      ];
      expect(pickNext(items, 5000, true, true)?.id).toBe(11);
    });

    it('selects earliest-due loop/schedule when no once items', () => {
      const items = [
        mkItem({ id: 10, type: 'loop', intervalMs: 60_000, nextFireAt: 5_000 }),
        mkItem({ id: 11, type: 'schedule', runAt: 1_000, nextFireAt: 1_000 }),
      ];
      expect(pickNext(items, 10_000, true, true)?.id).toBe(11);
    });

    it('skips loop/schedule items that are not yet due', () => {
      const items = [mkItem({ id: 11, type: 'schedule', runAt: 5_000, nextFireAt: 5_000 })];
      expect(pickNext(items, 1_000, true, true)).toBeNull();
    });

    it('idleGuard=true blocks loop/schedule while session is busy', () => {
      const items = [mkItem({ id: 11, type: 'schedule', runAt: 0, nextFireAt: 0 })];
      expect(pickNext(items, 10_000, false, true)).toBeNull();
    });

    it('idleGuard=false allows loop/schedule to fire while busy', () => {
      const items = [mkItem({ id: 11, type: 'schedule', runAt: 0, nextFireAt: 0 })];
      expect(pickNext(items, 10_000, false, false)?.id).toBe(11);
    });
  });

  describe('advanceAfterFire', () => {
    it('removes once items', () => {
      expect(advanceAfterFire(mkItem({ type: 'once' }), 100).action).toBe('remove');
    });
    it('reschedules loop items by intervalMs and increments totalFires', () => {
      const item = mkItem({ type: 'loop', intervalMs: 1000, totalFires: 2 });
      const result = advanceAfterFire(item, 50_000);
      expect(result.action).toBe('reschedule');
      if (result.action !== 'reschedule') throw new Error('unreachable');
      expect(result.patch.nextFireAt).toBe(51_000);
      expect(result.patch.lastFiredAt).toBe(50_000);
      expect(result.patch.totalFires).toBe(3);
    });
    it('keeps a loop alive (reschedule with clamped 60s interval) when intervalMs is missing', () => {
      const r = advanceAfterFire(mkItem({ type: 'loop' }), 100);
      // A loop the user explicitly enabled must NEVER be silently deleted just
      // because its interval is missing — it self-heals to the 60s default.
      expect(r.action).toBe('reschedule');
      if (r.action !== 'reschedule') throw new Error('unreachable');
      expect(r.patch.intervalMs).toBe(60_000);
      expect(r.patch.nextFireAt).toBe(100 + 60_000);
    });
    it('keeps a loop alive when intervalMs is zero or negative (heals to 60s)', () => {
      for (const bad of [0, -5, Number.NaN]) {
        const r = advanceAfterFire(mkItem({ type: 'loop', intervalMs: bad }), 100);
        expect(r.action).toBe('reschedule');
        if (r.action !== 'reschedule') throw new Error('unreachable');
        expect(r.patch.intervalMs).toBe(60_000);
      }
    });
    it('removes one-shot schedule items', () => {
      expect(advanceAfterFire(mkItem({ type: 'schedule', runAt: 5 }), 100).action).toBe('remove');
    });
  });

  describe('applyTypeDefaults', () => {
    const base = {
      id: 1,
      sessionId: 's',
      text: 'x',
      position: 0,
      createdAt: 0,
    };
    it('forces nextFireAt=0 for once', () => {
      const out = applyTypeDefaults(base, 'once', {});
      expect(out.nextFireAt).toBe(0);
      expect(out.type).toBe('once');
    });
    it('falls back to 60s interval for loop when intervalMs missing', () => {
      const out = applyTypeDefaults(base, 'loop', {});
      expect(out.intervalMs).toBe(60_000);
      expect(out.nextFireAt).toBeGreaterThan(0);
    });
    it('sets nextFireAt=runAt for schedule', () => {
      const out = applyTypeDefaults(base, 'schedule', { runAt: 999_999 });
      expect(out.runAt).toBe(999_999);
      expect(out.nextFireAt).toBe(999_999);
    });
  });

  // -----------------------------------------------------------------
  // Chain (before/main/after) execution
  // -----------------------------------------------------------------

  describe('chain execution', () => {
    const loopWithChain = (): QueueItem =>
      mkItem({
        id: 100,
        type: 'loop',
        intervalMs: 60_000,
        nextFireAt: 0,
        text: 'main prompt',
        beforeChain: [step(1, '/context'), step(2, 'git status')],
        afterChain: [step(3, '/compact')],
      });

    it('getActiveStep returns the first before step when item is idle and has a before-chain', () => {
      const it = loopWithChain();
      expect(getActiveStep(it).text).toBe('/context');
    });

    it('getActiveStep returns the in-flight before step', () => {
      const it: QueueItem = { ...loopWithChain(), execState: 'before', execStepIdx: 1 };
      expect(getActiveStep(it).text).toBe('git status');
    });

    it('getActiveStep returns main when execState=main', () => {
      const it: QueueItem = { ...loopWithChain(), execState: 'main', execStepIdx: 0 };
      expect(getActiveStep(it).text).toBe('main prompt');
    });

    it('getActiveStep returns the in-flight after step', () => {
      const it: QueueItem = { ...loopWithChain(), execState: 'after', execStepIdx: 0 };
      expect(getActiveStep(it).text).toBe('/compact');
    });

    it('falls back to main when execStepIdx is out of range', () => {
      const it: QueueItem = { ...loopWithChain(), execState: 'before', execStepIdx: 99 };
      expect(getActiveStep(it).text).toBe('main prompt');
    });

    it('skips the before-chain when empty and idle', () => {
      const it = mkItem({ type: 'loop', intervalMs: 60_000, text: 'main', afterChain: [step(1, 'after-1')] });
      expect(getActiveStep(it).text).toBe('main');
    });

    it('advance from idle into before chain (2 before steps)', () => {
      const it = loopWithChain();
      const r = advanceAfterFire(it, 1000);
      // We've just sent before[0]; next is before[1]
      expect(r.action).toBe('continue');
      if (r.action !== 'continue') throw new Error('unreachable');
      expect(r.patch.execState).toBe('before');
      expect(r.patch.execStepIdx).toBe(1);
    });

    it('advance from before[1] (last before) → main', () => {
      const it: QueueItem = { ...loopWithChain(), execState: 'before', execStepIdx: 1 };
      const r = advanceAfterFire(it, 1000);
      expect(r.action).toBe('continue');
      if (r.action !== 'continue') throw new Error('unreachable');
      expect(r.patch.execState).toBe('main');
      expect(r.patch.execStepIdx).toBe(0);
    });

    it('advance from main → after[0]', () => {
      const it: QueueItem = { ...loopWithChain(), execState: 'main', execStepIdx: 0 };
      const r = advanceAfterFire(it, 1000);
      expect(r.action).toBe('continue');
      if (r.action !== 'continue') throw new Error('unreachable');
      expect(r.patch.execState).toBe('after');
      expect(r.patch.execStepIdx).toBe(0);
    });

    it('advance from last after → reschedule for loop, with execState reset', () => {
      const it: QueueItem = { ...loopWithChain(), execState: 'after', execStepIdx: 0 };
      const r = advanceAfterFire(it, 5000);
      expect(r.action).toBe('reschedule');
      if (r.action !== 'reschedule') throw new Error('unreachable');
      expect(r.patch.execState).toBe('idle');
      expect(r.patch.execStepIdx).toBeUndefined();
      expect(r.patch.nextFireAt).toBe(5000 + 60_000);
      expect(r.patch.totalFires).toBe(1);
    });

    it('schedule item with chain → remove on completion (one-shot)', () => {
      const it: QueueItem = {
        ...loopWithChain(),
        type: 'schedule',
        runAt: 0,
        intervalMs: undefined,
        execState: 'after',
        execStepIdx: 0,
      };
      const r = advanceAfterFire(it, 1000);
      expect(r.action).toBe('remove');
    });

    it('loop with no chain at all → reschedule directly from idle', () => {
      const it = mkItem({ type: 'loop', intervalMs: 1000, nextFireAt: 0, text: 'just main' });
      const r = advanceAfterFire(it, 50_000);
      expect(r.action).toBe('reschedule');
      if (r.action !== 'reschedule') throw new Error('unreachable');
      expect(r.patch.nextFireAt).toBe(51_000);
    });

    it('pickNext returns the in-flight chain item even before its next-fire time', () => {
      const inFlight: QueueItem = {
        ...loopWithChain(),
        nextFireAt: 9_999_999_999_999, // far future
        execState: 'before',
        execStepIdx: 0,
      };
      const due = mkItem({ id: 200, type: 'schedule', runAt: 0, nextFireAt: 0 });
      const r = pickNext([inFlight, due], 1000, true, true);
      expect(r?.id).toBe(100);
    });

    it('pickNext respects idleGuard for in-flight chains (no fire mid-tool)', () => {
      const inFlight: QueueItem = {
        ...loopWithChain(),
        execState: 'main',
        execStepIdx: 0,
      };
      expect(pickNext([inFlight], 1000, false, true)).toBeNull();
    });

    it('isInExcludeWindow: undefined / empty → false', () => {
      expect(isInExcludeWindow(undefined, todayAt(12, 0))).toBe(false);
      expect(isInExcludeWindow([], todayAt(12, 0))).toBe(false);
    });

    it('isInExcludeWindow: same-day window blocks inside, allows outside', () => {
      const windows = [win(1, '09:00', '18:00')];
      expect(isInExcludeWindow(windows, todayAt(8, 59))).toBe(false);
      expect(isInExcludeWindow(windows, todayAt(9, 0))).toBe(true);  // start inclusive
      expect(isInExcludeWindow(windows, todayAt(13, 30))).toBe(true);
      expect(isInExcludeWindow(windows, todayAt(17, 59))).toBe(true);
      expect(isInExcludeWindow(windows, todayAt(18, 0))).toBe(false); // end exclusive
      expect(isInExcludeWindow(windows, todayAt(23, 0))).toBe(false);
    });

    it('isInExcludeWindow: midnight-wrapping window (22:00 → 06:00)', () => {
      const windows = [win(1, '22:00', '06:00')];
      expect(isInExcludeWindow(windows, todayAt(21, 59))).toBe(false);
      expect(isInExcludeWindow(windows, todayAt(22, 0))).toBe(true);
      expect(isInExcludeWindow(windows, todayAt(23, 30))).toBe(true);
      expect(isInExcludeWindow(windows, todayAt(0, 0))).toBe(true);
      expect(isInExcludeWindow(windows, todayAt(5, 59))).toBe(true);
      expect(isInExcludeWindow(windows, todayAt(6, 0))).toBe(false);
    });

    it('isInExcludeWindow: "18:00 → 00:00" interpreted as 18:00 to end-of-day', () => {
      const windows = [win(1, '18:00', '00:00')];
      // start > end (18:00 > 00:00) → wraps. [18:00, 24:00) ∪ [00:00, 00:00)
      // The second range is empty so this effectively blocks only 18:00–24:00.
      expect(isInExcludeWindow(windows, todayAt(17, 59))).toBe(false);
      expect(isInExcludeWindow(windows, todayAt(18, 0))).toBe(true);
      expect(isInExcludeWindow(windows, todayAt(23, 59))).toBe(true);
      expect(isInExcludeWindow(windows, todayAt(0, 0))).toBe(false);
    });

    it('isInExcludeWindow: multiple windows — any match blocks', () => {
      const windows = [win(1, '00:00', '09:00'), win(2, '18:00', '00:00')];
      expect(isInExcludeWindow(windows, todayAt(3, 0))).toBe(true);   // inside first
      expect(isInExcludeWindow(windows, todayAt(20, 0))).toBe(true);  // inside second
      expect(isInExcludeWindow(windows, todayAt(12, 0))).toBe(false); // outside both
      expect(isInExcludeWindow(windows, todayAt(9, 0))).toBe(false);  // end-exclusive boundary
      expect(isInExcludeWindow(windows, todayAt(17, 59))).toBe(false);
      expect(isInExcludeWindow(windows, todayAt(18, 0))).toBe(true);
    });

    it('isInExcludeWindow: invalid window (start === end) is ignored', () => {
      const windows = [win(1, '09:00', '09:00')];
      expect(isInExcludeWindow(windows, todayAt(9, 0))).toBe(false);
      expect(isInExcludeWindow(windows, todayAt(15, 0))).toBe(false);
    });

    it('isInExcludeWindow: malformed strings are ignored', () => {
      const windows = [
        { id: 1, startHHMM: 'abc', endHHMM: '09:00' },
        { id: 2, startHHMM: '25:00', endHHMM: '09:00' },
        { id: 3, startHHMM: '09:60', endHHMM: '10:00' },
      ];
      expect(isInExcludeWindow(windows, todayAt(8, 0))).toBe(false);
    });

    it('pickNext respects exclude window — loop is skipped when inside', () => {
      // Build a loop that's due now but inside an exclusion that covers 00:00–23:59.
      const blockAll = [win(1, '00:00', '23:59')];
      const it = mkItem({
        id: 50,
        type: 'loop',
        intervalMs: 60_000,
        nextFireAt: 0,
        excludeWindows: blockAll,
      });
      // 12:00 is inside [00:00, 23:59).
      const r = pickNext([it], todayAt(12, 0), true, true);
      expect(r).toBeNull();
    });

    it('pickNext ignores exclude window for in-flight chains (chain finishes mid-window)', () => {
      const blockAll = [win(1, '00:00', '23:59')];
      const it = mkItem({
        id: 51,
        type: 'loop',
        intervalMs: 60_000,
        nextFireAt: 0,
        excludeWindows: blockAll,
        execState: 'main',
        execStepIdx: 0,
        beforeChain: [step(1, 'b')],
      });
      // Even inside the exclusion, an in-flight chain (PRIORITY 0) wins.
      const r = pickNext([it], todayAt(12, 0), true, true);
      expect(r?.id).toBe(51);
    });

    it('pickNext: session-level windows block a loop with no per-item windows', () => {
      const sessionWindows = [win(1, '00:00', '09:00')];
      const it = mkItem({
        id: 60,
        type: 'loop',
        intervalMs: 60_000,
        nextFireAt: 0,
      });
      // 03:00 falls in [00:00, 09:00).
      expect(pickNext([it], todayAt(3, 0), true, true, sessionWindows)).toBeNull();
      // 12:00 is outside the session window → fires.
      expect(pickNext([it], todayAt(12, 0), true, true, sessionWindows)?.id).toBe(60);
    });

    it('pickNext: per-item windows still block when session has none', () => {
      const it = mkItem({
        id: 61,
        type: 'loop',
        intervalMs: 60_000,
        nextFireAt: 0,
        excludeWindows: [win(1, '12:00', '13:00')],
      });
      expect(pickNext([it], todayAt(12, 30), true, true)).toBeNull();
      expect(pickNext([it], todayAt(12, 30), true, true, [])).toBeNull();
    });

    it('pickNext: session ∪ per-item — either blocks', () => {
      const sessionWindows = [win(1, '00:00', '09:00')];
      const it = mkItem({
        id: 62,
        type: 'loop',
        intervalMs: 60_000,
        nextFireAt: 0,
        excludeWindows: [win(2, '12:00', '13:00')],
      });
      // 03:00 → session window blocks
      expect(pickNext([it], todayAt(3, 0), true, true, sessionWindows)).toBeNull();
      // 12:30 → per-item window blocks
      expect(pickNext([it], todayAt(12, 30), true, true, sessionWindows)).toBeNull();
      // 10:00 → neither blocks
      expect(pickNext([it], todayAt(10, 0), true, true, sessionWindows)?.id).toBe(62);
    });

    it('pickNext: in-flight chain ignores BOTH window lists', () => {
      const sessionWindows = [win(1, '00:00', '23:59')];
      const it: QueueItem = {
        ...mkItem({
          id: 63,
          type: 'loop',
          intervalMs: 60_000,
          excludeWindows: [win(2, '00:00', '23:59')],
        }),
        execState: 'main',
        execStepIdx: 0,
      };
      // Even with everything blocked, the in-flight chain wins via PRIORITY 0.
      expect(pickNext([it], todayAt(12, 0), true, true, sessionWindows)?.id).toBe(63);
    });

    it('skipWhenPrompting=true blocks ALL fires (even in-flight chains) when blockedByPrompting flag is true', () => {
      const inFlight: QueueItem = {
        ...mkItem({ id: 70, type: 'loop', intervalMs: 60_000 }),
        execState: 'main',
        execStepIdx: 0,
      };
      const onceItem = mkItem({ id: 71, type: 'once' });
      const dueLoop = mkItem({ id: 72, type: 'loop', intervalMs: 60_000, nextFireAt: 0 });
      const items = [inFlight, onceItem, dueLoop];
      // sessionWaiting=true, idleGuard=false (would fire all 3 normally)
      expect(pickNext(items, 1000, true, false, undefined, true)).toBeNull();
    });

    it('advanceBlockedLoops rolls due loops forward to now+intervalMs', () => {
      const dueLoop = mkItem({
        id: 80,
        type: 'loop',
        intervalMs: 60_000,
        nextFireAt: 0, // due immediately
      });
      const futureLoop = mkItem({
        id: 81,
        type: 'loop',
        intervalMs: 60_000,
        nextFireAt: 99_999_999,
      });
      const dueSched = mkItem({
        id: 82,
        type: 'schedule',
        runAt: 0,
        nextFireAt: 0, // due — but schedules should NOT be advanced
      });
      const dueOnce = mkItem({ id: 83, type: 'once' }); // not advanced either
      const inFlightLoop: QueueItem = {
        ...mkItem({ id: 84, type: 'loop', intervalMs: 60_000, nextFireAt: 0 }),
        execState: 'main',
        execStepIdx: 0,
      };
      const patches = advanceBlockedLoops(
        [dueLoop, futureLoop, dueSched, dueOnce, inFlightLoop],
        100_000,
      );
      // Only the idle, due loop is advanced. Future loop, schedule, once,
      // and the in-flight chain are all left untouched.
      expect(patches).toHaveLength(1);
      expect(patches[0].id).toBe(80);
      expect(patches[0].patch.nextFireAt).toBe(100_000 + 60_000);
    });

    it('advanceBlockedLoops returns no patches when nothing is due', () => {
      const items = [
        mkItem({ id: 90, type: 'loop', intervalMs: 1000, nextFireAt: 999_999 }),
      ];
      expect(advanceBlockedLoops(items, 1000)).toEqual([]);
    });

    it('advanceBlockedLoops skips loop with no intervalMs (corrupted row)', () => {
      const items = [
        mkItem({ id: 91, type: 'loop', nextFireAt: 0 }), // intervalMs missing
      ];
      expect(advanceBlockedLoops(items, 1000)).toEqual([]);
    });

    it('skips OTHER due loops while one item is mid-chain, leaving the in-flight item untouched', () => {
      // SKIP-while-running semantics: loop A is executing its chain; loop B
      // comes due. B's cycle must be dropped (nextFireAt rolled forward), and
      // the in-flight A must NOT be advanced — it completes its own cycle.
      const inFlight = mkItem({
        id: 200,
        type: 'loop',
        intervalMs: 60_000,
        nextFireAt: 0, // would be "due" but it's executing
        execState: 'main',
        execStepIdx: 0,
      });
      const dueOther = mkItem({
        id: 201,
        type: 'loop',
        intervalMs: 60_000,
        nextFireAt: 0, // due now
      });
      const patches = advanceBlockedLoops([inFlight, dueOther], 100_000);
      // Only the non-executing due loop is skipped forward.
      expect(patches).toEqual([{ id: 201, patch: { nextFireAt: 160_000 } }]);
    });

    it('pickNext skips per-item disabled items (once)', () => {
      const items = [
        mkItem({ id: 100, type: 'once', disabled: true }),
        mkItem({ id: 101, type: 'once' }),
      ];
      expect(pickNext(items, 1000, true, true)?.id).toBe(101);
    });

    it('pickNext skips per-item disabled items (loop)', () => {
      const items = [
        mkItem({ id: 102, type: 'loop', intervalMs: 60_000, nextFireAt: 0, disabled: true }),
        mkItem({ id: 103, type: 'loop', intervalMs: 60_000, nextFireAt: 500 }),
      ];
      expect(pickNext(items, 1000, true, true)?.id).toBe(103);
    });

    it('pickNext returns null when the only fireable item is disabled', () => {
      const items = [
        mkItem({ id: 104, type: 'once', disabled: true }),
      ];
      expect(pickNext(items, 1000, true, true)).toBeNull();
    });

    it('pickNext does NOT resume an in-flight chain that became disabled', () => {
      // Mid-chain disable: scheduler should respect the user's pause and
      // leave the chain frozen rather than firing the next step.
      const it: QueueItem = {
        ...mkItem({ id: 105, type: 'loop', intervalMs: 60_000, disabled: true }),
        execState: 'main',
        execStepIdx: 0,
      };
      expect(pickNext([it], 1000, true, true)).toBeNull();
    });

    it('advanceBlockedLoops skips disabled loops (does not roll their nextFireAt)', () => {
      const items = [
        mkItem({ id: 106, type: 'loop', intervalMs: 60_000, nextFireAt: 0, disabled: true }),
        mkItem({ id: 107, type: 'loop', intervalMs: 60_000, nextFireAt: 0 }),
      ];
      const patches = advanceBlockedLoops(items, 100_000);
      expect(patches).toHaveLength(1);
      expect(patches[0].id).toBe(107);
    });

    it('skipWhenPrompting=false (or undefined) does not interfere with normal firing', () => {
      const inFlight: QueueItem = {
        ...mkItem({ id: 75, type: 'loop', intervalMs: 60_000 }),
        execState: 'main',
        execStepIdx: 0,
      };
      // With blockedByPrompting=false, in-flight chain fires as before.
      expect(pickNext([inFlight], 1000, true, true, undefined, false)?.id).toBe(75);
      expect(pickNext([inFlight], 1000, true, true)?.id).toBe(75);
    });

    it('isItemInQuietHours: per-item window only', () => {
      const loop = mkItem({
        id: 200, type: 'loop', intervalMs: 60_000,
        excludeWindows: [win(1, '00:00', '23:59')],
      });
      expect(isItemInQuietHours(loop, undefined, todayAt(12, 0))).toBe(true);
    });

    it('isItemInQuietHours: session-level window only', () => {
      const loop = mkItem({ id: 201, type: 'loop', intervalMs: 60_000 });
      expect(
        isItemInQuietHours(loop, [win(2, '00:00', '23:59')], todayAt(12, 0)),
      ).toBe(true);
    });

    it('isItemInQuietHours: neither window blocks now', () => {
      const loop = mkItem({
        id: 202, type: 'loop', intervalMs: 60_000,
        excludeWindows: [win(3, '02:00', '04:00')],
      });
      expect(
        isItemInQuietHours(loop, [win(4, '02:00', '04:00')], todayAt(12, 0)),
      ).toBe(false);
    });

    it('isItemInQuietHours: schedule items ignore windows by design', () => {
      const sched = mkItem({
        id: 203, type: 'schedule', runAt: 0, nextFireAt: 0,
        excludeWindows: [win(5, '00:00', '23:59')],
      });
      expect(
        isItemInQuietHours(sched, [win(6, '00:00', '23:59')], todayAt(12, 0)),
      ).toBe(false);
    });

    it('isItemInQuietHours: once items ignore windows', () => {
      const once = mkItem({ id: 204, type: 'once' });
      expect(
        isItemInQuietHours(once, [win(7, '00:00', '23:59')], todayAt(12, 0)),
      ).toBe(false);
    });

    it('isBeforeDailyStart: returns false when no clamp set', () => {
      const it = mkItem({ id: 300, type: 'loop', intervalMs: 60_000 });
      expect(isBeforeDailyStart(it, todayAt(6, 0))).toBe(false);
    });

    it('isBeforeDailyStart: returns true before clamp time', () => {
      const it = mkItem({ id: 301, type: 'loop', intervalMs: 60_000, firstFireOfDay: '09:00' });
      expect(isBeforeDailyStart(it, todayAt(6, 0))).toBe(true);
      expect(isBeforeDailyStart(it, todayAt(8, 59))).toBe(true);
    });

    it('isBeforeDailyStart: returns false at or after clamp time', () => {
      const it = mkItem({ id: 302, type: 'loop', intervalMs: 60_000, firstFireOfDay: '09:00' });
      expect(isBeforeDailyStart(it, todayAt(9, 0))).toBe(false);
      expect(isBeforeDailyStart(it, todayAt(15, 30))).toBe(false);
    });

    it('isBeforeDailyStart: schedule items ignore clamp', () => {
      const it = mkItem({
        id: 303, type: 'schedule', runAt: 0, nextFireAt: 0,
        firstFireOfDay: '09:00',
      });
      expect(isBeforeDailyStart(it, todayAt(6, 0))).toBe(false);
    });

    it('isBeforeDailyStart: malformed clamp string returns false (no clamp)', () => {
      const it = mkItem({ id: 304, type: 'loop', intervalMs: 60_000, firstFireOfDay: 'banana' });
      expect(isBeforeDailyStart(it, todayAt(6, 0))).toBe(false);
    });

    it('pickNext skips a due loop when before daily start clamp', () => {
      const it = mkItem({
        id: 305, type: 'loop', intervalMs: 60_000, nextFireAt: 0,
        firstFireOfDay: '09:00',
      });
      // 06:00 — clamp blocks
      expect(pickNext([it], todayAt(6, 0), true, true)).toBeNull();
      // 09:00 — clamp passed, loop fires
      expect(pickNext([it], todayAt(9, 0), true, true)?.id).toBe(305);
    });

    it('advanceBlockedLoops skips loops still before their daily start clamp', () => {
      const it = mkItem({
        id: 306, type: 'loop', intervalMs: 60_000, nextFireAt: 0,
        firstFireOfDay: '09:00',
      });
      // 06:00 — clamp blocks; nextFireAt should NOT roll forward
      const patches = advanceBlockedLoops([it], todayAt(6, 0));
      expect(patches).toEqual([]);
    });

    it('pickNext does NOT apply exclude window to schedule items', () => {
      // Schedules carry their own runAt — the user picked that time explicitly,
      // so per-day windows shouldn't second-guess them.
      const blockAll = [win(1, '00:00', '23:59')];
      const it = mkItem({
        id: 52,
        type: 'schedule',
        runAt: 0,
        nextFireAt: 0,
        excludeWindows: blockAll, // present but should be ignored for schedule
      });
      const r = pickNext([it], todayAt(12, 0), true, true);
      expect(r?.id).toBe(52);
    });

    it('isExecuting / totalChainSteps / currentChainStep', () => {
      const idle = loopWithChain();
      expect(isExecuting(idle)).toBe(false);
      expect(totalChainSteps(idle)).toBe(4); // 2 before + main + 1 after
      expect(currentChainStep(idle)).toBe(0);

      const midBefore: QueueItem = { ...idle, execState: 'before', execStepIdx: 1 };
      expect(currentChainStep(midBefore)).toBe(2); // before[1] → step 2 in flat seq

      const midMain: QueueItem = { ...idle, execState: 'main', execStepIdx: 0 };
      expect(currentChainStep(midMain)).toBe(3); // 2 before + 1 main

      const midAfter: QueueItem = { ...idle, execState: 'after', execStepIdx: 0 };
      expect(currentChainStep(midAfter)).toBe(4);
    });
  });

  // The manual "⚡ NOW" button hands the FULL before→main→after chain to the
  // scheduler by setting `forceStart`. The scheduler must start it immediately,
  // ignoring every start-edge timing rule, while still letting an already
  // in-flight chain finish first (chain atomicity).
  describe('force-start (manual ⚡ NOW)', () => {
    it('fires a force-started loop immediately — bypasses due-time + idle-guard', () => {
      const it = mkItem({
        id: 400, type: 'loop', intervalMs: 60_000,
        nextFireAt: 9_999_999, // not due yet
        forceStart: true,
      });
      // session busy (sessionWaiting=false), idleGuard ON → would normally hold.
      expect(pickNext([it], 1000, false, true)?.id).toBe(400);
    });

    it('fires a force-started loop even inside a quiet-hours window (per-item AND session-level)', () => {
      const it = mkItem({
        id: 401, type: 'loop', intervalMs: 60_000, nextFireAt: 0,
        excludeWindows: [win(1, '00:00', '23:59')],
        forceStart: true,
      });
      expect(pickNext([it], todayAt(12, 0), true, true)?.id).toBe(401);
      expect(
        pickNext([it], todayAt(12, 0), true, true, [win(2, '00:00', '23:59')])?.id,
      ).toBe(401);
    });

    it('fires a force-started loop even before its daily-start clamp', () => {
      const it = mkItem({
        id: 402, type: 'loop', intervalMs: 60_000, nextFireAt: 0,
        firstFireOfDay: '09:00',
        forceStart: true,
      });
      expect(pickNext([it], todayAt(6, 0), true, true)?.id).toBe(402);
    });

    it('a force-started item wins over a due once item', () => {
      const items = [
        mkItem({ id: 410, type: 'once' }),
        mkItem({ id: 411, type: 'loop', intervalMs: 60_000, nextFireAt: 9_999_999, forceStart: true }),
      ];
      expect(pickNext(items, 1000, true, true)?.id).toBe(411);
    });

    it('an in-flight chain still beats a fresh force-started item (no interleaving)', () => {
      const inFlight: QueueItem = {
        ...mkItem({ id: 420, type: 'loop', intervalMs: 60_000 }),
        execState: 'main', execStepIdx: 0,
      };
      const forced = mkItem({
        id: 421, type: 'loop', intervalMs: 60_000, nextFireAt: 0, forceStart: true,
      });
      expect(pickNext([inFlight, forced], 1000, true, true)?.id).toBe(420);
    });

    it('a disabled item is never fired, even with forceStart set', () => {
      const it = mkItem({
        id: 430, type: 'loop', intervalMs: 60_000, nextFireAt: 0,
        disabled: true, forceStart: true,
      });
      expect(pickNext([it], 1000, true, true)).toBeNull();
    });

    it('advanceAfterFire clears forceStart when a no-chain force loop reschedules', () => {
      const it = mkItem({ id: 440, type: 'loop', intervalMs: 60_000, forceStart: true });
      const r = advanceAfterFire(it, 1000);
      expect(r.action).toBe('reschedule');
      if (r.action === 'reschedule') {
        expect('forceStart' in r.patch).toBe(true); // explicitly cleared
        expect(r.patch.forceStart).toBeUndefined();
      }
    });

    it('advanceAfterFire clears forceStart on the first continue of a force-started chain', () => {
      const it = mkItem({
        id: 441, type: 'loop', intervalMs: 60_000,
        beforeChain: [step(1, 'a'), step(2, 'b')],
        forceStart: true,
      });
      const r = advanceAfterFire(it, 1000);
      expect(r.action).toBe('continue');
      if (r.action === 'continue') {
        expect('forceStart' in r.patch).toBe(true);
        expect(r.patch.forceStart).toBeUndefined();
      }
    });
  });
});

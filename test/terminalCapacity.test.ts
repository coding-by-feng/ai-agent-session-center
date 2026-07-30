// test/terminalCapacity.test.ts — capacity accounting for the terminal budget.
//
// Regression cover for the "Terminal limit reached (max 50)" report: the cap
// counted every PTY, and a session created with the "Commands Terminal"
// checkbox spawns TWO (agent shell + ops shell). The ceiling therefore fired at
// ~25 real sessions while telling the user the limit was 50.
import { describe, it, expect } from 'vitest';
import {
  checkTerminalCapacity,
  countSessionTerminals,
  MAX_SESSIONS,
  MAX_TERMINALS,
  type CapacityTerminal,
} from '../server/terminalCapacity.js';

const make = (count: number, isOps = false): CapacityTerminal[] =>
  Array.from({ length: count }, () => ({ isOps }));

describe('countSessionTerminals', () => {
  it('excludes ops terminals from the session count', () => {
    const terminals = [...make(25), ...make(26, true)];
    expect(terminals.length).toBe(51);
    expect(countSessionTerminals(terminals)).toBe(25);
  });

  it('treats a terminal with no isOps flag as a session terminal', () => {
    expect(countSessionTerminals([{}, {}, { isOps: false }])).toBe(3);
  });
});

describe('checkTerminalCapacity — session budget', () => {
  it('admits a new session when ops shells push the PTY count past MAX_SESSIONS', () => {
    // The exact live state that produced the bug report: 51 PTYs, 25 sessions.
    const terminals = [...make(25), ...make(26, true)];
    expect(checkTerminalCapacity(terminals, { sessions: 1, ops: 1 })).toEqual({ ok: true });
  });

  it('rejects once MAX_SESSIONS session terminals exist', () => {
    const verdict = checkTerminalCapacity(make(MAX_SESSIONS), { sessions: 1 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error).toContain('Session limit reached');
      expect(verdict.error).toContain(String(MAX_SESSIONS));
    }
  });

  it('admits the session that exactly fills the budget', () => {
    expect(checkTerminalCapacity(make(MAX_SESSIONS - 1), { sessions: 1 })).toEqual({ ok: true });
  });

  it('does not charge session budget for an ops-only request', () => {
    expect(checkTerminalCapacity(make(MAX_SESSIONS), { sessions: 0, ops: 1 })).toEqual({ ok: true });
  });
});

describe('checkTerminalCapacity — PTY backstop', () => {
  it('reserves every PTY it is about to spawn, so the cap cannot be overshot', () => {
    // One slot left, but the request needs two (agent + ops) → reject.
    const verdict = checkTerminalCapacity(make(MAX_TERMINALS - 1, true), { sessions: 1, ops: 1 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain('Terminal limit reached');
  });

  it('admits a single-PTY request that exactly fills the backstop', () => {
    expect(checkTerminalCapacity(make(MAX_TERMINALS - 1, true), { sessions: 1, ops: 0 })).toEqual({ ok: true });
  });

  it('keeps the backstop above the session budget so sessions bind first', () => {
    expect(MAX_TERMINALS).toBeGreaterThanOrEqual(MAX_SESSIONS * 2);
  });
});

describe('checkTerminalCapacity — defaults', () => {
  it('defaults to a single session terminal when no request is given', () => {
    expect(checkTerminalCapacity(make(MAX_SESSIONS)).ok).toBe(false);
    expect(checkTerminalCapacity(make(MAX_SESSIONS - 1)).ok).toBe(true);
  });
});

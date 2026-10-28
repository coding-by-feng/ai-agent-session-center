// test/sessionMemory.test.ts — memory per session (server/sessionMemory.ts). Pure: no real `ps`.
import { describe, expect, it, vi } from 'vitest';
import { buildSample, createSessionMemory, parsePs, treeBytes, SAMPLE_TTL_MS } from '../server/sessionMemory.js';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

// server 100 → renderer 101; terminal shell 200 → claude 201 → mcp 202; shell 300 → codex 301; ops shell 400
const PS = `
  100     1  200000
  101   100  100000
  200   100    1000
  201   200  250000
  202   201   50000
  300   100    1000
  301   300  280000
  400   100    2000
  junk line
`;

describe('parsePs / treeBytes', () => {
  const rows = parsePs(PS);
  it('skips lines that are not three numbers', () => {
    expect(rows).toHaveLength(8);
  });
  it('sums a process and all its descendants, in bytes', () => {
    expect(treeBytes(rows, 200)).toBe((1000 + 250000 + 50000) * 1024);
  });
  it('is 0 for a pid that is not running', () => {
    expect(treeBytes(rows, 999)).toBe(0);
  });
});

describe('buildSample', () => {
  const rows = parsePs(PS);
  const terminals = [
    { terminalId: 't-a', pid: 200 },
    { terminalId: 't-b', pid: 300 },
    { terminalId: 'ops-a', pid: 400 },
  ];
  it('adds each session’s agent and ops terminals, and splits the total into AASC and sessions', () => {
    const s = buildSample(rows, 100, terminals, [
      { sessionId: 'a', terminalId: 't-a', opsTerminalId: 'ops-a' },
      { sessionId: 'b', terminalId: 't-b' },
      { sessionId: 'c', terminalId: null, asleepAt: 5 },
    ], 1);
    expect(s.bySession).toEqual({ a: (301000 + 2000) * 1024, b: 281000 * 1024 });
    expect(s.totalBytes).toBe(884000 * 1024);
    expect(s.appBytes).toBe(300000 * 1024);
    expect(s.asleep).toBe(1);
    expect(s.bySession.c).toBeUndefined();
  });
});

describe('createSessionMemory', () => {
  it('reuses a sample for SAMPLE_TTL_MS and reads again after', async () => {
    let t = 0;
    const readProcs = vi.fn(async () => parsePs(PS));
    const mem = createSessionMemory({ terminals: () => [], sessions: () => [], serverPid: 100, readProcs, now: () => t });
    await mem.sample();
    t = SAMPLE_TTL_MS - 1;
    await mem.sample();
    expect(readProcs).toHaveBeenCalledTimes(1);
    t = SAMPLE_TTL_MS + 1;
    await mem.sample();
    expect(readProcs).toHaveBeenCalledTimes(2);
  });

  it('shares one reading between concurrent askers', async () => {
    const readProcs = vi.fn(async () => parsePs(PS));
    const mem = createSessionMemory({ terminals: () => [], sessions: () => [], serverPid: 100, readProcs, now: () => 0 });
    await Promise.all([mem.sample(), mem.sample(), mem.sample()]);
    expect(readProcs).toHaveBeenCalledTimes(1);
  });
});

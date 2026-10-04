import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync, symlinkSync, statSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import log from '../server/logger.js';
import {
  USAGE_DIR,
  CLAUDE_SNAPSHOT_MAX_AGE_MS,
  CODEX_MAX_DAY_DIRS,
  createClaudeSnapshotSource,
  createCodexRolloutSource,
} from '../server/planUsageSources.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'aasc-usage-src-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const setMtime = (path: string, ms: number): void => {
  const t = new Date(ms);
  utimesSync(path, t, t);
};

describe('USAGE_DIR', () => {
  it('lives in the hook queue directory', () => {
    if (process.platform === 'win32') return;
    expect(USAGE_DIR).toBe('/tmp/claude-session-center/usage');
  });
});

// ---------------------------------------------------------------------------
// Claude snapshots
// ---------------------------------------------------------------------------

const NOW = 1_791_500_000_000;
const snap = (pct: number, ts = NOW): string => JSON.stringify({
  session_id: 'x',
  ts,
  rate_limits: { five_hour: { used_percentage: pct, resets_at: 1_791_514_800 } },
});

describe('createClaudeSnapshotSource', () => {
  let dir: string;
  beforeEach(() => { dir = join(root, 'usage'); mkdirSync(dir); chmodSync(dir, 0o700); }); // what the status-line script makes
  const put = (name: string, body: string, mtime = NOW): string => {
    const p = join(dir, name);
    writeFileSync(p, body);
    setMtime(p, mtime);
    return p;
  };

  it('is empty when the directory does not exist yet', async () => {
    expect(await createClaudeSnapshotSource(join(root, 'nope')).read(NOW)).toEqual([]);
  });

  it('reads one observation per snapshot', async () => {
    put('aaa.json', snap(10));
    put('bbb.json', snap(20));
    const got = await createClaudeSnapshotSource(dir).read(NOW);
    expect(got.map((u) => u.windows[0].usedPercent).sort()).toEqual([10, 20]);
    expect(got.every((u) => u.cli === 'claude')).toBe(true);
  });

  it('skips what is not a finished snapshot: temp files, other names, bad JSON, no limits, oversize', async () => {
    put('.abc.123.tmp', snap(10));
    put('notes.txt', snap(10));
    put('bad name!.json', snap(10));
    put('garbage.json', '{nope');
    put('empty.json', JSON.stringify({ ts: NOW, rate_limits: {} }));
    put('huge.json', snap(10) + ' '.repeat(70 * 1024));
    put('good.json', snap(33));
    const got = await createClaudeSnapshotSource(dir).read(NOW);
    expect(got.map((u) => u.windows[0].usedPercent)).toEqual([33]);
  });

  it('does not follow a symlink out of the directory', async () => {
    const outside = join(root, 'outside.json');
    writeFileSync(outside, snap(77));
    setMtime(outside, NOW - 1000); // fresh, so only the symlink rule can keep it out
    symlinkSync(outside, join(dir, 'link.json'));
    expect(await createClaudeSnapshotSource(dir).read(NOW)).toEqual([]);
  });

  describe.skipIf(process.platform === 'win32')('a usage directory it cannot trust', () => {
    it('reads nothing from — and deletes nothing through — a symlinked directory', async () => {
      // /tmp/claude-session-center is shared ground: if something plants `usage` as a link into someone's
      // project, the sweep of old snapshots must not become a way to delete files there.
      const victim = join(root, 'victim-project');
      mkdirSync(victim);
      chmodSync(victim, 0o700);
      const precious = join(victim, 'package.json'); // matches the snapshot name filter, and is old
      writeFileSync(precious, '{"name":"victim"}');
      setMtime(precious, NOW - CLAUDE_SNAPSHOT_MAX_AGE_MS - 1000);
      const looksReal = join(victim, 'abc.json');
      writeFileSync(looksReal, snap(33));
      setMtime(looksReal, NOW - 1000);
      const link = join(root, 'usage-link');
      symlinkSync(victim, link);
      expect(await createClaudeSnapshotSource(link).read(NOW)).toEqual([]);
      expect(existsSync(precious)).toBe(true);
    });

    it('refuses a directory that others can write to, and trusts one that is merely readable', async () => {
      put('good.json', snap(33));
      const source = createClaudeSnapshotSource(dir);
      for (const mode of [0o770, 0o707, 0o777, 0o722]) {
        chmodSync(dir, mode);
        expect(await source.read(NOW), mode.toString(8)).toEqual([]);
      }
      for (const mode of [0o700, 0o750, 0o755]) {
        chmodSync(dir, mode);
        expect((await source.read(NOW)).length, mode.toString(8)).toBe(1);
      }
    });

    it('deletes nothing from a directory it refused', async () => {
      const stale = put('old.json', snap(10), NOW - CLAUDE_SNAPSHOT_MAX_AGE_MS - 1000);
      chmodSync(dir, 0o777);
      await createClaudeSnapshotSource(dir).read(NOW);
      expect(existsSync(stale)).toBe(true);
    });

    it('refuses something that is not a directory', async () => {
      const file = join(root, 'usage-file');
      writeFileSync(file, 'not a directory');
      expect(await createClaudeSnapshotSource(file).read(NOW)).toEqual([]);
    });

    it('refuses a directory owned by someone else', async () => {
      put('good.json', snap(33));
      const uid = process.getuid!();
      const spy = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
      try {
        expect(await createClaudeSnapshotSource(dir).read(NOW)).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it('ignores — and does not sweep — a file owned by someone else inside a directory that is ours', async () => {
      // The directory check and the per-file check are separate: this passes the first and fails the second.
      const stale = put('old.json', snap(10), NOW - CLAUDE_SNAPSHOT_MAX_AGE_MS - 1000);
      put('other.json', snap(20));
      const uid = process.getuid!();
      const spy = vi.spyOn(process, 'getuid').mockReturnValueOnce(uid).mockReturnValue(uid + 1);
      try {
        expect(await createClaudeSnapshotSource(dir).read(NOW)).toEqual([]);
        expect(existsSync(stale)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('says nothing about a directory that is simply not there yet', async () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      try {
        expect(await createClaudeSnapshotSource(join(root, 'not-yet')).read(NOW)).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('says why it refused — once, not on every poll', async () => {
      chmodSync(dir, 0o777);
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      try {
        const source = createClaudeSnapshotSource(dir);
        await source.read(NOW);
        await source.read(NOW);
        await source.read(NOW);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][1])).toContain('writable by other users');
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('re-reads a file only when its mtime or size changes', async () => {
    const p = put('s.json', snap(11));
    const source = createClaudeSnapshotSource(dir);
    expect((await source.read(NOW))[0].windows[0].usedPercent).toBe(11);

    // Same size, same mtime, different content: only a cache could still say 11.
    writeFileSync(p, snap(22));
    setMtime(p, NOW);
    expect((await source.read(NOW))[0].windows[0].usedPercent).toBe(11);

    setMtime(p, NOW + 5_000);
    expect((await source.read(NOW))[0].windows[0].usedPercent).toBe(22);
  });

  it('notices a changed size even when the mtime did not move', async () => {
    const p = put('s.json', snap(11));
    const source = createClaudeSnapshotSource(dir);
    expect((await source.read(NOW))[0].windows[0].usedPercent).toBe(11);
    writeFileSync(p, snap(22) + '\n');
    setMtime(p, NOW);
    expect((await source.read(NOW))[0].windows[0].usedPercent).toBe(22);
  });

  it('forgets a snapshot that is deleted', async () => {
    const p = put('s.json', snap(11));
    const source = createClaudeSnapshotSource(dir);
    expect(await source.read(NOW)).toHaveLength(1);
    rmSync(p);
    expect(await source.read(NOW)).toEqual([]);
  });

  it('sweeps snapshots older than the maximum age, and only those', async () => {
    const stale = put('old.json', snap(10), NOW - CLAUDE_SNAPSHOT_MAX_AGE_MS - 1000);
    const fresh = put('new.json', snap(20), NOW - 1000);
    const foreign = put('keep-me.txt', 'not ours', NOW - CLAUDE_SNAPSHOT_MAX_AGE_MS - 1000);
    const got = await createClaudeSnapshotSource(dir).read(NOW);
    expect(got.map((u) => u.windows[0].usedPercent)).toEqual([20]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Codex rollouts
// ---------------------------------------------------------------------------

const RESETS_S = 1_791_581_013;
const tokenCount = (pct: number, iso: string | null = '2026-10-03T21:40:04.507Z'): string => JSON.stringify({
  ...(iso ? { timestamp: iso } : {}),
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: null,
    rate_limits: {
      primary: { used_percent: pct, window_minutes: 10080, resets_at: RESETS_S },
      secondary: null,
      plan_type: 'prolite',
      rate_limit_reached_type: null,
    },
  },
});
const filler = (kb: number): string[] => Array.from({ length: Math.ceil(kb / 10) }, () => JSON.stringify({
  type: 'response_item',
  payload: { type: 'function_call_output', output: 'x'.repeat(10 * 1024) },
}));

describe('createCodexRolloutSource', () => {
  const rollout = (day: string, name: string, lines: string[], mtime: number): string => {
    const [y, m, d] = day.split('-');
    const dir = join(root, 'sessions', y, m, d);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, lines.join('\n') + '\n');
    setMtime(p, mtime);
    return p;
  };
  const pcts = (got: Array<{ windows: Array<{ usedPercent: number }> }>): number[] =>
    got.map((u) => u.windows[0].usedPercent).sort((a, b) => a - b);

  it('is empty when Codex has no sessions directory', async () => {
    expect(await createCodexRolloutSource(root).read()).toEqual([]);
  });

  it('reads the newest limits in a rollout, with the plan and the event’s own time', async () => {
    rollout('2026-10-03', 'rollout-2026-10-03T21-00-00-aaaa.jsonl', [
      tokenCount(20, '2026-10-03T21:00:00.000Z'),
      '{"type":"event_msg","payload":{"type":"agent_message"}}',
      tokenCount(26, '2026-10-03T21:40:04.507Z'),
    ], NOW);
    const [usage] = await createCodexRolloutSource(root).read();
    expect(usage).toEqual({
      cli: 'codex',
      plan: 'prolite',
      windows: [{ minutes: 10080, usedPercent: 26, resetsAt: RESETS_S * 1000 }],
      asOf: Date.parse('2026-10-03T21:40:04.507Z'),
    });
  });

  it('dates an event that carries no time by the file’s mtime', async () => {
    rollout('2026-10-03', 'rollout-a.jsonl', [tokenCount(5, null)], NOW);
    expect((await createCodexRolloutSource(root).read())[0].asOf).toBe(NOW);
  });

  it('reads the few most recently WRITTEN rollouts, not the most recently named', async () => {
    // Nine rollouts; the one written LAST sits in the OLDEST day folder (a resumed session appends to its old file).
    for (let i = 0; i < 8; i++) {
      rollout('2026-10-03', `rollout-2026-10-03T0${i}-x${i}.jsonl`, [tokenCount(10 + i)], NOW - (8 - i) * 60_000);
    }
    rollout('2026-10-01', 'rollout-2026-10-01T00-old.jsonl', [tokenCount(99)], NOW);
    const got = pcts(await createCodexRolloutSource(root).read());
    expect(got).toHaveLength(6);
    expect(got).toContain(99);
    expect(got).not.toContain(10); // the two least recently written are left out
    expect(got).not.toContain(11);
  });

  it('finds a rollout that is still being written in an OLD day folder — a long-lived session keeps appending to the file of the day it began', async () => {
    rollout('2026-09-22', 'rollout-old.jsonl', [tokenCount(63)], NOW); // the newest write, in the oldest folder
    for (let day = 1; day <= 9; day++) {
      rollout(`2026-10-0${day}`, `rollout-d${day}.jsonl`, [tokenCount(day)], NOW - 100_000 - day * 1000);
    }
    const got = pcts(await createCodexRolloutSource(root).read());
    expect(got).toContain(63);
    expect(got).toHaveLength(6); // still only the six most recently written are read
  });

  it('caps how many day folders it walks, newest first', async () => {
    rollout('2026-09-22', 'rollout-old.jsonl', [tokenCount(63)], NOW);
    for (let day = 1; day <= 3; day++) rollout(`2026-10-0${day}`, `rollout-d${day}.jsonl`, [tokenCount(day)], NOW - 100_000 - day * 1000);
    expect(pcts(await createCodexRolloutSource(root, { maxDayDirs: 3 }).read())).toEqual([1, 2, 3]);
    expect(pcts(await createCodexRolloutSource(root, { maxDayDirs: 4 }).read())).toEqual([1, 2, 3, 63]);
  });

  it('by default walks a year of folders, and no more', async () => {
    expect(CODEX_MAX_DAY_DIRS).toBe(366);
    const folder = (daysAgo: number): string => new Date(Date.UTC(2026, 9, 4) - daysAgo * 86_400_000).toISOString().slice(0, 10);
    for (let ago = 0; ago <= CODEX_MAX_DAY_DIRS; ago++) {
      // the oldest folder (the 367th) holds the most recently written file
      rollout(folder(ago), `rollout-${ago}.jsonl`, [tokenCount(ago === CODEX_MAX_DAY_DIRS ? 99 : 1)], ago === CODEX_MAX_DAY_DIRS ? NOW : NOW - 1_000_000 - ago * 1000);
    }
    expect(pcts(await createCodexRolloutSource(root).read())).not.toContain(99);
    expect(pcts(await createCodexRolloutSource(root, { maxDayDirs: CODEX_MAX_DAY_DIRS + 1 }).read())).toContain(99);
  });

  it('ignores other files and non-date folders', async () => {
    rollout('2026-10-03', 'notes.jsonl', [tokenCount(1)], NOW);
    rollout('2026-10-03', 'rollout-x.txt', [tokenCount(2)], NOW);
    mkdirSync(join(root, 'sessions', 'misc', '10', '03'), { recursive: true });
    writeFileSync(join(root, 'sessions', 'misc', '10', '03', 'rollout-m.jsonl'), tokenCount(3));
    rollout('2026-10-03', 'rollout-ok.jsonl', [tokenCount(4)], NOW);
    expect(pcts(await createCodexRolloutSource(root).read())).toEqual([4]);
  });

  it('digs further back when the newest limits sit behind a lot of output', async () => {
    rollout('2026-10-03', 'rollout-big.jsonl', [tokenCount(41), ...filler(400)], NOW);
    expect(pcts(await createCodexRolloutSource(root).read())).toEqual([41]);
  });

  it('gives up on a rollout with no limits inside its tail, and does not retry it until it changes', async () => {
    const p = rollout('2026-10-03', 'rollout-none.jsonl', [...filler(300)], NOW);
    const source = createCodexRolloutSource(root);
    expect(await source.read()).toEqual([]);
    // Same size and mtime, but now it HAS a line: only a cached "nothing" would still say nothing.
    const body = readFileSync(p, 'utf8');
    writeFileSync(p, tokenCount(7).padEnd(body.length, ' '));
    setMtime(p, NOW);
    expect(statSync(p).size).toBe(body.length);
    expect(await source.read()).toEqual([]);
    setMtime(p, NOW + 1000);
    expect(pcts(await source.read())).toEqual([7]);
  });

  it('defaults to $CODEX_HOME', async () => {
    rollout('2026-10-03', 'rollout-home.jsonl', [tokenCount(12)], NOW);
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      expect(pcts(await createCodexRolloutSource().read())).toEqual([12]);
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved;
    }
  });

  it('re-reads a rollout only when it has changed', async () => {
    const p = rollout('2026-10-03', 'rollout-c.jsonl', [tokenCount(11)], NOW);
    const source = createCodexRolloutSource(root);
    expect(pcts(await source.read())).toEqual([11]);
    const size = statSync(p).size;
    writeFileSync(p, tokenCount(22).padEnd(size - 1, ' ') + '\n');
    setMtime(p, NOW);
    expect(pcts(await source.read())).toEqual([11]);
    setMtime(p, NOW + 1000);
    expect(pcts(await source.read())).toEqual([22]);
  });
});

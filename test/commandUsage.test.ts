// test/commandUsage.test.ts — how often each /command or skill appears in your prompts
// (Oct 21 2026). Counted on the Mac from the prompt history: once per prompt, anywhere in
// it (a trailing "/raab" counts), never a path; the last 90 days; a remote device counts
// only the sessions it can see, as the history rule has it. The reader is a fake here.
import { describe, it, expect, vi } from 'vitest';
import { countCommandTokens, createCommandUsage, usageForEntries, usageScope, USAGE_WINDOW_MS, USAGE_CACHE_MS } from '../server/commandUsage.js';

describe('countCommandTokens', () => {
  it('counts each token once per prompt, wherever it sits', () => {
    const counts = countCommandTokens([
      '/update-feature-docs',
      'fix the drag effect /raab',
      'first /rar then /rar again',
      '/compact\nthen carry on',
      'use $krt-work here',
    ]);
    expect(Object.fromEntries(counts)).toEqual({
      '/update-feature-docs': 1, '/raab': 1, '/rar': 1, '/compact': 1, '$krt-work': 1,
    });
  });

  it('never counts a path, a URL or a word glued to the slash', () => {
    const counts = countCommandTokens([
      '/tmp/claude-queue-images/queue-img-1.jpg',
      'see https://example.com/raab and src/raab',
      'and/or either',
    ]);
    expect(counts.size).toBe(0);
  });

  it('takes a token in quotes or backticks, or followed by a colon', () => {
    const counts = countCommandTokens(['run `/review` now', 'type "/simplify" then', 'try /krt-work: it picks one']);
    expect(Object.fromEntries(counts)).toEqual({ '/review': 1, '/simplify': 1, '/krt-work': 1 });
  });

  it('stays linear on a long run of dots or colons (a pasted log), so it never stalls the server', () => {
    const texts = [` /a${'.'.repeat(60_000)}x`, ` /a${':'.repeat(60_000)}x`, ` /a${'.b'.repeat(30_000)}!x`];
    const started = performance.now();
    countCommandTokens(texts);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('takes a token ending a sentence or in brackets, and keeps plugin names whole', () => {
    const counts = countCommandTokens(['run /review.', 'then (/simplify)', 'and /commit-commands:commit, done']);
    expect(Object.fromEntries(counts)).toEqual({ '/review': 1, '/simplify': 1, '/commit-commands:commit': 1 });
  });

  it("takes Codex's skill mention link, which is how its composer records a picked $skill", () => {
    const counts = countCommandTokens([
      'fix the timeline [$raab](/Users/me/.codex/skills/raab/SKILL.md)',
      '[$rar](/Users/me/.codex/skills/rar/SKILL.md) and [$rar](/Users/me/.codex/skills/rar/SKILL.md)',
    ]);
    expect(Object.fromEntries(counts)).toEqual({ '$raab': 1, '$rar': 1 });
  });
});

describe('usageForEntries', () => {
  it('keeps only the counts that name a listed command or skill', () => {
    const counts = new Map([['/raab', 5], ['/tmp', 9], ['$HOME', 3], ['/commit-commands:commit', 2], ['$krt-work', 4]]);
    const entries = [
      { name: 'raab' }, { name: 'commit', pluginName: 'commit-commands' }, { name: 'krt-work' },
    ];
    expect(usageForEntries(counts, entries)).toEqual({ '/raab': 5, '/commit-commands:commit': 2, '$krt-work': 4 });
  });
});

describe('usageScope', () => {
  it('is every session for the Mac, and only the shared ones for another device', () => {
    const sessions = { a: { remoteVisible: true }, b: { remoteVisible: false }, c: {} };
    expect(usageScope(true, sessions)).toBeNull();
    expect(usageScope(false, sessions)).toEqual(['a']);
  });
});

describe('createCommandUsage', () => {
  const NOW = 1_800_000_000_000;

  it('reads the last 90 days, for every session on the Mac and only the visible ones for a device', () => {
    const read = vi.fn((_since: number, ids: string[] | null) => (ids ? ['/rar'] : ['/raab', '/raab x', '/rar']));
    const usage = createCommandUsage(read, () => NOW);
    expect(Object.fromEntries(usage.counts(null))).toEqual({ '/raab': 2, '/rar': 1 });
    expect(read).toHaveBeenLastCalledWith(NOW - USAGE_WINDOW_MS, null);
    expect(Object.fromEntries(usage.counts(['s2', 's1']))).toEqual({ '/rar': 1 });
    expect(read).toHaveBeenLastCalledWith(NOW - USAGE_WINDOW_MS, ['s1', 's2']);
  });

  it('a device that can see nothing gets nothing, without reading', () => {
    const read = vi.fn(() => ['/raab']);
    const usage = createCommandUsage(read, () => NOW);
    expect(usage.counts([]).size).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps a count for a minute per scope, then reads again', () => {
    let now = NOW;
    const read = vi.fn(() => ['/raab']);
    const usage = createCommandUsage(read, () => now);
    usage.counts(null);
    usage.counts(null);
    usage.counts(['s1']);
    expect(read).toHaveBeenCalledTimes(2);
    now += USAGE_CACHE_MS + 1;
    usage.counts(null);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('a failed read counts nothing and is not kept', () => {
    const read = vi.fn().mockImplementationOnce(() => { throw new Error('locked'); }).mockReturnValue(['/raab']);
    const usage = createCommandUsage(read, () => NOW);
    expect(usage.counts(null).size).toBe(0);
    expect(usage.counts(null).get('/raab')).toBe(1);
  });
});

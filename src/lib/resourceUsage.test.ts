// resourceUsage.test.ts — the Library's use counts (Oct 23 2026): which types get one,
// how a count reads, and the "Most used" order.
import { describe, it, expect } from 'vitest';
import type { ResourceSummary, ResourceUsage } from '@/types/resources';
import { isUsageCounted, readResourceSort, sortByUses, totalUses, usageFacts, usesLabel } from './resourceUsage';

const NOW = 1_800_000_000_000;

function r(id: string, over: Partial<ResourceSummary> = {}): ResourceSummary {
  return {
    id, name: id, type: 'skill', agent: 'claude', scope: 'global', origin: 'user', format: 'markdown',
    path: `~/.claude/skills/${id}`, fileCount: 1, bytes: 1, mtimeMs: 0, repo: { status: 'not-tracked' },
    variantIds: [], findingCodes: [], ...over,
  };
}

const u = (typed: number, agent: number, lastAt = NOW, tokens = ['/x']): ResourceUsage => ({ typed, agent, lastAt, tokens });

describe('isUsageCounted', () => {
  it('counts skills and commands only: nothing invokes a rule or memory', () => {
    expect(isUsageCounted('skill')).toBe(true);
    expect(isUsageCounted('command')).toBe(true);
    for (const type of ['rule', 'instructions', 'memory', 'agent', 'hook', 'mcp', 'plugin', 'settings'] as const) {
      expect(isUsageCounted(type)).toBe(false);
    }
  });
});

describe('usesLabel / totalUses', () => {
  it('says 1 use, 17 uses, and adds typed and agent uses', () => {
    expect(usesLabel(1)).toBe('1 use');
    expect(usesLabel(17)).toBe('17 uses');
    expect(usesLabel(1234)).toBe('1,234 uses');
    expect(totalUses(u(12, 5))).toBe(17);
    expect(totalUses(undefined)).toBe(0);
  });
});

describe('usageFacts', () => {
  it('splits a Claude skill into typed and agent uses, with when it was last used', () => {
    expect(usageFacts(r('tdd'), u(12, 5, NOW - 2 * 3_600_000, ['/tdd']), 90, NOW)).toEqual({
      headline: 'Used 17× in the last 90 days',
      parts: ['12 typed by you', '5 by the agent', 'last used 2h ago'],
      note: 'Counted as /tdd',
    });
  });

  it('says when the same name is counted for another resource too', () => {
    expect(usageFacts(r('extract-features'), { ...u(4, 0, NOW, ['/extract-features']), sharedWith: 1 }, 90, NOW).note)
      .toBe('Counted as /extract-features · also counted for 1 other resource of that name');
  });

  it('leaves out a zero half', () => {
    expect(usageFacts(r('tdd'), u(0, 40, NOW), 90, NOW).parts).toEqual(['40 by the agent', 'last used just now']);
  });

  it('says a Codex skill counts typed uses only', () => {
    expect(usageFacts(r('tdd', { agent: 'codex' }), u(3, 0, NOW, ['$tdd']), 90, NOW)).toEqual({
      headline: 'Used 3× in the last 90 days',
      parts: ['3 typed by you', 'last used just now'],
      note: 'Counted as $tdd · Codex keeps no record of a skill it runs on its own, so only typed uses count',
    });
  });

  it('says so when it was not used', () => {
    expect(usageFacts(r('tdd'), undefined, 90, NOW)).toEqual({ headline: 'Not used in the last 90 days', parts: [] });
  });
});

describe('sortByUses', () => {
  it('puts the most used first, the latest use breaking a tie, and keeps the rest in their order', () => {
    const list = [r('a'), r('b'), r('c'), r('d'), r('e')];
    const usage = new Map([
      ['b', u(1, 1, 10)],
      ['c', u(5, 0, 10)],
      ['d', u(2, 0, 50)],
    ]);
    expect(sortByUses(list, usage).map((x) => x.id)).toEqual(['c', 'd', 'b', 'a', 'e']);
    expect(list.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('readResourceSort', () => {
  it('reads "uses" from the URL and anything else as name order', () => {
    expect(readResourceSort(new URLSearchParams('sort=uses'))).toBe('uses');
    expect(readResourceSort(new URLSearchParams('sort=bogus'))).toBe('name');
    expect(readResourceSort(new URLSearchParams(''))).toBe('name');
  });
});

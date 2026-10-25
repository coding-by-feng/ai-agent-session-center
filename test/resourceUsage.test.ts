// test/resourceUsage.test.ts — how often each skill and command in the RESOURCES Library was
// used (Oct 23 2026): prompts that typed it, plus Claude's own Skill tool calls, minus a call
// for a prompt that already typed that skill. Rules and the rest are never counted: nothing
// invokes them. The readers are fakes here; the database is never opened.
import { describe, it, expect, vi } from 'vitest';
import {
  countTokenUses,
  createResourceUsage,
  resourceTokens,
  skillOfCall,
  usageById,
} from '../server/resourceUsage.js';
import { USAGE_CACHE_MS, USAGE_WINDOW_MS } from '../server/commandUsage.js';
import type { ResourceSummary } from '../src/types/resources.js';

function res(over: Partial<ResourceSummary> & Pick<ResourceSummary, 'id' | 'name'>): ResourceSummary {
  return {
    type: 'skill',
    agent: 'claude',
    scope: 'global',
    origin: 'user',
    format: 'markdown',
    path: `~/.claude/skills/${over.name}`,
    fileCount: 1,
    bytes: 1,
    mtimeMs: 0,
    repo: { status: 'not-tracked' },
    variantIds: [],
    findingCodes: [],
    ...over,
  };
}

describe('skillOfCall', () => {
  it("reads the skill name from a Skill call's stored input, even cut off at 100 characters", () => {
    expect(skillOfCall('{"skill":"rar","args":"for the first two images, optimize the css and style of this')).toBe('rar');
    expect(skillOfCall('{"skill":"superpowers:brainstorming"}')).toBe('superpowers:brainstorming');
  });

  it('answers null for anything that is not a skill name', () => {
    expect(skillOfCall('')).toBeNull();
    expect(skillOfCall('{"command":"ls"}')).toBeNull();
    expect(skillOfCall('{"skill":"../../etc"}')).toBeNull();
    expect(skillOfCall('{"skill":""}')).toBeNull();
  });
});

describe('countTokenUses', () => {
  it('counts a prompt once per token and keeps the latest time', () => {
    const counts = countTokenUses(
      [
        { timestamp: 10, text: 'fix it /rar' },
        { timestamp: 30, text: '/rar then /rar' },
        { timestamp: 20, text: '[$rar](/Users/me/.codex/skills/rar/SKILL.md)' },
      ],
      [],
    );
    expect(counts.get('/rar')).toEqual({ typed: 2, agent: 0, lastAt: 30 });
    expect(counts.get('$rar')).toEqual({ typed: 1, agent: 0, lastAt: 20 });
  });

  const call = (timestamp: number, skill: string, prompt: string | null, promptAt: number | null = prompt ? 100 : null, sessionId = 's1') =>
    ({ sessionId, timestamp, input: `{"skill":"${skill}","args":"x"}`, promptAt, prompt });

  it("counts the agent's own Skill calls under the Claude token", () => {
    const counts = countTokenUses([], [call(5, 'frontend-ui-polish', 'polish the tab'), call(9, 'frontend-ui-polish', null)]);
    expect(counts.get('/frontend-ui-polish')).toEqual({ typed: 0, agent: 2, lastAt: 9 });
  });

  it('does not count a call again when the prompt it answers typed that skill', () => {
    const typed = 'can we count the uses /rar';
    const counts = countTokenUses(
      [{ timestamp: 100, text: typed }],
      [
        // The typed /rar, run by the model: already counted as typed.
        call(101, 'rar', typed),
        // The skill /rar chained into: a use of its own.
        call(102, 'retouch-ascii-review', typed),
      ],
    );
    expect(counts.get('/rar')).toEqual({ typed: 1, agent: 0, lastAt: 100 });
    expect(counts.get('/retouch-ascii-review')).toEqual({ typed: 0, agent: 1, lastAt: 102 });
  });

  it("absorbs only the first call per typed prompt: a loop's later turns and re-runs count", () => {
    const typed = '/loop 10m /rar';
    const counts = countTokenUses(
      [{ timestamp: 100, text: typed }],
      [call(101, 'rar', typed), call(700, 'rar', typed), call(1300, 'rar', typed)],
    );
    expect(counts.get('/rar')).toEqual({ typed: 1, agent: 2, lastAt: 1300 });
  });

  it('absorbs per session and per prompt, never across them', () => {
    const counts = countTokenUses(
      [{ timestamp: 100, text: 'go /rar' }, { timestamp: 100, text: 'go /rar' }],
      [call(101, 'rar', 'go /rar', 100, 's1'), call(102, 'rar', 'go /rar', 100, 's2')],
    );
    // Each session's typed prompt absorbs its own call; an absorbed call is that same use.
    expect(counts.get('/rar')).toEqual({ typed: 2, agent: 0, lastAt: 100 });
  });

  it('treats a plugin skill typed without its plugin name as the same use', () => {
    const counts = countTokenUses(
      [{ timestamp: 1, text: '/brainstorming a new tab' }],
      [call(2, 'superpowers:brainstorming', '/brainstorming a new tab', 1)],
    );
    expect(counts.get('/superpowers:brainstorming')).toBeUndefined();
    expect(counts.get('/brainstorming')).toEqual({ typed: 1, agent: 0, lastAt: 1 });
  });

  it('skips a call it cannot read', () => {
    expect(countTokenUses([], [{ sessionId: 's1', timestamp: 1, input: 'not json', promptAt: null, prompt: null }]).size).toBe(0);
  });
});

describe('resourceTokens', () => {
  it('names each skill or command the way its agent is told to use it', () => {
    expect(resourceTokens(res({ id: 'a', name: 'rar' }))).toEqual(['/rar']);
    expect(resourceTokens(res({ id: 'b', name: 'rar', agent: 'codex' }))).toEqual(['$rar']);
    expect(resourceTokens(res({ id: 'c', name: 'tidy', agent: 'codex', type: 'command' }))).toEqual(['/prompts:tidy']);
    expect(resourceTokens(res({ id: 'd', name: 'commit', type: 'command', origin: 'plugin', pluginName: 'commit-commands' })))
      .toEqual(['/commit-commands:commit', '/commit']);
    expect(resourceTokens(res({ id: 'e', name: 'krt-work', agent: 'shared' }))).toEqual(['/krt-work', '$krt-work']);
    // A command in a subfolder: catalogued ns:deploy, called /deploy by Claude Code today.
    expect(resourceTokens(res({ id: 'f', name: 'ns:deploy', type: 'command' }))).toEqual(['/ns:deploy', '/deploy']);
  });

  it('never counts a rule, instructions, memory, agent, hook or config', () => {
    for (const type of ['rule', 'instructions', 'memory', 'agent', 'hook', 'mcp', 'plugin', 'settings'] as const) {
      expect(resourceTokens(res({ id: type, name: 'rar', type }))).toEqual([]);
    }
  });
});

describe('usageById', () => {
  it("puts each token's uses on every resource that answers to it, and leaves unused ones out", () => {
    const counts = new Map([
      ['/rar', { typed: 5, agent: 2, lastAt: 50 }],
      ['$rar', { typed: 3, agent: 0, lastAt: 70 }],
      ['/rules-thing', { typed: 9, agent: 0, lastAt: 1 }],
    ]);
    const resources = [
      res({ id: 'claude', name: 'rar' }),
      res({ id: 'codex', name: 'rar', agent: 'codex' }),
      res({ id: 'shared', name: 'rar', agent: 'shared' }),
      res({ id: 'unused', name: 'never' }),
      res({ id: 'rule', name: 'rules-thing', type: 'rule' }),
    ];
    expect(usageById(counts, resources)).toEqual({
      claude: { typed: 5, agent: 2, lastAt: 50, tokens: ['/rar'], sharedWith: 1 },
      codex: { typed: 3, agent: 0, lastAt: 70, tokens: ['$rar'], sharedWith: 1 },
      shared: { typed: 8, agent: 2, lastAt: 70, tokens: ['/rar', '$rar'], sharedWith: 2 },
    });
  });

  it('says when a skill and a command of one name share a count', () => {
    const counts = new Map([['/extract-features', { typed: 4, agent: 0, lastAt: 9 }], ['/solo', { typed: 1, agent: 0, lastAt: 1 }]]);
    const byId = usageById(counts, [
      res({ id: 'skill', name: 'extract-features' }),
      res({ id: 'command', name: 'extract-features', type: 'command' }),
      res({ id: 'solo', name: 'solo' }),
    ]);
    expect(byId.skill.sharedWith).toBe(1);
    expect(byId.command.sharedWith).toBe(1);
    expect(byId.solo).toEqual({ typed: 1, agent: 0, lastAt: 1, tokens: ['/solo'] });
  });
});

describe('createResourceUsage', () => {
  const prompts = [{ timestamp: 1, text: '/rar' }];
  const calls = [{ sessionId: 's1', timestamp: 2, input: '{"skill":"tdd"}', promptAt: null, prompt: null }];

  it('reads the last 90 days once a minute', () => {
    let now = 1_000_000_000_000;
    const read = { prompts: vi.fn(() => prompts), skillCalls: vi.fn(() => calls) };
    const usage = createResourceUsage(read, () => now);
    expect(usage.counts()?.get('/rar')?.typed).toBe(1);
    expect(read.prompts).toHaveBeenCalledWith(now - USAGE_WINDOW_MS, null);
    expect(read.skillCalls).toHaveBeenCalledWith(now - USAGE_WINDOW_MS, null);
    now += USAGE_CACHE_MS - 1;
    usage.counts();
    expect(read.prompts).toHaveBeenCalledTimes(1);
    now += 1;
    usage.counts();
    expect(read.prompts).toHaveBeenCalledTimes(2);
  });

  it('answers unknown (null), never zero, when a read fails, and asks again next time', () => {
    let fail = true;
    const read = {
      prompts: vi.fn(() => { if (fail) throw new Error('database is locked'); return prompts; }),
      skillCalls: vi.fn(() => calls),
    };
    const usage = createResourceUsage(read, () => 5);
    expect(usage.counts()).toBeNull();
    fail = false;
    expect(usage.counts()?.get('/tdd')?.agent).toBe(1);
  });

  it('keeps the last good counts through a failed read', () => {
    let now = 0;
    let fail = false;
    const read = {
      prompts: vi.fn(() => { if (fail) throw new Error('database is locked'); return prompts; }),
      skillCalls: vi.fn(() => calls),
    };
    const usage = createResourceUsage(read, () => now);
    expect(usage.counts()?.get('/rar')?.typed).toBe(1);
    fail = true;
    now += USAGE_CACHE_MS;
    expect(usage.counts()?.get('/rar')?.typed).toBe(1);
    expect(read.prompts).toHaveBeenCalledTimes(2);
  });

  it("counts a phone's shared sessions apart from the Mac's every session, each kept a minute (plan 16)", () => {
    const read = { prompts: vi.fn(() => prompts), skillCalls: vi.fn(() => calls) };
    const usage = createResourceUsage(read, () => 0);
    usage.counts();
    usage.counts(['s2', 's1']);
    usage.counts(['s1', 's2']);
    expect(read.prompts.mock.calls.map((c) => (c as unknown[])[1])).toEqual([null, ['s1', 's2']]);
    expect(read.skillCalls.mock.calls.map((c) => (c as unknown[])[1])).toEqual([null, ['s1', 's2']]);
    // No shared session: nothing to count, and nothing read.
    expect(usage.counts([])?.size).toBe(0);
    expect(read.prompts).toHaveBeenCalledTimes(2);
  });
});

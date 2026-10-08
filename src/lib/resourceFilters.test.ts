// resourceFilters.test.ts — the RESOURCES tab's pure rules.
//
// Everything the tab decides without the network lives in resourceFilters.ts:
// which items a filter shows, what the TYPE rail counts, how URL params read,
// how findings/coverage group, and the small labelling rules. Two of these are
// easy to get subtly wrong and are pinned hard here:
//  - the rail keeps ZERO rows ("Instructions 0" is information: no global
//    CLAUDE.md), and counts with every filter EXCEPT the selected type;
//  - plugin & system items are hidden AND uncounted until the toggle is on.
import { describe, it, expect } from 'vitest';
import {
  RESOURCE_TYPES,
  type ResourceFinding,
  type ResourceSummary,
  type ResourceProject,
  type CoverageEntry,
} from '@/types/resources';
import {
  RESOURCE_TYPE_LABELS,
  DEFAULT_FILTERS,
  readResourceParams,
  withParams,
  isPluginOrSystem,
  matchesFilters,
  filterResources,
  countByType,
  agentTotals,
  catalogSummaryLine,
  relativeAge,
  formatBytes,
  progressLabel,
  groupFindings,
  findingLabel,
  groupCoverage,
  repoChipLabel,
  hasVariantDiff,
  originTag,
  scopeName,
  emptyStateMessage,
  canCompare,
  compareTargets,
  classifyPatchLines,
  frontmatterRows,
  formatFieldValue,
  validateExtraRoot,
  parseStoredExtraRoots,
  MAX_EXTRA_ROOTS,
  revealDelta,
  needsRootsRescan,
  orderProjects,
  sharedProjectNames,
  isExternalHref,
  type ResourceFilters,
} from './resourceFilters';

function res(overrides: Partial<ResourceSummary> & Pick<ResourceSummary, 'id'>): ResourceSummary {
  return {
    type: 'skill',
    agent: 'claude',
    scope: 'global',
    origin: 'user',
    format: 'markdown',
    name: overrides.id,
    path: `~/.claude/skills/${overrides.id}`,
    fileCount: 1,
    bytes: 100,
    mtimeMs: 0,
    repo: { status: 'not-tracked' },
    variantIds: [],
    findingCodes: [],
    ...overrides,
  };
}

function project(overrides: Partial<ResourceProject> & Pick<ResourceProject, 'id' | 'name'>): ResourceProject {
  return {
    path: `~/code/${overrides.name}`,
    exists: true,
    evidence: ['claude-projects'],
    counts: {},
    ...overrides,
  };
}

const RESOURCES: ResourceSummary[] = [
  res({ id: 's1', name: 'tdd', description: 'Test-driven development workflow' }),
  res({ id: 's2', name: 'deploy', agent: 'codex', path: '~/.codex/skills/deploy' }),
  res({ id: 's3', name: 'github', origin: 'plugin', pluginName: 'github@claude-plugins-official' }),
  res({ id: 's4', name: 'imagegen', agent: 'codex', origin: 'system' }),
  res({ id: 's5', name: 'local-skill', scope: 'project', projectId: 'p1', path: '~/code/app/.claude/skills/local-skill' }),
  res({ id: 'r1', type: 'rule', name: 'coding-style.md', path: '~/.claude/rules/coding-style.md' }),
  res({ id: 'r2', type: 'rule', name: 'default.rules', agent: 'codex', format: 'policy' }),
  res({ id: 'm1', type: 'memory', name: 'MEMORY.md', scope: 'project', projectId: 'p2', orphaned: true }),
  res({ id: 'sh1', name: 'shared-skill', agent: 'shared', path: '~/.agents/skills/shared-skill' }),
];

describe('RESOURCE_TYPE_LABELS', () => {
  it('labels all ten types, in rail order', () => {
    expect(RESOURCE_TYPES.map((t) => RESOURCE_TYPE_LABELS[t])).toEqual([
      'Skills', 'Commands', 'Rules', 'Instructions', 'Memory',
      'Agents', 'Hooks', 'MCP', 'Plugins', 'Settings',
    ]);
  });
});

describe('readResourceParams', () => {
  it('falls back to defaults for an empty query string', () => {
    expect(readResourceParams(new URLSearchParams(''))).toEqual({
      section: 'library',
      type: 'skill',
      id: null,
      ...DEFAULT_FILTERS,
    });
    expect(DEFAULT_FILTERS).toEqual({
      agent: 'all', scope: 'all', projectId: null, query: '', showPluginSystem: false,
    });
  });

  it('reads every known key', () => {
    const p = readResourceParams(new URLSearchParams(
      'section=checks&type=rule&agent=codex&scope=global&q=style&id=r1&plugins=1',
    ));
    expect(p).toEqual({
      section: 'checks', type: 'rule', agent: 'codex', scope: 'global',
      projectId: null, query: 'style', id: 'r1', showPluginSystem: true,
    });
  });

  it('rejects unknown values rather than trusting the URL', () => {
    const p = readResourceParams(new URLSearchParams('section=sync&type=widget&agent=gemini&scope=planet&plugins=yes'));
    expect(p.section).toBe('library');
    expect(p.type).toBe('skill');
    expect(p.agent).toBe('all');
    expect(p.scope).toBe('all');
    expect(p.showPluginSystem).toBe(false);
  });

  it('treats a bare ?project=<id> deep link as a project scope', () => {
    const p = readResourceParams(new URLSearchParams('project=p1'));
    expect(p.scope).toBe('project');
    expect(p.projectId).toBe('p1');
  });

  it('ignores the project param outside the project scope', () => {
    const p = readResourceParams(new URLSearchParams('scope=global&project=p1'));
    expect(p.scope).toBe('global');
    expect(p.projectId).toBeNull();
  });
});

describe('withParams', () => {
  it('sets, replaces and deletes keys without mutating the input', () => {
    const prev = new URLSearchParams('type=rule&q=abc&id=r1');
    const next = withParams(prev, { type: 'skill', id: null, q: '', agent: 'codex' });
    expect(next.toString()).toBe('type=skill&agent=codex');
    expect(prev.toString()).toBe('type=rule&q=abc&id=r1');
  });
});

describe('filters', () => {
  it('hides plugin and system items until the toggle is on', () => {
    expect(isPluginOrSystem(RESOURCES[2])).toBe(true);
    expect(isPluginOrSystem(RESOURCES[3])).toBe(true);
    expect(isPluginOrSystem(RESOURCES[0])).toBe(false);

    const hidden = filterResources(RESOURCES, DEFAULT_FILTERS, 'skill').map((r) => r.id);
    expect(hidden).not.toContain('s3');
    expect(hidden).not.toContain('s4');

    const shown = filterResources(RESOURCES, { ...DEFAULT_FILTERS, showPluginSystem: true }, 'skill').map((r) => r.id);
    expect(shown).toEqual(expect.arrayContaining(['s3', 's4']));
  });

  it('filters by agent, scope and project', () => {
    const f = DEFAULT_FILTERS;
    expect(filterResources(RESOURCES, { ...f, agent: 'codex' }, 'skill').map((r) => r.id)).toEqual(['s2']);
    expect(filterResources(RESOURCES, { ...f, agent: 'shared' }, 'skill').map((r) => r.id)).toEqual(['sh1']);
    expect(filterResources(RESOURCES, { ...f, scope: 'project' }, 'skill').map((r) => r.id)).toEqual(['s5']);
    expect(filterResources(RESOURCES, { ...f, scope: 'project', projectId: 'p1' }, 'memory')).toEqual([]);
    expect(filterResources(RESOURCES, { ...f, scope: 'project', projectId: 'p2' }, 'memory').map((r) => r.id)).toEqual(['m1']);
  });

  it('lists Claude memory under Global AND under its project — filed per project, stored in ~/.claude', () => {
    const f = DEFAULT_FILTERS;
    const items = [
      res({
        id: 'cm1', type: 'memory', name: 'MEMORY.md', scope: 'project', projectId: 'p1',
        path: '~/.claude/projects/-code-app/memory/MEMORY.md',
      }),
      res({ id: 'xm1', type: 'memory', name: 'MEMORY.md', agent: 'codex', path: '~/.codex/memories/MEMORY.md' }),
      res({ id: 'ps1', name: 'local', scope: 'project', projectId: 'p1', path: '~/code/app/.claude/skills/local' }),
    ];

    expect(filterResources(items, { ...f, scope: 'global' }, 'memory').map((r) => r.id)).toEqual(['cm1', 'xm1']);
    expect(filterResources(items, { ...f, scope: 'project', projectId: 'p1' }, 'memory').map((r) => r.id)).toEqual(['cm1']);
    // Only memory is dual-listed: a project's own skills stay out of Global.
    expect(filterResources(items, { ...f, scope: 'global' }, 'skill')).toEqual([]);
    // The rail counts the same way, so "Claude · Global" shows its memory count.
    const memoryCount = countByType(items, { ...f, agent: 'claude', scope: 'global' }).find((c) => c.type === 'memory');
    expect(memoryCount?.count).toBe(1);
  });

  it('matches the query case-insensitively against name, description and path', () => {
    const f = DEFAULT_FILTERS;
    expect(filterResources(RESOURCES, { ...f, query: 'TDD' }, 'skill').map((r) => r.id)).toEqual(['s1']);
    expect(filterResources(RESOURCES, { ...f, query: 'driven' }, 'skill').map((r) => r.id)).toEqual(['s1']);
    expect(filterResources(RESOURCES, { ...f, query: '.agents/' }, 'skill').map((r) => r.id)).toEqual(['sh1']);
    // A whitespace-only query is no query at all, never "match nothing".
    expect(filterResources(RESOURCES, { ...f, query: '   ' }, 'skill')).toHaveLength(4);
  });

  it('sorts a list by name so the order is stable across scans', () => {
    expect(filterResources(RESOURCES, DEFAULT_FILTERS, 'skill').map((r) => r.name))
      .toEqual(['deploy', 'local-skill', 'shared-skill', 'tdd']);
  });

  it('matchesFilters ignores the type, which is the rail dimension', () => {
    expect(matchesFilters(RESOURCES[5], DEFAULT_FILTERS)).toBe(true);
  });
});

describe('countByType', () => {
  it('returns all ten types in order and keeps zero rows', () => {
    const counts = countByType(RESOURCES, DEFAULT_FILTERS);
    expect(counts.map((c) => c.type)).toEqual([...RESOURCE_TYPES]);
    expect(Object.fromEntries(counts.map((c) => [c.type, c.count]))).toEqual({
      skill: 4, command: 0, rule: 2, instructions: 0, memory: 1,
      agent: 0, hook: 0, mcp: 0, plugin: 0, settings: 0,
    });
    expect(counts[3]).toEqual({ type: 'instructions', label: 'Instructions', count: 0 });
  });

  it('applies every other filter, including the plugin toggle', () => {
    const codex = countByType(RESOURCES, { ...DEFAULT_FILTERS, agent: 'codex' });
    expect(codex.find((c) => c.type === 'skill')?.count).toBe(1);
    expect(codex.find((c) => c.type === 'rule')?.count).toBe(1);

    const withPlugins = countByType(RESOURCES, { ...DEFAULT_FILTERS, showPluginSystem: true });
    expect(withPlugins.find((c) => c.type === 'skill')?.count).toBe(6);
  });
});

describe('agentTotals', () => {
  it('totals per agent, honouring the plugin toggle', () => {
    expect(agentTotals(RESOURCES, false)).toEqual({ claude: 4, codex: 2, shared: 1 });
    expect(agentTotals(RESOURCES, true)).toEqual({ claude: 5, codex: 3, shared: 1 });
  });
});

describe('catalogSummaryLine', () => {
  const now = 1_000_000_000_000;
  const base = {
    roots: { claude: '~/.claude', codex: '~/.codex', shared: '~/.agents', repo: null },
    projects: [project({ id: 'p1', name: 'app' })],
    resources: RESOURCES,
    findings: [],
    coverage: [],
  };

  it('ready: per-agent totals, projects and scan age', () => {
    expect(catalogSummaryLine({ ...base, state: 'ready', scannedAt: now - 120_000 }, false, now))
      .toBe('4 claude · 2 codex · 1 shared · 1 project · scanned 2m ago');
  });

  it('rescanning: keeps the totals and shows progress in place of the age', () => {
    expect(catalogSummaryLine({
      ...base, state: 'scanning', scannedAt: now - 120_000, progress: { phase: 'hashing', done: 3, total: 9 },
    }, true, now)).toBe('5 claude · 3 codex · 1 shared · 1 project · scanning hashing 3/9');
  });

  it('first scan: progress only — zero totals would read as "nothing here"', () => {
    expect(catalogSummaryLine({
      ...base, resources: [], state: 'scanning', progress: { phase: 'roots', done: 0, total: 0 },
    }, false, now)).toBe('Scanning… roots');
  });

  it('counts only projects that still exist — a vanished folder is not a project you have', () => {
    const projects = [project({ id: 'p1', name: 'app' }), project({ id: 'p9', name: 'old', exists: false })];
    expect(catalogSummaryLine({ ...base, projects, state: 'ready', scannedAt: now - 120_000 }, false, now))
      .toBe('4 claude · 2 codex · 1 shared · 1 project · scanned 2m ago');
  });

  it('never scanned', () => {
    expect(catalogSummaryLine({ ...base, projects: [], resources: [], state: 'idle' }, false, now))
      .toBe('0 claude · 0 codex · 0 shared · 0 projects · not scanned yet');
  });
});

describe('formatting', () => {
  const now = 1_000_000_000_000;
  it('relativeAge', () => {
    expect(relativeAge(now - 10_000, now)).toBe('just now');
    expect(relativeAge(now + 5_000, now)).toBe('just now');
    expect(relativeAge(now - 2 * 60_000, now)).toBe('2m ago');
    expect(relativeAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeAge(now - 5 * 86_400_000, now)).toBe('5d ago');
  });

  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('progressLabel', () => {
    expect(progressLabel({ phase: 'hashing', done: 120, total: 400 })).toBe('hashing 120/400');
    expect(progressLabel({ phase: 'roots', done: 0, total: 0 })).toBe('roots');
    expect(progressLabel(undefined)).toBe('starting');
  });

  it('formatFieldValue renders the masked placeholder, never the value', () => {
    expect(formatFieldValue({ key: 'env.API_KEY', value: 'sk-live-123', masked: true, kind: 'string' })).toBe('******');
    expect(formatFieldValue({ key: 'model', value: 'opus', masked: false, kind: 'string' })).toBe('opus');
  });
});

describe('groupFindings', () => {
  const findings: ResourceFinding[] = [
    { code: 'repo-differs', severity: 'info', resourceId: 'r1', message: 'differs' },
    { code: 'broken-symlink', severity: 'warning', resourceId: 's9', message: 'broken' },
    { code: 'config-parse-error', severity: 'error', resourceId: 'x1', message: 'bad json' },
    { code: 'repo-only', severity: 'info', message: 'only in repo', path: '~/Documents/agent-skills/claude/skills/old' },
    { code: 'repo-differs', severity: 'info', resourceId: 's1', message: 'differs too' },
  ];

  it('orders severities error → warning → info and groups by code with counts', () => {
    const groups = groupFindings(findings);
    expect(groups.map((g) => [g.severity, g.count])).toEqual([
      ['error', 1], ['warning', 1], ['info', 3],
    ]);
    const info = groups[2];
    expect(info.codes.map((c) => [c.code, c.findings.length])).toEqual([
      ['repo-differs', 2], ['repo-only', 1],
    ]);
  });

  it('omits severities with no findings', () => {
    expect(groupFindings([findings[0]]).map((g) => g.severity)).toEqual(['info']);
    expect(groupFindings([])).toEqual([]);
  });

  it('labels every finding code', () => {
    expect(findingLabel('orphaned-memory')).toBe('Orphaned memory');
    expect(findingLabel('repo-only')).toBe('Only in repo');
  });
});

describe('groupCoverage', () => {
  it('groups by root in first-seen order', () => {
    const coverage: CoverageEntry[] = [
      { root: '~/.claude', agent: 'claude', category: 'skill', status: 'scanned', count: 5 },
      { root: '~/.codex', agent: 'codex', category: 'sessions', status: 'not-scanned', bytes: 2048 },
      { root: '~/.claude', agent: 'claude', category: 'credentials', status: 'excluded' },
    ];
    const groups = groupCoverage(coverage);
    expect(groups.map((g) => [g.root, g.entries.length])).toEqual([['~/.claude', 2], ['~/.codex', 1]]);
  });
});

describe('row chips', () => {
  it('repoChipLabel hides not-tracked', () => {
    expect(repoChipLabel('same')).toBe('same');
    expect(repoChipLabel('differs')).toBe('differs');
    expect(repoChipLabel('not-in-repo')).toBe('not in repo');
    expect(repoChipLabel('not-tracked')).toBeNull();
  });

  it('hasVariantDiff reads the variant-differs finding', () => {
    expect(hasVariantDiff(res({ id: 'a', findingCodes: ['variant-differs'] }))).toBe(true);
    expect(hasVariantDiff(res({ id: 'b', variantIds: ['c'] }))).toBe(false);
  });

  it('originTag names every origin except user', () => {
    expect(originTag(res({ id: 'a' }))).toBeNull();
    expect(originTag(res({ id: 'b', origin: 'plugin' }))).toBe('plugin');
    expect(originTag(res({ id: 'c', origin: 'system' }))).toBe('system');
    expect(originTag(res({ id: 'd', origin: 'synced' }))).toBe('synced');
    expect(originTag(res({ id: 'e', origin: 'linked' }))).toBe('linked');
  });

  it('scopeName shows the project name for project items', () => {
    const projects = new Map([['p1', project({ id: 'p1', name: 'app' })]]);
    expect(scopeName(res({ id: 'a' }), projects)).toBe('Global');
    expect(scopeName(res({ id: 'b', scope: 'project', projectId: 'p1' }), projects)).toBe('app');
    expect(scopeName(res({ id: 'c', scope: 'project', projectId: 'gone' }), projects)).toBe('Project');
  });
});

describe('emptyStateMessage', () => {
  it('names the type, agent and scope that came up empty', () => {
    expect(emptyStateMessage('agent', { ...DEFAULT_FILTERS, agent: 'claude', scope: 'global' })).toBe('No agents in Claude · Global');
    expect(emptyStateMessage('mcp', { ...DEFAULT_FILTERS, agent: 'codex' })).toBe('No MCP servers in Codex');
    expect(emptyStateMessage('rule', DEFAULT_FILTERS)).toBe('No rules found');
    expect(emptyStateMessage('skill', { ...DEFAULT_FILTERS, scope: 'project', projectId: 'p1' }, 'app')).toBe('No skills in app');
    expect(emptyStateMessage('skill', { ...DEFAULT_FILTERS, query: 'zzz' })).toBe('No skills match “zzz”');
  });
});

describe('compare targets', () => {
  const codexTwin = res({ id: 'v2', agent: 'codex', name: 'tdd' });
  const byId = new Map([['v2', codexTwin]]);

  it('canCompare needs a tracked repo copy or a variant', () => {
    expect(canCompare(res({ id: 'a', repo: { status: 'same' } }))).toBe(true);
    expect(canCompare(res({ id: 'b', repo: { status: 'differs' } }))).toBe(true);
    expect(canCompare(res({ id: 'c', repo: { status: 'not-in-repo' } }))).toBe(false);
    expect(canCompare(res({ id: 'd', variantIds: ['v2'] }))).toBe(true);
  });

  it('lists the repo first, then each variant by agent and scope', () => {
    const s = res({ id: 'v1', name: 'tdd', repo: { status: 'differs' }, variantIds: ['v2', 'missing'] });
    // A variant id the catalog no longer holds is dropped: comparing against it would 404.
    expect(compareTargets(s, byId, new Map())).toEqual([
      { value: 'repo', label: 'agent-skills repo' },
      { value: 'v2', label: 'Codex · Global' },
    ]);
  });

  it('names a variant whose file name differs (CLAUDE.md ↔ AGENTS.md)', () => {
    const agentsMd = res({ id: 'i2', type: 'instructions', agent: 'codex', name: 'AGENTS.md' });
    const claudeMd = res({ id: 'i1', type: 'instructions', name: 'CLAUDE.md', variantIds: ['i2'] });
    expect(compareTargets(claudeMd, new Map([['i2', agentsMd]]), new Map())).toEqual([
      { value: 'i2', label: 'Codex · Global · AGENTS.md' },
    ]);
  });
});

describe('classifyPatchLines', () => {
  it('tells additions, deletions, hunks and file headers apart', () => {
    const patch = [
      'Index: SKILL.md',
      '===================================================================',
      '--- live/SKILL.md',
      '+++ repo/SKILL.md',
      '@@ -1,3 +1,3 @@',
      ' context',
      '-removed',
      '+added',
      '----',
      '\\ No newline at end of file',
    ].join('\n');
    expect(classifyPatchLines(patch).map((l) => l.kind)).toEqual([
      'meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add',
      // A deleted markdown rule ("---") reads "----" in a patch: inside a hunk
      // it is a deletion, never a file header.
      'del',
      'meta',
    ]);
  });

  it('drops the trailing empty line a patch ends with', () => {
    expect(classifyPatchLines('@@ -1 +1 @@\n-a\n+b\n')).toHaveLength(3);
    expect(classifyPatchLines('')).toEqual([]);
  });
});

describe('frontmatter helpers', () => {
  it('frontmatterRows puts name and description first and stringifies the rest', () => {
    expect(frontmatterRows({ tools: ['Read', 'Grep'], description: 'Does things', name: 'tdd', meta: { a: 1 }, flag: true })).toEqual([
      { key: 'name', value: 'tdd' },
      { key: 'description', value: 'Does things' },
      { key: 'tools', value: 'Read, Grep' },
      { key: 'meta', value: '{"a":1}' },
      { key: 'flag', value: 'true' },
    ]);
  });
});

describe('needsRootsRescan', () => {
  const catalog = (evidence: ResourceProject['evidence'][]) => ({
    state: 'ready' as const,
    roots: { claude: '~/.claude', codex: '~/.codex', shared: '~/.agents', repo: null },
    projects: evidence.map((e, i) => project({ id: `p${i}`, name: `p${i}`, evidence: e })),
    resources: [],
    findings: [],
    coverage: [],
  });

  it('is true only when folders are saved and no project came from them', () => {
    expect(needsRootsRescan(catalog([['claude-projects']]), ['/a/b'])).toBe(true);
    expect(needsRootsRescan(catalog([]), ['/a/b'])).toBe(true);
    expect(needsRootsRescan(catalog([['claude-projects', 'added']]), ['/a/b'])).toBe(false);
    expect(needsRootsRescan(catalog([['claude-projects']]), [])).toBe(false);
  });
});

describe('revealDelta', () => {
  const box = { start: 100, end: 300 };
  it('is zero while the item is fully visible — a click never jumps the list', () => {
    expect(revealDelta(box, { start: 100, end: 140 })).toBe(0);
    expect(revealDelta(box, { start: 260, end: 300 })).toBe(0);
  });

  it('centres an item that is out of view, in either direction', () => {
    expect(revealDelta(box, { start: 500, end: 540 })).toBe(320);
    expect(revealDelta(box, { start: 20, end: 60 })).toBe(-160);
    expect(revealDelta(box, { start: 280, end: 320 })).toBe(100);
  });

  it('aligns the start of an item taller than the box', () => {
    expect(revealDelta(box, { start: 400, end: 700 })).toBe(300);
  });
});

describe('extra roots', () => {
  it('validates an absolute folder the server will accept', () => {
    expect(validateExtraRoot('', [])).toMatch(/enter/i);
    expect(validateExtraRoot('code/app', [])).toMatch(/absolute/i);
    expect(validateExtraRoot('~/code/app', [])).toMatch(/absolute/i);
    expect(validateExtraRoot('/Users', [])).toMatch(/below/i);
    expect(validateExtraRoot('/a/b\u0000c', [])).toMatch(/invalid/i);
    expect(validateExtraRoot('/Users/me/code', ['/Users/me/code'])).toMatch(/already/i);
    expect(validateExtraRoot(' /Users/me/code/ ', ['/Users/me/code'])).toMatch(/already/i);
    expect(validateExtraRoot('/Users/me/code', Array.from({ length: MAX_EXTRA_ROOTS }, (_, i) => `/x/${i}`))).toMatch(/at most/i);
    expect(validateExtraRoot('/Users/me/code', [])).toBeNull();
    expect(validateExtraRoot('C:\\Users\\me', [])).toBeNull();
  });

  it('parses stored roots defensively', () => {
    expect(parseStoredExtraRoots(null)).toEqual([]);
    expect(parseStoredExtraRoots('not json')).toEqual([]);
    expect(parseStoredExtraRoots('{"a":1}')).toEqual([]);
    expect(parseStoredExtraRoots('["/a/b", 3, "/a/b", "relative", "/c/d"]')).toEqual(['/a/b', '/c/d']);
    const many = JSON.stringify(Array.from({ length: 80 }, (_, i) => `/x/${i}`));
    expect(parseStoredExtraRoots(many)).toHaveLength(MAX_EXTRA_ROOTS);
  });
});

// The Sources table is read top-down: the projects you actually have come
// first. Registries keep entries for folders long gone (e.g. /private/tmp test
// dirs), and sorted A→Z they used to fill the first screen above real work.
describe('projects', () => {
  it('orderProjects lists projects that exist before missing ones, each group A→Z', () => {
    const ordered = orderProjects([
      project({ id: 'm1', name: 'aasc-tmp', exists: false }),
      project({ id: 'l2', name: 'zeta' }),
      project({ id: 'l1', name: 'app' }),
      project({ id: 'm2', name: 'a1', exists: false }),
    ]);
    expect(ordered.map((p) => p.id)).toEqual(['l1', 'l2', 'm2', 'm1']);
  });

  it('sharedProjectNames only counts a name shared by projects that still exist', () => {
    const shared = sharedProjectNames([
      project({ id: 'a', name: 'api', path: '~/x/api' }),
      project({ id: 'b', name: 'api', path: '~/y/api' }),
      project({ id: 'c', name: 'a1', path: '/tmp/1/a1', exists: false }),
      project({ id: 'd', name: 'a1', path: '/tmp/2/a1', exists: false }),
      project({ id: 'e', name: 'site', path: '~/site' }),
      project({ id: 'f', name: 'site', path: '/tmp/site', exists: false }),
    ]);
    expect([...shared]).toEqual(['api']);
  });
});

describe('isExternalHref — links in untrusted previews', () => {
  const PAGE = 'http://localhost:3333';

  // Every way a hand-written link can reach THIS machine. Under Electron an
  // app-port one opens an in-app window (electron/internalUrl.ts) — e.g. the
  // Project Browser, which can edit files — and the port is not a safe
  // discriminator, so no loopback link is clickable on any port.
  it.each([
    ['localhost on the app port', 'http://localhost:3333/project-browser?path=/etc'],
    ['localhost on another port', 'http://localhost:5173/'],
    ['localhost without a port', 'http://localhost/'],
    ['localhost in capitals', 'http://LOCALHOST:4000/'],
    ['localhost with a trailing dot', 'http://localhost.:4000/'],
    ['a *.localhost name', 'http://app.localhost:4000/'],
    ['localhost over https', 'https://localhost:8443/'],
    ['127.0.0.1 on the app port', 'http://127.0.0.1:3333/project-browser?path=/etc'],
    ['127.0.0.1 with credentials', 'http://user:pass@127.0.0.1:3333/'],
    ['any 127.x.x.x', 'http://127.1.2.3:8080/'],
    ['127 shorthand', 'http://127.1/'],
    ['127.0.0.1 as a decimal', 'http://2130706433:3333/'],
    ['127.0.0.1 in hex', 'http://0x7f000001:3333/'],
    ['127.0.0.1 in octal', 'http://0177.0.0.1:3333/'],
    ['[::1] on the app port', 'http://[::1]:3333/project-browser?path=/etc'],
    ['[::1] written out', 'http://[0:0:0:0:0:0:0:1]:4000/'],
    ['IPv4-mapped 127.0.0.1', 'http://[::ffff:127.0.0.1]:3333/'],
    ['0.0.0.0', 'http://0.0.0.0:3333/'],
    ['0 as shorthand for 0.0.0.0', 'http://0:3333/'],
    ['[::]', 'http://[::]:3333/'],
    ['IPv4-mapped 0.0.0.0', 'http://[::ffff:0:0]:3333/'],
  ])('%s is not external', (_label, href) => {
    expect(isExternalHref(href, PAGE)).toBe(false);
  });

  it('never trusts relative, script or same-origin links', () => {
    expect(isExternalHref(undefined, PAGE)).toBe(false);
    expect(isExternalHref('', PAGE)).toBe(false);
    expect(isExternalHref('references/x.md', PAGE)).toBe(false);
    expect(isExternalHref('/project-browser?path=/etc', PAGE)).toBe(false);
    expect(isExternalHref('javascript:alert(1)', PAGE)).toBe(false);
    // Opened over the LAN the page's own origin is not a loopback host.
    expect(isExternalHref('http://192.168.1.5:3333/project-browser', 'http://192.168.1.5:3333')).toBe(false);
  });

  it('keeps links to other machines clickable', () => {
    expect(isExternalHref('https://example.com/docs', PAGE)).toBe(true);
    expect(isExternalHref('http://example.com:3333/', PAGE)).toBe(true);
    expect(isExternalHref('mailto:someone@example.com', PAGE)).toBe(true);
    // Names that merely contain a loopback-looking label are ordinary hosts.
    expect(isExternalHref('https://127.0.0.1.example.com/', PAGE)).toBe(true);
    expect(isExternalHref('http://localhost.example.com/', PAGE)).toBe(true);
  });
});

describe('matchesFilters with skill notes', () => {
  const notes = {
    'claude:tdd': { fav: true, tags: ['review', 'workflow'], abbr: 'tdd2' },
    'codex:deploy': { fav: false, tags: ['ops'] },
    'shared:shared-skill': { fav: true, tags: [] },
  };
  const ids = (f: Partial<ResourceFilters>) =>
    RESOURCES.filter((r) => matchesFilters(r, { ...DEFAULT_FILTERS, showPluginSystem: true, notes, ...f })).map((r) => r.id);

  it('is unchanged when no note filter is active', () => {
    expect(ids({})).toEqual(RESOURCES.map((r) => r.id));
  });

  it('shows favourites only, and hides types that cannot have notes', () => {
    expect(ids({ favOnly: true })).toEqual(['s1', 'sh1']);
  });

  it('matches several tags by ANY', () => {
    expect(ids({ tags: ['ops'] })).toEqual(['s2']);
    expect(ids({ tags: ['ops', 'review'] })).toEqual(['s1', 's2']);
  });

  it('combines favourites with tags (both must hold)', () => {
    expect(ids({ favOnly: true, tags: ['ops', 'workflow'] })).toEqual(['s1']);
  });

  it('search also finds a skill by its tag or abbreviation', () => {
    expect(ids({ query: 'workflow' })).toContain('s1');
    expect(ids({ query: 'tdd2' })).toEqual(['s1']);
    expect(ids({ query: 'ops' })).toContain('s2');
  });

  it('counts by type under a note filter', () => {
    const counts = countByType(RESOURCES, { ...DEFAULT_FILTERS, showPluginSystem: true, notes, favOnly: true });
    expect(counts.find((c) => c.type === 'skill')?.count).toBe(2);
    expect(counts.find((c) => c.type === 'rule')?.count).toBe(0);
  });
});

// resourceCatalog.ts — shared test support for the ResourcesView suites
// (src/routes/ResourcesView{,.states,.panels}.test.tsx): a realistic catalog
// (every resource type, zero-count types, plugin/system items, a linked skill,
// masked config, repo same/differs, a variant pair, an orphaned memory,
// findings of each severity, a missing project, not-scanned coverage), a stub
// for fetch('/api/resources…'), and the DOM queries the suites share.
//
// Not a suite: the name does not end in .test.ts, so vitest's
// `src/**/*.test.{ts,tsx}` include never collects it. It is a .ts file on
// purpose — the one component below uses createElement rather than JSX.
import { createElement } from 'react';
import { vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import ResourcesView from '@/routes/ResourcesView';
import type {
  ResourceCatalog,
  ResourceCompare,
  ResourceDetail,
  ResourceFileContent,
  ResourceSummary,
  ResourceProject,
} from '@/types/resources';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const NOW = Date.now();

export function res(overrides: Partial<ResourceSummary> & Pick<ResourceSummary, 'id' | 'name'>): ResourceSummary {
  return {
    type: 'skill',
    agent: 'claude',
    scope: 'global',
    origin: 'user',
    format: 'markdown',
    path: `~/.claude/skills/${overrides.name}`,
    fileCount: 1,
    bytes: 512,
    mtimeMs: NOW - 86_400_000,
    repo: { status: 'not-tracked' },
    variantIds: [],
    findingCodes: [],
    ...overrides,
  };
}

export const RESOURCES: ResourceSummary[] = [
  res({
    id: 'sk-claude-tdd', name: 'tdd', description: 'Test-driven development workflow', fileCount: 3,
    repo: { status: 'differs', path: '~/Documents/agent-skills/claude/skills/tdd' },
    variantIds: ['sk-codex-tdd'], findingCodes: ['repo-differs', 'variant-differs'],
  }),
  res({
    id: 'sk-codex-tdd', name: 'tdd', agent: 'codex', path: '~/.codex/skills/tdd',
    repo: { status: 'same', path: '~/Documents/agent-skills/codex/skills/tdd' },
    variantIds: ['sk-claude-tdd'], findingCodes: ['variant-differs'],
  }),
  res({
    id: 'sk-research', name: 'research', origin: 'linked',
    linkTarget: '~/Documents/other-repo/skills/research',
    repo: { status: 'not-in-repo' }, findingCodes: ['linked-outside', 'not-in-repo'],
  }),
  res({
    id: 'sk-github', name: 'github-review', origin: 'plugin', pluginName: 'github@claude-plugins-official',
    path: '~/.claude/plugins/marketplaces/official/github/skills/github-review',
  }),
  res({ id: 'sk-imagegen', name: 'imagegen', agent: 'codex', origin: 'system', path: '~/.codex/skills/.system/imagegen' }),
  res({
    id: 'sk-brand', name: 'brand-voice', origin: 'synced', path: '~/.claude/skills/synced/abc/brand-voice',
    findingCodes: ['frontmatter-invalid'],
  }),
  res({ id: 'sk-broken', name: 'old-skill', repo: { status: 'not-in-repo' }, findingCodes: ['broken-symlink'] }),
  res({
    id: 'sk-app-helper', name: 'app-helper', scope: 'project', projectId: 'p-app',
    path: '~/code/app/.claude/skills/app-helper',
  }),
  res({ id: 'sh-notes', name: 'shared-notes', agent: 'shared', path: '~/.agents/skills/shared-notes' }),
  res({ id: 'cmd-review', type: 'command', name: 'review:pr', path: '~/.claude/commands/review/pr.md', repo: { status: 'same' } }),
  res({ id: 'rule-style', type: 'rule', name: 'coding-style.md', path: '~/.claude/rules/coding-style.md', repo: { status: 'same' } }),
  res({
    id: 'rule-py', type: 'rule', name: 'python/coding-style.md', path: '~/.claude/rules/python/coding-style.md',
    repo: { status: 'differs' }, findingCodes: ['repo-differs'],
  }),
  res({
    id: 'rule-codex', type: 'rule', name: 'default.rules', agent: 'codex', format: 'policy',
    path: '~/.codex/rules/default.rules', repo: { status: 'same' },
  }),
  res({
    id: 'in-claude', type: 'instructions', name: 'CLAUDE.md', scope: 'project', projectId: 'p-app',
    path: '~/code/app/CLAUDE.md', variantIds: ['in-agents'],
  }),
  res({
    id: 'in-agents', type: 'instructions', name: 'AGENTS.md', agent: 'codex', scope: 'project', projectId: 'p-app',
    path: '~/code/app/AGENTS.md', variantIds: ['in-claude'],
  }),
  res({
    id: 'mem-orphan', type: 'memory', name: 'MEMORY.md', scope: 'project', projectId: 'p-gone', orphaned: true,
    path: '~/.claude/projects/-Users-me-code-old-site/memory/MEMORY.md', findingCodes: ['orphaned-memory'],
  }),
  res({ id: 'mem-codex', type: 'memory', name: 'notes.md', agent: 'codex', path: '~/.codex/memories/notes.md' }),
  res({
    id: 'agent-reviewer', type: 'agent', name: 'reviewer.md', scope: 'project', projectId: 'p-app',
    path: '~/code/app/.claude/agents/reviewer.md',
  }),
  res({ id: 'hook-pre', type: 'hook', name: 'PreToolUse', format: 'config', path: '~/.claude/settings.json' }),
  res({ id: 'mcp-kason', type: 'mcp', name: 'kason-tools', format: 'config', path: '~/.claude.json' }),
  res({
    id: 'plugin-github', type: 'plugin', name: 'github@claude-plugins-official', format: 'config',
    path: '~/.claude/plugins/installed_plugins.json',
  }),
  res({ id: 'set-claude', type: 'settings', name: 'settings.json', format: 'config', path: '~/.claude/settings.json' }),
  res({
    id: 'set-local', type: 'settings', name: 'settings.local.json', format: 'config',
    path: '~/.claude/settings.local.json', findingCodes: ['config-parse-error'],
  }),
  res({ id: 'set-codex', type: 'settings', name: 'config.toml', agent: 'codex', format: 'config', path: '~/.codex/config.toml' }),
];

export const PROJECTS: ResourceProject[] = [
  {
    id: 'p-app', name: 'app', path: '~/code/app', exists: true, duplicateName: true,
    evidence: ['claude-projects', 'claude-json', 'aasc-session'], counts: { skill: 1, instructions: 2, agent: 1 },
  },
  {
    id: 'p-app-wt', name: 'app', path: '~/code/app/.claude/worktrees/feature-x', exists: true, duplicateName: true,
    worktreeOf: '~/code/app', evidence: ['claude-projects'], counts: {},
  },
  { id: 'p-gone', name: 'old-site', path: '~/code/old-site', exists: false, evidence: ['claude-projects'], counts: { memory: 1 } },
  { id: 'p-home', name: 'me', path: '~', exists: true, isHome: true, evidence: ['claude-json'], counts: {} },
];

export const REPO_ONLY_PATH = '~/Documents/agent-skills/claude/skills/retired';

export const CATALOG: ResourceCatalog = {
  state: 'ready',
  startedAt: NOW - 125_000,
  scannedAt: NOW - 120_000,
  durationMs: 5_000,
  roots: { claude: '~/.claude', codex: '~/.codex', shared: '~/.agents', repo: '~/Documents/agent-skills' },
  projects: PROJECTS,
  resources: RESOURCES,
  findings: [
    { code: 'config-parse-error', severity: 'error', resourceId: 'set-local', message: 'settings.local.json is not valid JSON (line 3)' },
    { code: 'broken-symlink', severity: 'warning', resourceId: 'sk-broken', message: 'Symlink target does not exist' },
    { code: 'frontmatter-invalid', severity: 'warning', resourceId: 'sk-brand', message: 'Frontmatter is not valid YAML' },
    { code: 'orphaned-memory', severity: 'warning', resourceId: 'mem-orphan', message: 'Project folder ~/code/old-site no longer exists' },
    { code: 'repo-differs', severity: 'info', resourceId: 'sk-claude-tdd', message: 'Differs from the agent-skills copy' },
    { code: 'repo-differs', severity: 'info', resourceId: 'rule-py', message: 'Differs from the agent-skills copy' },
    { code: 'variant-differs', severity: 'info', resourceId: 'sk-claude-tdd', message: 'Claude and Codex copies differ' },
    { code: 'variant-differs', severity: 'info', resourceId: 'sk-codex-tdd', message: 'Claude and Codex copies differ' },
    { code: 'not-in-repo', severity: 'info', resourceId: 'sk-research', message: 'Not in the agent-skills repo' },
    { code: 'linked-outside', severity: 'info', resourceId: 'sk-research', message: 'Links outside ~/.claude' },
    { code: 'repo-only', severity: 'info', path: REPO_ONLY_PATH, message: 'Only in the agent-skills repo' },
  ],
  coverage: [
    { root: '~/.claude', agent: 'claude', category: 'skill', status: 'scanned', count: 7 },
    { root: '~/.claude', agent: 'claude', category: 'sessions', status: 'not-scanned', count: 120, bytes: 52_428_800, note: 'Phase D — size only' },
    { root: '~/.claude', agent: 'claude', category: 'credentials', status: 'excluded', note: 'names only, never read' },
    { root: '~/.codex', agent: 'codex', category: 'sessions', status: 'not-scanned', count: 30, bytes: 2_097_152, note: 'Phase D — size only' },
    { root: '~/.codex', agent: 'codex', category: 'plugin-contents', status: 'not-scanned', note: 'record only' },
    { root: '~/.codex', agent: 'codex', category: 'credentials', status: 'excluded', note: 'presence only, never read' },
    { root: '~/.agents', agent: 'shared', category: 'skill', status: 'scanned', count: 1 },
    { root: '~/code/old-site', agent: 'claude', category: 'skill', status: 'not-found' },
  ],
};

function summaryOf(id: string): ResourceSummary {
  const found = RESOURCES.find((r) => r.id === id);
  if (!found) throw new Error(`fixture has no ${id}`);
  return found;
}

export const DETAILS: Record<string, ResourceDetail> = {
  'sk-claude-tdd': {
    summary: summaryOf('sk-claude-tdd'),
    frontmatter: { name: 'tdd', description: 'Test-driven development workflow', 'allowed-tools': ['Read', 'Edit'] },
    body: '# TDD workflow\n\nWrite the **failing** test first.\n\n```ts\nexpect(sum(1, 2)).toBe(3);\n```\n',
    files: [
      { path: 'SKILL.md', bytes: 500, isText: true },
      { path: 'references/checklist.md', bytes: 200, isText: true },
      { path: 'references/gone.md', bytes: 10, isText: true },
      { path: 'assets/logo.png', bytes: 4096, isText: false },
    ],
    findings: CATALOG.findings.filter((f) => f.resourceId === 'sk-claude-tdd'),
  },
  // The server strips frontmatter; what is left may legitimately OPEN with a rule.
  'sk-codex-tdd': {
    summary: summaryOf('sk-codex-tdd'),
    frontmatter: { name: 'tdd' },
    body: '---\n\nIntro kept.\n\n---\n\n# TDD\n',
    findings: [],
  },
  'sk-research': {
    summary: summaryOf('sk-research'),
    frontmatter: { name: 'research', description: 'Deep research' },
    body: '# Research\n\nFind sources.\n',
    files: [{ path: 'SKILL.md', bytes: 120, isText: true }],
    findings: CATALOG.findings.filter((f) => f.resourceId === 'sk-research'),
  },
  // As the server sends it: the unparseable block is stripped from `body` too.
  'sk-brand': {
    summary: summaryOf('sk-brand'),
    frontmatterError: 'bad indentation of a mapping entry (2:7)',
    body: '# Brand voice\n\nWrite like us.\n',
    findings: CATALOG.findings.filter((f) => f.resourceId === 'sk-brand'),
  },
  // Untrusted content: none of this may execute, load, or navigate inside the app.
  'sk-evil': {
    summary: res({ id: 'sk-evil', name: 'evil' }),
    body: [
      '# Evil',
      '',
      '<img src="x" onerror="alert(1)">',
      '',
      '<script>alert(2)</script>',
      '',
      '![remote](https://tracker.example/pixel.png)',
      '',
      '[run](javascript:alert(3)) [docs](https://example.com/docs) [self](SELF_URL) [relative](references/x.md)',
      '',
      // This app's own server under its other loopback names, and a dev server.
      // (react-markdown percent-encodes the IPv6 brackets, so that href never
      // parses and stays inert anyway; isExternalHref's unit tests cover [::1].)
      '[ipv4](LOOPBACK_V4) [ipv6](LOOPBACK_V6) [devserver](http://localhost:5173/)',
      '',
    ].join('\n')
      .replace('SELF_URL', `${window.location.origin}/project-browser?path=/etc`)
      .replace('LOOPBACK_V4', `http://127.0.0.1:${window.location.port}/project-browser?path=/etc`)
      .replace('LOOPBACK_V6', `http://[::1]:${window.location.port}/project-browser?path=/etc`),
    findings: [],
  },
  'sk-broken': { summary: summaryOf('sk-broken'), findings: CATALOG.findings.filter((f) => f.resourceId === 'sk-broken') },
  'rule-style': { summary: summaryOf('rule-style'), body: '# Coding style\n\nPrefer immutability.\n', findings: [] },
  'rule-codex': {
    summary: summaryOf('rule-codex'),
    body: 'prefix_rule(pattern = ["git", "status"], decision = "allow")\n',
    findings: [],
  },
  'mcp-kason': {
    summary: summaryOf('mcp-kason'),
    fields: [
      { key: 'type', value: 'stdio', masked: false, kind: 'string' },
      { key: 'command', value: 'node', masked: false, kind: 'string' },
      { key: 'args[0]', value: 'server.js', masked: false, kind: 'string' },
      { key: 'env.API_KEY', value: '******', masked: true, kind: 'string' },
      // A server that forgot to blank a masked value must still not leak it.
      { key: 'env.GITHUB_TOKEN', value: 'ghp_shouldNeverRender', masked: true, kind: 'string' },
      { key: 'timeout', value: '30', masked: false, kind: 'number' },
    ],
    findings: [],
  },
};

export const FILES: Record<string, ResourceFileContent> = {
  'sk-claude-tdd:references/checklist.md': { path: 'references/checklist.md', bytes: 22, content: '- [ ] red\n- [ ] green\n' },
};

const TDD_PATCH = [
  'Index: SKILL.md',
  '===================================================================',
  '--- live/SKILL.md',
  '+++ repo/SKILL.md',
  '@@ -1,3 +1,3 @@',
  ' # TDD workflow',
  '-Write the **failing** test first.',
  '+Write the test first.',
  '',
].join('\n');

export const COMPARES: Record<string, ResourceCompare> = {
  'sk-claude-tdd:repo': {
    left: { label: 'Live', path: '~/.claude/skills/tdd' },
    right: { label: 'agent-skills repo', path: '~/Documents/agent-skills/claude/skills/tdd' },
    files: [
      { path: 'SKILL.md', status: 'changed' },
      { path: 'references/checklist.md', status: 'same' },
      { path: 'assets/logo.png', status: 'only-left' },
    ],
    patch: TDD_PATCH,
  },
  'sk-claude-tdd:sk-codex-tdd': {
    left: { label: 'Claude', path: '~/.claude/skills/tdd' },
    right: { label: 'Codex', path: '~/.codex/skills/tdd' },
    files: [{ path: 'SKILL.md', status: 'changed' }],
    patch: '@@ -1 +1 @@\n-# TDD workflow\n+# TDD\n',
  },
};

// ---------------------------------------------------------------------------
// Fetch stub
// ---------------------------------------------------------------------------

type CatalogReply =
  | ResourceCatalog
  | { status: number; error: string }
  | { delayMs: number; catalog: ResourceCatalog }
  | 'hang';

interface ApiOptions {
  /** Consumed in order by GET /api/resources; the last one repeats. */
  catalogs?: CatalogReply[];
}

function reply(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as Response;
}

const notFound = () => reply(404, { success: false, error: 'Not found' });

export function stubApi({ catalogs = [CATALOG] }: ApiOptions = {}) {
  const queue = [...catalogs];
  const mock = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, 'http://localhost');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/resources' && method === 'GET') {
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      if (next === 'hang') return new Promise<Response>(() => {});
      if ('delayMs' in next) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(reply(200, { success: true, data: next.catalog })), next.delayMs);
        });
      }
      if ('status' in next && typeof next.status === 'number') {
        return reply(next.status, { success: false, error: next.error });
      }
      return reply(200, { success: true, data: next });
    }
    if (url.pathname === '/api/resources/scan' && method === 'POST') {
      return reply(200, { success: true, data: { state: 'scanning', progress: { phase: 'roots', done: 0, total: 0 } } });
    }
    const item = /^\/api\/resources\/item\/([^/]+)(?:\/(file|compare))?$/.exec(url.pathname);
    if (item) {
      const id = decodeURIComponent(item[1]);
      const table: Record<string, unknown> =
        item[2] === 'file' ? FILES : item[2] === 'compare' ? COMPARES : DETAILS;
      const key = item[2] === 'file'
        ? `${id}:${url.searchParams.get('path')}`
        : item[2] === 'compare' ? `${id}:${url.searchParams.get('against')}` : id;
      const data = table[key];
      return data ? reply(200, { success: true, data }) : notFound();
    }
    return notFound();
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

export function urlsCalled(mock: ReturnType<typeof stubApi>): string[] {
  return mock.mock.calls.map(([input]) => String(input));
}

export function catalogGets(mock: ReturnType<typeof stubApi>): number {
  return mock.mock.calls.filter(([input, init]) => input === '/api/resources' && (init?.method ?? 'GET') === 'GET').length;
}

// ---------------------------------------------------------------------------
// Rendering and DOM queries
// ---------------------------------------------------------------------------

/**
 * Exposes the current query string for urlParams(). A plain div: <output>
 * carries an implicit role="status" and would collide with the view's own
 * loading status.
 */
function LocationProbe() {
  const location = useLocation();
  return createElement('div', { 'data-testid': 'location' }, location.search);
}

/** Mounts ResourcesView at /resources, as the app's router does. */
export function renderView(path = '/resources') {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(Routes, null, createElement(Route, { path: '/resources', element: createElement(ResourcesView) })),
      createElement(LocationProbe),
    ),
  );
}

export function urlParams(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId('location').textContent ?? '');
}

/** The counts line only appears once a catalog has loaded, in every section. */
export async function ready(): Promise<void> {
  // LAZY, not the 1 s default: the whole suite runs in parallel, and on a busy
  // machine the first render of the tab alone can take longer than that.
  await screen.findByText(/ projects? · scanned /, {}, LAZY);
}

export function rail() {
  return screen.getByRole('navigation', { name: 'Resource types' });
}

export function railButton(label: string) {
  return within(rail()).getByRole('button', { name: new RegExp(`^${label} \\d+$`) });
}

export function railCounts(): string[] {
  return within(rail()).getAllByRole('button').map((b) => b.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

/** The row buttons of the list. The favourite toggles beside them (aria-pressed) are not rows. */
export function listRows(): HTMLElement[] {
  const list = screen.queryByRole('list', { name: 'Resources' });
  return list ? within(list).getAllByRole('button').filter((b) => !b.hasAttribute('aria-pressed')) : [];
}

export function row(name: RegExp): HTMLElement {
  return within(screen.getByRole('list', { name: 'Resources' })).getByRole('button', { name, pressed: undefined });
}

export function detail() {
  return screen.getByRole('region', { name: 'Resource detail' });
}

export const LAZY = { timeout: 5000 };

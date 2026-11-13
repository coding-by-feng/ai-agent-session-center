// ResourcesScreen.test.tsx — More → Resources on the phone (plan 16, P1): the desktop's Library and
// Projects, read through the Mac, and one resource. Resource sync left the phone in Nov 2026: no
// Cloud sync tab, no cloud state on a resource. Read-only in P1: no screen offers to sync, save,
// install, uninstall, clone, pull or push.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/deviceIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/deviceIdentity')>()),
  getClientId: () => 'phone',
}));

import ResourcesScreen from './ResourcesScreen';
import ResourceItemScreen from './ResourceItemScreen';
import ProjectItemScreen from './ProjectItemScreen';
import { usePhoneNavStore, defaultStacks } from '@/stores/phoneNavStore';
import type { ResourceSummary } from '@/types/resources';

const ID = (n: number) => n.toString(16).padStart(16, '0');
const CLOUD = (n: number) => `0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b${String(n).padStart(2, '0')}`;
const NOW = Date.now();

function summary(n: number, over: Partial<ResourceSummary> = {}): ResourceSummary {
  return {
    id: ID(n), name: `skill-${n}`, type: 'skill', agent: 'claude', scope: 'global', origin: 'user', format: 'markdown',
    path: `~/.claude/skills/skill-${n}`, fileCount: 1, bytes: 2048, mtimeMs: NOW - 3_600_000, repo: { status: 'not-tracked' },
    variantIds: [], findingCodes: [], ...over,
  };
}

const RAR = summary(1, { name: 'rar', description: 'Retouch, sketch, wait', variantIds: [ID(2)], fileCount: 2 });
const RAR_CODEX = summary(2, { name: 'rar', agent: 'codex', path: '~/.codex/skills/rar', variantIds: [ID(1)] });
const TDD = summary(3, { name: 'tdd', description: 'Tests first' });
const DEPLOY = summary(4, { name: 'deploy', scope: 'project', projectId: 'p1', path: '~/code/app/.claude/skills/deploy' });
const RULE = summary(5, { name: 'coding-style.md', type: 'rule', path: '~/.claude/rules/coding-style.md' });
const MCP = summary(6, { name: 'kason', type: 'mcp', format: 'config', path: '~/.claude.json' });
const PLUGIN = summary(7, { name: 'plugin-skill', origin: 'plugin', pluginName: 'superpowers' });

const LIBRARY = {
  state: 'ready', scannedAt: NOW - 60_000,
  resources: [RAR, RAR_CODEX, TDD, DEPLOY, RULE, MCP, PLUGIN],
  projects: [{ id: 'p1', name: 'app', path: '~/code/app' }],
  usage: {
    windowDays: 90, scope: 'shared',
    byId: {
      [ID(1)]: { typed: 12, agent: 5, lastAt: NOW - 2 * 3_600_000, tokens: ['/rar'] },
      [ID(2)]: { typed: 3, agent: 0, lastAt: NOW - 86_400_000, tokens: ['$rar'] },
      [ID(4)]: { typed: 40, agent: 0, lastAt: NOW, tokens: ['/deploy'] },
    },
  },
};

const LINK = { connected: true, state: 'connected', problem: null, readAt: new Date(NOW - 60_000).toISOString() };
const PROJECTS = {
  ...LINK,
  accounts: { installed: true, accounts: [{ login: 'kason', active: true, ok: true }, { login: 'other', active: false, ok: true }] },
  projects: [
    { id: CLOUD(20), name: 'agent-manager', owner: 'kason', repo: 'agent-manager', branch: 'main',
      local: { state: 'ahead', branch: 'main', path: '~/code/agent-manager', ahead: 2, behind: 0, account: 'kason' } },
    { id: CLOUD(21), name: 'website', owner: 'kason', repo: 'website', branch: 'main',
      local: { state: 'missing', branch: null, path: null, ahead: null, behind: null, account: null } },
  ],
  truncated: false,
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let routes: Record<string, () => Response | Promise<Response>>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  routes = {
    '/api/phone-resources/library': () => reply(LIBRARY),
    '/api/phone-resources/projects': () => reply(PROJECTS),
    '/api/skill-notes/favorites': () => reply({ entries: [{ key: 'claude:rar', fav: true, tags: ['retouch'], abbr: 'rr' }], source: 'cloud' }),
    [`/api/phone-resources/item/${ID(1)}`]: () => reply({
      summary: RAR, body: '# Retouch\n\nSketch, then **wait**.', files: [
        { path: 'SKILL.md', bytes: 2000, isText: true },
        { path: 'references/notes.md', bytes: 48, isText: true },
      ], findings: [],
    }),
    [`/api/phone-resources/item/${ID(1)}/file?path=references%2Fnotes.md`]: () => reply({ path: 'references/notes.md', bytes: 48, content: 'The reference notes.' }),
    [`/api/phone-resources/item/${ID(5)}`]: () => reply({ summary: RULE, body: 'Keep functions small.', findings: [] }),
    [`/api/phone-resources/item/${ID(6)}`]: () => reply({
      summary: MCP, findings: [],
      fields: [{ key: 'mcpServers.kason.env.API_KEY', value: '******', masked: true, kind: 'string' }, { key: 'mcpServers.kason.command', value: 'npx', masked: false, kind: 'string' }],
    }),
  };
  fetchMock = vi.fn(async (url: string) => (routes[url] ? routes[url]() : reply({ error: 'Not found' }, 404)));
  vi.stubGlobal('fetch', fetchMock);
  usePhoneNavStore.setState({ tab: 'more', stacks: defaultStacks() });
  sessionStorage.clear();
});

afterEach(() => vi.unstubAllGlobals());

const top = () => usePhoneNavStore.getState().stacks.more.at(-1);
/** Each Library row's resource, by the name it shows. */
const rowNames = () => screen.getAllByTestId('resource-row').map((r) => ['deploy', 'tdd', 'rar'].find((n) => r.textContent?.includes(n)));
/** Nothing in P1 may change a resource, the cloud or a project. */
function expectReadOnly() {
  for (const word of [/sync now/i, /save to cloud/i, /install/i, /uninstall/i, /remove/i, /clone/i, /^pull$/i, /^push$/i, /keep mine/i, /use cloud/i]) {
    expect(screen.queryByRole('button', { name: word }), String(word)).toBeNull();
  }
}

describe('Resources → Library', () => {
  it('lists the skills with their uses, where they live, and a ♥ for a favourite; a rule has no count', async () => {
    render(<ResourcesScreen tab="library" />);
    const rows = await screen.findAllByTestId('resource-row');
    expect(rowNames()).toEqual(['deploy', 'rar', 'rar', 'tdd']);
    expect(rows[1].textContent).toContain('Claude · Global');
    expect(rows[1].textContent).toContain('Retouch, sketch, wait');
    expect(rows[1].textContent).toContain('17 uses');
    expect(rows[2].textContent).toContain('Codex · Global');
    expect(rows[0].textContent).toContain('Claude · app');
    await waitFor(() => expect(within(rows[1]).getByLabelText('Favourite')).toBeTruthy());
    expect(within(rows[3]).getByLabelText('not used').textContent).toBe('—');
    expect(screen.getByText('Uses count only the sessions shared with this phone.')).toBeTruthy();
    expect(screen.queryByText('plugin-skill')).toBeNull();
    expectReadOnly();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Rules 1' }));
    const rule = screen.getAllByTestId('resource-row');
    expect(rule).toHaveLength(1);
    expect(rule[0].textContent).not.toMatch(/uses|—/);
  });

  it('searches, sorts by use, shows plugin items when asked, and opens a resource', async () => {
    const user = userEvent.setup();
    render(<ResourcesScreen tab="library" />);
    await screen.findAllByTestId('resource-row');
    await user.click(screen.getByRole('button', { name: 'Most used' }));
    expect(rowNames()).toEqual(['deploy', 'rar', 'rar', 'tdd']);
    expect(screen.getAllByTestId('resource-row')[1].textContent).toContain('17 uses');
    await user.click(screen.getByRole('button', { name: 'Plugin & system' }));
    expect(screen.getByText('plugin-skill')).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: 'Search resources' }), 'tests');
    const found = screen.getAllByTestId('resource-row');
    expect(found).toHaveLength(1);
    await user.click(within(found[0]).getByRole('button'));
    expect(top()).toBe(`/more/resources/item/${ID(3)}`);
  });

  it('comes back to the type, search and filters it was left on', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ResourcesScreen tab="library" />);
    await screen.findAllByTestId('resource-row');
    await user.click(screen.getByRole('button', { name: 'Rules 1' }));
    unmount();
    render(<ResourcesScreen tab="library" />);
    await screen.findAllByTestId('resource-row');
    expect(screen.getByRole('button', { name: 'Rules 1' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('says the Mac is scanning while it has nothing yet, and reads again', async () => {
    routes['/api/phone-resources/library'] = () => reply({ ...LIBRARY, state: 'scanning', scannedAt: null, resources: [], projects: [], usage: null });
    render(<ResourcesScreen tab="library" />);
    expect(await screen.findByText('Your Mac is scanning its resources…')).toBeTruthy();
  });

  it('offers two tabs, Library and Projects, and never asks the Mac for Cloud sync', async () => {
    render(<ResourcesScreen tab="library" />);
    await screen.findAllByTestId('resource-row');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Library', 'Projects']);
    expect(screen.queryByRole('tab', { name: /sync/i })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/sync'))).toBe(false);
  });

  it('switching tabs replaces the path, so Back leaves Resources', async () => {
    const user = userEvent.setup();
    usePhoneNavStore.setState({ tab: 'more', stacks: { ...defaultStacks(), more: ['/more', '/more/resources'] } });
    render(<ResourcesScreen tab="library" />);
    await screen.findAllByTestId('resource-row');
    await user.click(screen.getByRole('tab', { name: 'Projects' }));
    expect(usePhoneNavStore.getState().stacks.more).toEqual(['/more', '/more/resources/projects']);
  });
});

describe('Resources → Projects', () => {
  it('lists the GitHub accounts and each project’s checkout in the desktop’s words', async () => {
    render(<ResourcesScreen tab="projects" />);
    expect(await screen.findByText('kason (active), other')).toBeTruthy();
    const rows = screen.getAllByTestId('project-row');
    expect(rows[0].textContent).toContain('2 commits to push');
    expect(rows[0].textContent).toContain('github.com/kason/agent-manager · main');
    expect(rows[0].textContent).toContain('~/code/agent-manager');
    expect(rows[1].textContent).toContain('Not on this device');
    expect(screen.getByText(/Clone, Pull, Push and Check run on your Mac/)).toBeTruthy();
    expectReadOnly();
  });

  it('a row opens its project', async () => {
    const user = userEvent.setup();
    render(<ResourcesScreen tab="projects" />);
    const rows = await screen.findAllByTestId('project-row');
    await user.click(within(rows[1]).getByRole('button'));
    expect(top()).toBe(`/more/resources/projects/${CLOUD(21)}`);
  });
});

describe('a saved project', () => {
  it('shows its state, repository and the checkout on the Mac in full', async () => {
    render(<ProjectItemScreen id={CLOUD(20)} />);
    expect(await screen.findByRole('heading', { name: 'agent-manager' })).toBeTruthy();
    expect(screen.getByText('2 commits to push')).toBeTruthy();
    expect(screen.getByText('github.com/kason/agent-manager')).toBeTruthy();
    expect(screen.getByText('~/code/agent-manager')).toBeTruthy();
    const mac = screen.getByRole('region', { name: 'On your Mac' });
    expect(within(mac).getByText('Branch here')).toBeTruthy();
    expect(within(mac).getByText('2 commits')).toBeTruthy();
    expect(within(mac).getByText('Nothing')).toBeTruthy();
    expect(within(mac).getByText('kason')).toBeTruthy();
    expectReadOnly();
  });

  it('one not cloned on the Mac says so; one no longer saved says that', async () => {
    const { unmount } = render(<ProjectItemScreen id={CLOUD(21)} />);
    expect(await screen.findByText('Not on this Mac')).toBeTruthy();
    unmount();
    render(<ProjectItemScreen id={CLOUD(99)} />);
    expect(await screen.findByText('This project isn’t saved to cloud any more')).toBeTruthy();
  });
});

describe('a Library resource', () => {
  it('shows its facts, notes, uses, its twin and its preview, and no cloud state; a file opens in the preview', async () => {
    const user = userEvent.setup();
    render(<ResourceItemScreen id={ID(1)} />);
    expect(await screen.findByRole('heading', { name: 'rar' })).toBeTruthy();
    expect(screen.getByText('Skill')).toBeTruthy();
    expect(screen.getByText('~/.claude/skills/skill-1')).toBeTruthy();
    expect(await screen.findByText('Used 17× in the last 90 days')).toBeTruthy();
    expect(screen.getByText(/12 typed by you · 5 by the agent · last used 2h ago/)).toBeTruthy();
    expect(screen.getByText(/Counted as \/rar · Uses count only the sessions shared with this phone/)).toBeTruthy();
    expect(await screen.findByText('Abbreviation')).toBeTruthy();
    expect(screen.getByText('#retouch')).toBeTruthy();
    const also = screen.getByRole('region', { name: 'Also in' });
    expect(within(also).getByText('Codex · Global')).toBeTruthy();
    expect(within(also).getByText('3 uses')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Retouch' })).toBeTruthy();
    expectReadOnly();

    await user.click(screen.getByRole('button', { name: /references\/notes\.md/ }));
    expect(await screen.findByText('The reference notes.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Main file' }));
    expect(await screen.findByRole('heading', { name: 'Retouch' })).toBeTruthy();

    expect(screen.queryByTestId('resource-cloud')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Cloud' })).toBeNull();
    expect(screen.queryByText(/Not saved to cloud|Synced/)).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/sync'))).toBe(false);
  });

  it('a rule says why it has no count; a config shows its fields with secrets hidden', async () => {
    const { unmount } = render(<ResourceItemScreen id={ID(5)} />);
    expect(await screen.findByText(/No use count: a rule loads into every session/)).toBeTruthy();
    unmount();
    render(<ResourceItemScreen id={ID(6)} />);
    expect(await screen.findByText('mcpServers.kason.env.API_KEY')).toBeTruthy();
    expect(screen.getByText('******')).toBeTruthy();
    expect(screen.getByText('npx')).toBeTruthy();
  });

  it('one the Mac doesn’t have, or doesn’t share, says so', async () => {
    render(<ResourceItemScreen id={ID(99)} />);
    expect(await screen.findByText('This resource isn’t here')).toBeTruthy();
  });
});

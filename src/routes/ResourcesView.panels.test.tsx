// ResourcesView.panels.test.tsx — the RESOURCES tab's Sources and Checks
// sub-tabs: roots, projects, coverage and added folders; findings grouped by
// severity and linked back to the Library.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, fireEvent, waitFor } from '@testing-library/react';
import {
  CATALOG,
  REPO_ONLY_PATH,
  stubApi,
  renderView,
  urlParams,
  ready,
  listRows,
  row,
  detail,
} from '@/__tests__/fixtures/resourceCatalog';

beforeEach(() => {
  stubApi();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

describe('ResourcesView — Sources', () => {
  it('lists roots, projects with evidence and flags, and grouped coverage', async () => {
    renderView('/resources?section=sources');
    await ready();
    const roots = screen.getByRole('region', { name: 'Roots' });
    expect(within(roots).getByText('~/.codex')).toBeInTheDocument();
    expect(within(roots).getByText('~/Documents/agent-skills')).toBeInTheDocument();

    const projects = screen.getByRole('region', { name: 'Projects' });
    const oldSite = within(projects).getByText('old-site').closest('tr') as HTMLElement;
    expect(oldSite).toHaveTextContent('missing');
    const worktree = within(projects).getByText('~/code/app/.claude/worktrees/feature-x').closest('tr') as HTMLElement;
    expect(worktree).toHaveTextContent('worktree of ~/code/app');
    expect(worktree).toHaveTextContent('duplicate name');
    const home = within(projects).getByText('me').closest('tr') as HTMLElement;
    expect(home).toHaveTextContent('home');
    const app = within(projects).getByText('~/code/app').closest('tr') as HTMLElement;
    expect(app).toHaveTextContent('AASC session');
    expect(app).toHaveTextContent('4');

    const coverage = screen.getByRole('region', { name: 'Coverage' });
    const claudeGroup = within(coverage).getByRole('table', { name: '~/.claude' });
    const sessions = within(claudeGroup).getByText('Sessions').closest('tr') as HTMLElement;
    expect(sessions).toHaveTextContent('not scanned');
    expect(sessions).toHaveTextContent('120 · 50.0 MB');
    expect(sessions).toHaveTextContent('Phase D — size only');
    const creds = within(claudeGroup).getByText('Credentials').closest('tr') as HTMLElement;
    expect(creds).toHaveTextContent('excluded');
    expect(creds).toHaveTextContent('names only, never read');
    expect(within(coverage).getByRole('table', { name: '~/.codex' })).toHaveTextContent('Plugin contents');
  });

  it('lists live projects before missing ones, and flags duplicate names only among live ones', async () => {
    const stale = (id: string, path: string) => ({
      id, name: 'a1', path, exists: false, duplicateName: true, evidence: ['claude-json' as const], counts: {},
    });
    stubApi({ catalogs: [{ ...CATALOG, projects: [...CATALOG.projects, stale('p-t1', '/tmp/one/a1'), stale('p-t2', '/tmp/two/a1')] }] });
    renderView('/resources?section=sources');
    await ready();

    const table = within(screen.getByRole('region', { name: 'Projects' })).getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    const missing = rows.map((r) => /missing/.test(r.textContent ?? ''));
    const firstMissing = missing.indexOf(true);
    expect(firstMissing).toBeGreaterThan(0);
    expect(missing.slice(firstMissing).every(Boolean)).toBe(true);

    const tmpRow = within(table).getByText('/tmp/one/a1').closest('tr') as HTMLElement;
    expect(tmpRow).not.toHaveTextContent('duplicate name');
    // Two live checkouts sharing a basename are still worth flagging.
    const worktree = within(table).getByText('~/code/app/.claude/worktrees/feature-x').closest('tr') as HTMLElement;
    expect(worktree).toHaveTextContent('duplicate name');
  });

  it('says so when no agent-skills repo was detected', async () => {
    stubApi({ catalogs: [{ ...CATALOG, roots: { ...CATALOG.roots, repo: null } }] });
    renderView('/resources?section=sources');
    await ready();
    expect(within(screen.getByRole('region', { name: 'Roots' })).getByText(/no agent-skills repo detected/i)).toBeInTheDocument();
  });

  it('links a project into the Library, landing on a type it actually has', async () => {
    renderView('/resources?section=sources');
    await ready();
    const link = screen.getByRole('link', { name: 'Show resources in app (~/code/app)' });
    expect(link).toHaveAttribute('href', '/resources?section=library&scope=project&project=p-app');
    fireEvent.click(link);
    const params = urlParams();
    expect(params.get('section')).toBe('library');
    expect(params.get('scope')).toBe('project');
    expect(params.get('project')).toBe('p-app');
    // No `type` in the link: the view opens the first type the project has.
    expect(listRows().map((b) => b.textContent)).toEqual([expect.stringMatching(/^app-helper/)]);
    // A project with nothing to show gets no link at all.
    fireEvent.click(screen.getByRole('tab', { name: 'Sources' }));
    expect(screen.queryByRole('link', { name: /Show resources in me/ })).not.toBeInTheDocument();
  });

  it('adds a folder: validates, stores it, sends it with Rescan, removes it', async () => {
    const fetchMock = stubApi();
    renderView('/resources?section=sources');
    await ready();
    const input = screen.getByLabelText('Folder path');

    fireEvent.change(input, { target: { value: 'code/app' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/absolute/i);
    expect(localStorage.getItem('aasc.resources.extraRoots')).toBeNull();

    fireEvent.change(input, { target: { value: '/Users/me/extra/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('/Users/me/extra')).toBeInTheDocument();
    expect(localStorage.getItem('aasc.resources.extraRoots')).toBe('["/Users/me/extra"]');

    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    const post = fetchMock.mock.calls.find(([u, init]) => u === '/api/resources/scan' && init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ extraRoots: ['/Users/me/extra'] });
    // Disabled from the click until the reload reports the (mock) scan done.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rescan' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Remove /Users/me/extra' }));
    expect(screen.queryByText('/Users/me/extra')).not.toBeInTheDocument();
    expect(localStorage.getItem('aasc.resources.extraRoots')).toBe('[]');
  });

  it('keeps working when localStorage throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('denied', 'SecurityError'); },
      setItem: () => { throw new DOMException('denied', 'SecurityError'); },
      removeItem: () => { throw new DOMException('denied', 'SecurityError'); },
      clear: () => {},
    });
    renderView('/resources?section=sources');
    await ready();
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '/Users/me/extra' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('/Users/me/extra')).toBeInTheDocument();
    expect(screen.getByText(/could not be saved/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

describe('ResourcesView — Checks', () => {
  it('groups findings by severity, then by code, with counts', async () => {
    renderView('/resources?section=checks');
    await ready();
    expect(screen.getByRole('heading', { name: 'Errors · 1' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Warnings · 3' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Info · 7' })).toBeInTheDocument();
    expect(screen.getByText('Differs from repo · 2')).toBeInTheDocument();
    expect(screen.getByText('Config parse error · 1')).toBeInTheDocument();
  });

  it('selects the resource behind a finding', async () => {
    renderView('/resources?section=checks&agent=codex&q=zzz');
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /old-skill.*Symlink target does not exist/ }));
    const params = urlParams();
    expect(params.get('section')).toBe('library');
    expect(params.get('type')).toBe('skill');
    expect(params.get('id')).toBe('sk-broken');
    // Filters that would hide the target are dropped.
    expect(params.get('agent')).toBeNull();
    expect(params.get('q')).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Search resources' })).toHaveValue('');
    expect(within(detail()).getByRole('heading', { name: 'old-skill', level: 2 })).toBeInTheDocument();
    expect(row(/^old-skill/)).toHaveAttribute('aria-current', 'true');
    // A broken symlink has no body to preview; its finding explains why.
    expect(await within(detail()).findByText(/No preview/)).toBeInTheDocument();
  });

  it('shows repo-only findings with their path, as plain text', async () => {
    renderView('/resources?section=checks');
    await ready();
    const path = screen.getByText(REPO_ONLY_PATH);
    expect(path.closest('button')).toBeNull();
  });
});

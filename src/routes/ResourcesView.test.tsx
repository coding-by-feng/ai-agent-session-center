// ResourcesView.test.tsx — the RESOURCES tab's Library (rail, filters, list,
// detail), end to end against a mocked /api/resources; the server half is its
// own suite. Siblings: ResourcesView.states.test.tsx (loading, scanning,
// errors, polling) and ResourcesView.panels.test.tsx (Sources, Checks). The
// shared fixture is src/__tests__/fixtures/resourceCatalog.ts.
//
// What this pins, beyond "it renders":
//  - the tab is READ-ONLY: every request goes to /api/resources, never to the
//    editable /api/files routes the PROJECT tab uses;
//  - zero-count types stay in the TYPE rail, and plugin/system items are
//    hidden AND uncounted until the toggle is on;
//  - masked config values render as ****** whatever the payload says;
//  - previews are inert, and the markdown renderer stays behind React.lazy.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router';
import ResourcesView from './ResourcesView';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  stubApi,
  urlsCalled,
  renderView,
  urlParams,
  ready,
  rail,
  railButton,
  railCounts,
  listRows,
  row,
  detail,
  LAZY,
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
// Shell
// ---------------------------------------------------------------------------

describe('ResourcesView — shell', () => {
  it('renders the title and exactly the Library / Sources / Checks sub-tabs', async () => {
    renderView();
    await ready();
    expect(screen.getByRole('heading', { name: /agent resources/i, level: 1 })).toBeInTheDocument();
    const tabs = within(screen.getByRole('tablist', { name: 'Resource sections' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Library', 'Sources', 'Checks']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    // Sync is Phase C and Data is Phase D — not even as disabled tabs.
    expect(screen.queryByRole('tab', { name: /sync/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /data/i })).not.toBeInTheDocument();
  });

  it('shows per-agent totals, the project count and the scan age', async () => {
    renderView();
    await ready();
    // 3, not 4: the fixture's missing `old-site` is listed in Sources, not counted as a project.
    expect(screen.getByText('16 claude · 5 codex · 1 shared · 3 projects · scanned 2m ago')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// TYPE rail and filters
// ---------------------------------------------------------------------------

describe('ResourcesView — TYPE rail', () => {
  it('lists all ten types in order with counts', async () => {
    renderView();
    await ready();
    expect(railCounts()).toEqual([
      'Skills 7', 'Commands 1', 'Rules 3', 'Instructions 2', 'Memory 2',
      'Agents 1', 'Hooks 1', 'MCP 1', 'Plugins 1', 'Settings 3',
    ]);
    expect(railButton('Skills')).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps zero-count types visible — "Instructions 0" is an answer', async () => {
    renderView('/resources?scope=global');
    await ready();
    expect(railButton('Instructions')).toHaveTextContent(/^Instructions\s*0$/);
    expect(railButton('Agents')).toHaveTextContent(/^Agents\s*0$/);
    expect(within(rail()).getAllByRole('button')).toHaveLength(10);
  });

  it('selecting a type updates the URL, the pressed state and the list heading', async () => {
    renderView();
    await ready();
    fireEvent.click(railButton('Rules'));
    expect(urlParams().get('type')).toBe('rule');
    expect(railButton('Rules')).toHaveAttribute('aria-pressed', 'true');
    expect(railButton('Skills')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('heading', { name: 'Rules · 3' })).toBeInTheDocument();
    expect(listRows()).toHaveLength(3);
  });

  it('names what came up empty', async () => {
    renderView('/resources?type=agent&agent=claude&scope=global');
    await ready();
    expect(screen.getByText('No agents in Claude · Global')).toBeInTheDocument();
    expect(listRows()).toHaveLength(0);
  });
});

describe('ResourcesView — filters', () => {
  it('hides plugin & system items, uncounted, until the toggle is on', async () => {
    renderView();
    await ready();
    expect(railButton('Skills')).toHaveTextContent(/7$/);
    expect(screen.queryByRole('button', { name: /^github-review/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^imagegen/ })).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Show plugin & system' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(urlParams().get('plugins')).toBe('1');
    expect(railButton('Skills')).toHaveTextContent(/9$/);
    expect(row(/^github-review/)).toHaveTextContent('plugin');
    expect(row(/^imagegen/)).toHaveTextContent('system');
    expect(screen.getByText(/^17 claude · 6 codex · 1 shared/)).toBeInTheDocument();
  });

  it('filters by agent', async () => {
    renderView();
    await ready();
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex' } });
    expect(urlParams().get('agent')).toBe('codex');
    expect(railButton('Skills')).toHaveTextContent(/1$/);
    expect(listRows().map((b) => b.textContent)).toEqual([expect.stringMatching(/^tdd Codex/)]);
  });

  it('shows a project picker for the Project scope, built from the catalog', async () => {
    renderView();
    await ready();
    expect(screen.queryByLabelText('Project')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'project' } });
    const picker = screen.getByLabelText('Project') as HTMLSelectElement;
    const labels = Array.from(picker.options).map((o) => o.textContent);
    expect(labels[0]).toBe('All projects');
    // Two projects share the basename "app" — the picker disambiguates them.
    expect(labels).toEqual(expect.arrayContaining([
      'app — ~/code/app', 'app — ~/code/app/.claude/worktrees/feature-x', 'old-site', 'me',
    ]));
    fireEvent.change(picker, { target: { value: 'p-app' } });
    expect(urlParams().get('scope')).toBe('project');
    expect(urlParams().get('project')).toBe('p-app');
    expect(listRows().map((b) => b.textContent)).toEqual([expect.stringMatching(/^app-helper/)]);
  });

  it('honours a bare ?project=<id> deep link', async () => {
    renderView('/resources?project=p-app&type=instructions');
    await ready();
    expect(screen.getByLabelText('Scope')).toHaveValue('project');
    expect(screen.getByLabelText('Project')).toHaveValue('p-app');
    expect(listRows().map((b) => b.textContent)).toEqual([
      expect.stringMatching(/^AGENTS\.md Codex app/),
      expect.stringMatching(/^CLAUDE\.md Claude app/),
    ]);
  });

  it('searches name, description and path, and keeps the query in the URL', async () => {
    renderView();
    await ready();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search resources' }), { target: { value: 'driven' } });
    expect(urlParams().get('q')).toBe('driven');
    expect(listRows().map((b) => b.textContent)).toEqual([expect.stringMatching(/^tdd Claude/)]);
    expect(railButton('Rules')).toHaveTextContent(/0$/);
    expect(screen.getByRole('searchbox', { name: 'Search resources' })).toHaveValue('driven');
  });

  it('composes URL writes that land before the previous one has committed', async () => {
    renderView();
    await ready();
    const box = screen.getByRole('searchbox', { name: 'Search resources' });
    const target = row(/^tdd Claude/);
    // Navigations commit inside startTransition; two events in one act run the
    // second handler before the first navigation is rendered.
    act(() => {
      fireEvent.change(box, { target: { value: 'tdd' } });
      fireEvent.click(target);
    });
    expect(urlParams().get('q')).toBe('tdd');
    expect(urlParams().get('id')).toBe('sk-claude-tdd');
    expect(box).toHaveValue('tdd');
    await within(detail()).findByRole('tab', { name: 'Preview' });
  });
});

// ---------------------------------------------------------------------------
// List rows
// ---------------------------------------------------------------------------

describe('ResourcesView — list rows', () => {
  it('badges agent, scope, origin, repo status and variant drift', async () => {
    renderView();
    await ready();
    const claudeTdd = row(/^tdd Claude/);
    expect(claudeTdd).toHaveTextContent('Global');
    expect(claudeTdd).toHaveTextContent('differs');
    expect(claudeTdd).toHaveTextContent('≠ variant');
    expect(claudeTdd).toHaveTextContent('Test-driven development workflow');

    expect(row(/^tdd Codex/)).toHaveTextContent('same');

    const research = row(/^research/);
    expect(research).toHaveTextContent('linked');
    expect(research).toHaveTextContent('not in repo');

    // not-tracked: no repo chip at all.
    const brand = row(/^brand-voice/);
    expect(brand).toHaveTextContent('synced');
    expect(brand).not.toHaveTextContent(/same|differs|not in repo/);

    expect(row(/^app-helper/)).toHaveTextContent('app');
  });

  it('tags orphaned memory', async () => {
    renderView('/resources?type=memory');
    await ready();
    const orphan = row(/^MEMORY\.md/);
    expect(orphan).toHaveTextContent('orphaned');
    expect(orphan).toHaveTextContent('old-site');
    expect(row(/^notes\.md/)).not.toHaveTextContent('orphaned');
  });
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

describe('ResourcesView — detail', () => {
  it('opens a skill: header, frontmatter card, lazily rendered markdown, findings', async () => {
    const { container } = renderView();
    await ready();
    fireEvent.click(row(/^tdd Claude/));
    expect(urlParams().get('id')).toBe('sk-claude-tdd');

    const pane = detail();
    expect(within(pane).getByRole('heading', { name: 'tdd', level: 2 })).toBeInTheDocument();
    expect(within(pane).getByText('Skill')).toBeInTheDocument();
    expect(within(pane).getByText('Claude · Global · user')).toBeInTheDocument();
    expect(within(pane).getByText('~/.claude/skills/tdd')).toBeInTheDocument();

    // Rendered markdown arrives through React.lazy.
    expect(await within(pane).findByRole('heading', { name: 'TDD workflow', level: 1 }, LAZY)).toBeInTheDocument();
    const card = within(pane).getByRole('region', { name: 'Frontmatter' });
    expect(within(card).getByText('allowed-tools')).toBeInTheDocument();
    expect(within(card).getByText('Read, Edit')).toBeInTheDocument();
    expect(within(card).getByText('Test-driven development workflow')).toBeInTheDocument();
    // Frontmatter is a card, never a pair of <hr>s around key: value text.
    expect(container.querySelector('hr')).toBeNull();
    // Highlighted code is split into token spans — compare the block's text.
    expect(pane.querySelector('pre code')?.textContent).toContain('expect(sum(1, 2)).toBe(3);');

    const findings = within(pane).getByRole('region', { name: 'Findings' });
    expect(within(findings).getByText('Differs from repo')).toBeInTheDocument();
    expect(within(findings).getByText('Claude and Codex copies differ')).toBeInTheDocument();
  });

  it('jumps to a variant from the detail header', async () => {
    renderView('/resources?id=sk-claude-tdd');
    await ready();
    fireEvent.click(within(detail()).getByRole('button', { name: 'Codex · Global' }));
    expect(urlParams().get('id')).toBe('sk-codex-tdd');
    expect(within(detail()).getByText('Codex · Global · user')).toBeInTheDocument();
    await within(detail()).findByRole('tab', { name: 'Preview' });
  });

  it('shows where a linked skill really points', async () => {
    renderView('/resources?id=sk-research');
    await ready();
    expect(within(detail()).getByText('~/Documents/other-repo/skills/research')).toBeInTheDocument();
    expect(within(detail()).getByText('Claude · Global · linked')).toBeInTheDocument();
  });

  it('reports invalid frontmatter in the card and never renders the raw block', async () => {
    const { container } = renderView('/resources?id=sk-brand');
    await ready();
    const pane = detail();
    expect(await within(pane).findByRole('heading', { name: 'Brand voice' }, LAZY)).toBeInTheDocument();
    const card = within(pane).getByRole('region', { name: 'Frontmatter' });
    expect(within(card).getByText(/bad indentation of a mapping entry/)).toBeInTheDocument();
    expect(within(pane).queryByText(/name: \[oops/)).not.toBeInTheDocument();
    expect(container.querySelector('hr')).toBeNull();
  });

  it('keeps a body that opens with a markdown rule — the server already stripped the frontmatter', async () => {
    const { container } = renderView('/resources?id=sk-codex-tdd');
    await ready();
    expect(await within(detail()).findByRole('heading', { name: 'TDD', level: 1 }, LAZY)).toBeInTheDocument();
    expect(within(detail()).getByText('Intro kept.')).toBeInTheDocument();
    expect(container.querySelectorAll('hr')).toHaveLength(2);
  });

  it('renders untrusted markdown inertly: no images, no raw HTML, no in-app or script links', async () => {
    renderView('/resources?id=sk-evil');
    await ready();
    const pane = detail();
    await within(pane).findByRole('heading', { name: 'Evil', level: 1 }, LAZY);
    expect(pane.querySelector('img')).toBeNull();
    expect(pane.querySelector('script')).toBeNull();
    expect(pane.querySelector('[onerror]')).toBeNull();
    expect(within(pane).getByText('[image: remote]')).toBeInTheDocument();
    const links = Array.from(pane.querySelectorAll('a'));
    // Only the absolute external link is clickable — and it opens outside the app.
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/docs']);
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
    // Loopback links (127.0.0.1, [::1], localhost on any port) reach this
    // machine: under Electron the app's own port opens an in-app window.
    for (const text of ['run', 'self', 'relative', 'ipv4', 'ipv6', 'devserver']) {
      expect(within(pane).getByText(text).closest('a'), text).toBeNull();
    }
  });

  it('keeps the markdown renderer behind React.lazy', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const detailSource = read('../components/resources/ResourceDetail.tsx');
    expect(detailSource).toMatch(/lazy\(\(\) => import\('\.\/ResourceMarkdown'\)\)/);
    const eagerFiles = [
      './ResourcesView.tsx',
      '../components/resources/ResourceDetail.tsx',
      '../components/resources/ResourceList.tsx',
      '../components/resources/ResourceTypeRail.tsx',
      '../components/resources/ConfigDetail.tsx',
      '../components/resources/ResourceCompare.tsx',
      '../components/resources/SourcesPanel.tsx',
      '../components/resources/ChecksPanel.tsx',
    ];
    for (const file of eagerFiles) {
      const source = read(file);
      expect(source, file).not.toMatch(/^import[^;]*ResourceMarkdown/m);
      expect(source, file).not.toMatch(/from '(react-markdown|remark-gfm|rehype-highlight)'/);
    }
  });

  it('masks config values as ****** with a "masked" chip — even if the payload leaked one', async () => {
    renderView('/resources?type=mcp&id=mcp-kason');
    await ready();
    const pane = detail();
    const table = await within(pane).findByRole('table');
    expect(within(table).getByText('stdio')).toBeInTheDocument();
    expect(within(table).getByText('env.API_KEY')).toBeInTheDocument();
    expect(within(table).getAllByText('******')).toHaveLength(2);
    expect(within(table).getAllByText('masked')).toHaveLength(2);
    expect(screen.queryByText(/ghp_shouldNeverRender/)).not.toBeInTheDocument();
  });

  it('renders a Codex policy as text, with the note that it is not a Claude rule', async () => {
    renderView('/resources?type=rule&id=rule-codex');
    await ready();
    const pane = detail();
    expect(await within(pane).findByText(/prefix_rule\(pattern/)).toBeInTheDocument();
    expect(within(pane).getByText('Codex exec-approval policy — not the same thing as Claude rules.')).toBeInTheDocument();
    expect(within(pane).getByText(/prefix_rule\(pattern/).tagName).toBe('PRE');
  });

  it('Files: lists the package and opens a text file read-only', async () => {
    const fetchMock = stubApi();
    renderView('/resources?id=sk-claude-tdd');
    await ready();
    const pane = detail();
    fireEvent.click(await within(pane).findByRole('tab', { name: 'Files' }));

    const files = within(pane).getByRole('list', { name: 'Package files' });
    expect(within(files).getByText('200 B')).toBeInTheDocument();
    // Binary files are listed but cannot be opened.
    expect(within(files).queryByRole('button', { name: /logo\.png/ })).not.toBeInTheDocument();
    expect(within(files).getByText('assets/logo.png')).toBeInTheDocument();
    expect(within(files).getByText('binary')).toBeInTheDocument();

    fireEvent.click(within(files).getByRole('button', { name: /references\/checklist\.md/ }));
    const content = await within(pane).findByText(/- \[ \] red/);
    expect(content.tagName).toBe('PRE');
    expect(urlsCalled(fetchMock)).toContain('/api/resources/item/sk-claude-tdd/file?path=references%2Fchecklist.md');

    // A 404 here means the file went away since the scan — not "only on this machine".
    fireEvent.click(within(files).getByRole('button', { name: /references\/gone\.md/ }));
    expect(await within(pane).findByText(/no longer there — rescan/i)).toBeInTheDocument();
    expect(within(pane).queryByText(/only on the machine/)).not.toBeInTheDocument();
  });

  it('Compare: file statuses and a coloured patch, for the repo and for a variant', async () => {
    const fetchMock = stubApi();
    const { container } = renderView('/resources?id=sk-claude-tdd');
    await ready();
    const pane = detail();
    fireEvent.click(await within(pane).findByRole('tab', { name: 'Compare' }));

    const select = within(pane).getByLabelText('Compare with') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['agent-skills repo', 'Codex · Global']);
    const statuses = await within(pane).findByRole('list', { name: 'Compared files' });
    expect(within(statuses).getByText('changed')).toBeInTheDocument();
    // "only-left" is the wire value; the list names the side it is on.
    expect(within(statuses).getByText('only in Live')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-kind="add"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-kind="del"]')).toHaveLength(1);
    expect(container.querySelector('[data-kind="add"]')).toHaveTextContent('+Write the test first.');

    fireEvent.change(select, { target: { value: 'sk-codex-tdd' } });
    expect(await within(pane).findByText('+# TDD')).toBeInTheDocument();
    expect(urlsCalled(fetchMock)).toContain('/api/resources/item/sk-claude-tdd/compare?against=sk-codex-tdd');
  });

  it('offers Files and Compare only when there is something to show', async () => {
    renderView('/resources?type=mcp&id=mcp-kason');
    await ready();
    const pane = detail();
    await within(pane).findByRole('table');
    expect(within(pane).getByRole('tab', { name: 'Preview' })).toBeInTheDocument();
    expect(within(pane).queryByRole('tab', { name: 'Files' })).not.toBeInTheDocument();
    expect(within(pane).queryByRole('tab', { name: 'Compare' })).not.toBeInTheDocument();
  });

  it('an id the server no longer knows is "not found", not "unavailable"', async () => {
    renderView('/resources?id=gone');
    await ready();
    expect(await within(detail()).findByText(/no longer in the catalog/i)).toBeInTheDocument();
    expect(screen.queryByText(/available only on this machine/)).not.toBeInTheDocument();
  });

  it('closes the detail with the back button', async () => {
    renderView('/resources?id=sk-research');
    await ready();
    fireEvent.click(within(detail()).getByRole('button', { name: 'Back to list' }));
    expect(urlParams().get('id')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Resource detail' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Read-only
// ---------------------------------------------------------------------------

describe('ResourcesView — read-only', () => {
  it('never calls the editable /api/files routes', async () => {
    const fetchMock = stubApi();
    renderView('/resources?id=sk-claude-tdd');
    await ready();
    const pane = detail();
    fireEvent.click(await within(pane).findByRole('tab', { name: 'Files' }));
    fireEvent.click(within(pane).getByRole('button', { name: /references\/checklist\.md/ }));
    await within(pane).findByText(/- \[ \] red/);
    fireEvent.click(within(pane).getByRole('tab', { name: 'Compare' }));
    await within(pane).findByRole('list', { name: 'Compared files' });
    for (const url of urlsCalled(fetchMock)) expect(url).toMatch(/^\/api\/resources(\/|$)/);
  });
});

// ---------------------------------------------------------------------------
// URL state across navigation that the view did not make
// ---------------------------------------------------------------------------

// The NavBar's RESOURCES link and the browser's Back both change the URL from
// OUTSIDE the view. A URL write the view made earlier must not come back to
// life when the URL happens to return to the value that write started from.

function NavControls() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate('/resources')}>nav: RESOURCES tab</button>
      <button type="button" onClick={() => navigate(-1)}>nav: back</button>
    </>
  );
}

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{location.search}</div>;
}

function renderWithNav(path = '/resources') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/resources" element={<ResourcesView />} />
      </Routes>
      <NavControls />
      <Probe />
    </MemoryRouter>,
  );
}

describe('ResourcesView — list scroll', () => {
  it('opens a newly picked type at the top of its list, not at the old scroll offset', async () => {
    renderView();
    await ready();
    const pane = () => screen.getByRole('list', { name: 'Resources' }).closest('section') as HTMLElement;
    // jsdom keeps no scroll state of its own; give this element one.
    let top = 0;
    Object.defineProperty(pane(), 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => { top = value; },
    });
    pane().scrollTop = 480;

    fireEvent.click(railButton('Memory'));
    await waitFor(() => expect(within(pane()).getByRole('heading')).toHaveTextContent(/^Memory/));
    expect(pane().scrollTop).toBe(0);
  });
});

describe('ResourcesView — URL state after outside navigation', () => {
  it('a filter change after the RESOURCES nav tab does not resurrect an earlier sub-tab', async () => {
    renderWithNav();
    await ready();
    fireEvent.click(screen.getByRole('tab', { name: 'Sources' }));
    await waitFor(() => expect(urlParams().get('section')).toBe('sources'));

    fireEvent.click(screen.getByRole('button', { name: 'nav: RESOURCES tab' }));
    await waitFor(() => expect(urlParams().toString()).toBe(''));

    fireEvent.click(await screen.findByRole('button', { name: /Show plugin/ }));
    await waitFor(() => expect(urlParams().get('plugins')).toBe('1'));
    expect(urlParams().get('section')).toBeNull();
  });

  it('a filter change after Back does not reopen the resource Back closed', async () => {
    renderWithNav();
    await ready();
    fireEvent.click(row(/^tdd Claude/));
    await waitFor(() => expect(urlParams().get('id')).toBe('sk-claude-tdd'));

    fireEvent.click(screen.getByRole('button', { name: 'nav: back' }));
    await waitFor(() => expect(urlParams().get('id')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Show plugin/ }));
    await waitFor(() => expect(urlParams().get('plugins')).toBe('1'));
    expect(urlParams().get('id')).toBeNull();
  });
});

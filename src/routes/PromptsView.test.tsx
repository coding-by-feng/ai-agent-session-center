// PromptsView.test.tsx — the PROMPTS tab as the user meets it: the toolbar and
// the Source facet, the summary line, day groups, row actions, the load /
// error / empty states and paging. The server half (facet SQL, LIKE escaping,
// paging) is test/searchPrompts.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, configure, render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DistinctProject, PromptSearchResponse, PromptTraceRow, Session } from '@/types';

const { authFetch } = vi.hoisted(() => ({
  authFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock('@/hooks/useAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAuth')>()),
  authFetch,
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import PromptsView from './PromptsView';
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';
import { usePromptSnippetStore } from '@/stores/promptSnippetStore';

// The search box debounces 300 ms and the whole suite runs in parallel with the
// rest of the client project, so the 1 s default is too tight on a busy machine.
configure({ asyncUtilTimeout: 4000 });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Local-time constructors, so the day and clock a row shows hold in any TZ. */
const THIS_YEAR = new Date().getFullYear();
const RECENT = new Date(THIS_YEAR, 5, 15, 14, 5, 9).getTime();
const RECENT_DAY = new Date(RECENT).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
/** Wednesday, a year that is not the current one, and just after midnight. */
const OLD = new Date(2020, 2, 4, 0, 30, 45).getTime();
const OLD_DAY = 'Wed, Mar 4, 2020';

const PROJECTS: DistinctProject[] = [
  { project_path: '/work/alpha', project_name: 'alpha' },
  { project_path: '/work/beta', project_name: 'beta' },
];

function row(id: number, text: string, over: Partial<PromptTraceRow> = {}): PromptTraceRow {
  return {
    id,
    session_id: `s${id}`,
    text,
    timestamp: RECENT - id * 60_000,
    project_name: 'alpha',
    project_path: '/work/alpha',
    session_title: 'Fix the build',
    ...over,
  };
}

function page(prompts: PromptTraceRow[], over: Partial<PromptSearchResponse> = {}): PromptSearchResponse {
  return { prompts, total: prompts.length, page: 1, pageSize: 50, ...over };
}

function reply(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** What GET /api/db/prompts answers; each test replaces it. */
let promptsReply: (url: URL) => Response | Promise<Response>;

function promptCalls(): URL[] {
  return authFetch.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter((url) => url.pathname === '/api/db/prompts');
}
const lastCall = (): URL => promptCalls().at(-1)!;

function liveSession(id: string): Session {
  return { sessionId: id } as Session;
}

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/prompts']}>
        <Routes>
          <Route path="/prompts" element={<PromptsView />} />
          <Route path="/" element={<div data-testid="board" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Renders and waits for the first rows to be on screen. */
async function renderLoaded() {
  const view = renderView();
  await screen.findAllByRole('listitem');
  return view;
}

const source = () => screen.getByRole('group', { name: 'Source' });
const sourceButton = (name: string) => within(source()).getByRole('button', { name });
/** The summary line: the <p> in the unit beside the Source group. */
const summaryText = () => source().nextElementSibling?.querySelector('p')?.textContent;

const originalSave = usePromptSnippetStore.getState().save;
// jsdom has no clipboard; tests that need one install it and this puts it back.
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}

beforeEach(() => {
  authFetch.mockReset();
  authFetch.mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/db/projects') return reply(200, PROJECTS);
    if (url.pathname === '/api/db/prompts') return promptsReply(url);
    throw new Error(`unexpected request ${String(input)}`);
  });
  promptsReply = () => reply(200, page([row(1, 'Fix the build')]));
  vi.mocked(showToast).mockClear();
  useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
});

afterEach(() => {
  // Rows are still mounted here (RTL unmounts after this hook), and they
  // subscribe to `save`: swapping it back is a store update, so it needs act.
  act(() => usePromptSnippetStore.setState({ save: originalSave }));
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('PromptsView — toolbar', () => {
  it('keeps its test id and names every control', async () => {
    renderView();
    expect(screen.getByTestId('prompts-view')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search all prompts' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Project' })).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('To')).toHaveAttribute('type', 'date');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    await screen.findAllByRole('listitem');
  });

  it('lists the projects as native options and queries the chosen one', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const select = screen.getByRole('combobox', { name: 'Project' });
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['All', 'alpha', 'beta']);

    await user.selectOptions(select, 'beta');
    await waitFor(() => expect(lastCall().searchParams.get('project')).toBe('/work/beta'));
    expect(lastCall().searchParams.get('page')).toBe('1');
  });

  it('turns a date into a bound on the query', async () => {
    await renderLoaded();
    // Both ends are LOCAL time: a bare 'YYYY-MM-DD' parses as UTC midnight,
    // which at GMT+13 dropped the From day's prompts before 13:00.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    await waitFor(() => expect(lastCall().searchParams.get('dateFrom')).toBe(String(new Date(2026, 9, 1).getTime())));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-07' } });
    await waitFor(() => expect(lastCall().searchParams.get('dateTo')).toBe(String(new Date('2026-10-07T23:59:59').getTime())));
  });

  it('keeps the Refresh label while a request is in flight, and marks the button busy', async () => {
    const gate = deferred<Response>();
    promptsReply = () => gate.promise;
    renderView();

    const refresh = screen.getByRole('button', { name: 'Refresh' });
    expect(refresh).toHaveAttribute('aria-busy', 'true');
    expect(refresh).toHaveTextContent('Refresh');

    gate.resolve(reply(200, page([row(1, 'hi')])));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).not.toHaveAttribute('aria-busy'));
  });

  it('stays focusable while busy (never disabled), and ignores a press until the reload lands', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const gate = deferred<Response>();
    promptsReply = () => gate.promise;
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    refresh.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(refresh).toHaveAttribute('aria-busy', 'true'));
    // A disabled button would have dropped focus to <body> here.
    expect(refresh).toBeEnabled();
    expect(refresh).toHaveFocus();

    const before = promptCalls().length;
    await user.keyboard('{Enter}');
    expect(promptCalls().length).toBe(before);

    gate.resolve(reply(200, page([row(1, 'hi')])));
    await waitFor(() => expect(refresh).not.toHaveAttribute('aria-busy'));
  });

  it('Refresh asks the server again', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const before = promptCalls().length;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(promptCalls().length).toBe(before + 1));
  });

  it('exports the page on screen, and only when there is one', async () => {
    promptsReply = () => reply(200, page([row(1, 'hi')], { total: 120 }));
    // jsdom has no object URLs; the view builds one to download the JSON.
    const exported: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => { exported.push(blob); return 'blob:prompts'; },
      revokeObjectURL: vi.fn(),
    });
    let downloadName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });

    try {
      renderView();
      expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
      await screen.findAllByRole('listitem');
      fireEvent.click(screen.getByRole('button', { name: 'Export' }));

      expect(downloadName).toBe('prompts-page1.json');
      const payload = JSON.parse(await exported[0].text());
      expect(payload).toMatchObject({ schema: 'aasc-prompt-trace', version: 1, count: 1, totalMatching: 120 });
    } finally {
      Reflect.deleteProperty(URL, 'createObjectURL');
      Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });
});

describe('PromptsView — Source facet', () => {
  it('is a labelled group of toggle buttons with Mine pressed', async () => {
    await renderLoaded();
    expect(within(source()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Mine', '/Cmd', 'Agent', 'All']);
    expect(sourceButton('Mine')).toHaveAttribute('aria-pressed', 'true');
    for (const name of ['/Cmd', 'Agent', 'All']) {
      expect(sourceButton(name)).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('keeps each pill\'s explanation as its title', async () => {
    await renderLoaded();
    expect(sourceButton('Agent')).toHaveAttribute('title', expect.stringContaining('Harness-injected'));
    expect(sourceButton('/Cmd')).toHaveAttribute('title', expect.stringContaining('$skill'));
    expect(sourceButton('All')).toHaveAttribute('title', 'Every recorded row, unfiltered');
  });

  it('moves the pressed state, queries that source, and returns to page 1', async () => {
    promptsReply = () => reply(200, page([row(1, 'hi')], { total: 120 }));
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(within(screen.getByRole('navigation', { name: 'Prompt pages' })).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastCall().searchParams.get('page')).toBe('2'));

    await user.click(sourceButton('/Cmd'));
    expect(sourceButton('/Cmd')).toHaveAttribute('aria-pressed', 'true');
    expect(sourceButton('Mine')).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(lastCall().searchParams.get('kind')).toBe('cmd'));
    expect(lastCall().searchParams.get('page')).toBe('1');
  });
});

describe('PromptsView — summary line', () => {
  it.each([
    [1, 'a', '1 prompt · showing 1–1'],
    [2, 'b', '2 prompts · showing 1–2'],
  ])('says "%i" with the right plural', async (count, _label, expected) => {
    promptsReply = () => reply(200, page(Array.from({ length: count }, (_, i) => row(i + 1, `p${i}`))));
    await renderLoaded();
    expect(summaryText()).toBe(expected);
  });

  it('groups thousands and shows the range on the current page', async () => {
    promptsReply = () => reply(200, page([row(1, 'hi')], { total: 1234 }));
    await renderLoaded();
    // The view formats with the runtime's locale, so the expectation does too.
    expect(summaryText()).toBe(`${(1234).toLocaleString()} prompts · showing 1–50`);
  });

  it('offers Clear filters only once a filter is set, and clears them all', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();

    await user.click(sourceButton('All'));
    await user.type(screen.getByRole('textbox', { name: 'Search all prompts' }), 'build');
    await waitFor(() => expect(lastCall().searchParams.get('query')).toBe('build'));

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(sourceButton('Mine')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Search all prompts' })).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    await waitFor(() => expect(lastCall().searchParams.get('query')).toBeNull());
    expect(lastCall().searchParams.get('kind')).toBe('mine');
  });
});

describe('PromptsView — day groups and rows', () => {
  beforeEach(() => {
    promptsReply = () => reply(200, page([
      row(1, 'first today'),
      row(2, 'second today'),
      row(3, 'long ago', { timestamp: OLD }),
    ]));
  });

  it('heads each day with how many of its rows are on this page, naming the year only when it is not the current one', async () => {
    await renderLoaded();
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings).toHaveLength(2);
    expect(within(headings[0]).getByText(RECENT_DAY)).toBeInTheDocument();
    expect(within(headings[0]).getByText('2 shown')).toBeInTheDocument();
    expect(headings[0].textContent).not.toMatch(/\d{4}/);
    expect(within(headings[1]).getByText(OLD_DAY)).toBeInTheDocument();
    expect(within(headings[1]).getByText('1 shown')).toBeInTheDocument();
  });

  it('lists each day\'s rows under it', async () => {
    await renderLoaded();
    const today = screen.getByRole('list', { name: `Prompts on ${RECENT_DAY}` });
    expect(within(today).getAllByRole('listitem')).toHaveLength(2);
    expect(within(screen.getByRole('list', { name: `Prompts on ${OLD_DAY}` })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows the time without seconds (midnight as 00:xx) and the exact time on hover', async () => {
    await renderLoaded();
    const old = within(screen.getByRole('list', { name: `Prompts on ${OLD_DAY}` })).getByText('00:30');
    expect(old.tagName).toBe('TIME');
    expect(old).toHaveAttribute('title', expect.stringContaining('00:30:45'));
    expect(screen.getAllByText('00:30')).toHaveLength(1);
  });

  it('marks only a session still on the dashboard as live, and offers Open only there', async () => {
    useSessionStore.setState({ sessions: new Map([['s1', liveSession('s1')]]) });
    await renderLoaded();
    expect(screen.getAllByText('live')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Open this session' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Copy prompt' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Save to your prompts' })).toHaveLength(3);
  });

  it('keeps Copy and Save last in every row, with Open (live rows only) in front of them', async () => {
    // Open leads so the always-present pair holds one column down the list
    // whether or not a row has it; trailing, it would shift them left on live rows.
    useSessionStore.setState({ sessions: new Map([['s1', liveSession('s1')]]) });
    await renderLoaded();
    const actions = (li: HTMLElement) => within(li).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    const [live, dead] = screen.getAllByRole('listitem');
    expect(actions(live)).toEqual(['Open this session', 'Copy prompt', 'Save to your prompts']);
    expect(actions(dead)).toEqual(['Copy prompt', 'Save to your prompts']);
  });

  it('Open selects that session and goes to the board', async () => {
    useSessionStore.setState({ sessions: new Map([['s1', liveSession('s1')]]) });
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Open this session' }));
    expect(useSessionStore.getState().selectedSessionId).toBe('s1');
    expect(screen.getByTestId('board')).toBeInTheDocument();
  });

  it('labels the project and the session, falling back when the session row is gone', async () => {
    promptsReply = () => reply(200, page([
      row(1, 'orphan', { project_name: null, project_path: null, session_title: null }),
    ]));
    await renderLoaded();
    expect(screen.getByText('unknown project')).toBeInTheDocument();
    expect(screen.getByText('Unnamed')).toBeInTheDocument();
  });
});

describe('PromptsView — row actions', () => {
  const LONG = `start ${'x'.repeat(700)} end`;

  it("describes each action by the row's time, project and session, so a list of them is not N identical buttons", async () => {
    useSessionStore.setState({ sessions: new Map([['s1', liveSession('s1')]]) });
    await renderLoaded();
    const item = screen.getAllByRole('listitem')[0];
    for (const name of ['Open this session', 'Copy prompt', 'Save to your prompts']) {
      expect(within(item).getByRole('button', { name })).toHaveAccessibleDescription(/^\d{2}:\d{2} alpha Fix the build$/);
    }
  });

  it('copies the whole prompt, not the clamped text', async () => {
    promptsReply = () => reply(200, page([row(1, LONG)]));
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    await renderLoaded();
    stubClipboard(writeText);

    await user.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(writeText).toHaveBeenCalledWith(LONG);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Prompt copied', 'success'));
  });

  it('says so when the clipboard refuses', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    await user.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not copy to clipboard', 'error'));
  });

  it('says so when the save wrote nothing, instead of "Saved"', async () => {
    usePromptSnippetStore.setState({ save: vi.fn().mockResolvedValue({ id: null, duplicate: false }) });
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Save to your prompts' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not save this prompt', 'error'));
    expect(showToast).not.toHaveBeenCalledWith('Saved to your prompts', 'success');
  });

  it.each([
    [false, 'Saved to your prompts', 'success'],
    [true, 'Already in your saved prompts', 'info'],
  ])('saves to the prompt library (duplicate: %s)', async (duplicate, message, tone) => {
    const save = vi.fn().mockResolvedValue({ id: 1, duplicate });
    usePromptSnippetStore.setState({ save });
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Save to your prompts' }));
    expect(save).toHaveBeenCalledWith('Fix the build');
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(message, tone));
  });

  it('clamps a long prompt, and Show all / Show less toggles it', async () => {
    promptsReply = () => reply(200, page([row(1, LONG)]));
    const user = userEvent.setup();
    await renderLoaded();

    expect(screen.queryByText(LONG)).not.toBeInTheDocument();
    const showAll = screen.getByRole('button', { name: `Show all (${LONG.length.toLocaleString()} chars)` });
    await user.click(showAll);
    expect(screen.getByText(LONG)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText(LONG)).not.toBeInTheDocument();
  });

  it('has no Show all for a prompt that fits', async () => {
    await renderLoaded();
    expect(screen.queryByRole('button', { name: /Show all|Show less/ })).not.toBeInTheDocument();
  });

  it('highlights the query, and windows a long prompt around the hit instead of its start', async () => {
    const deep = `${'a'.repeat(900)} needle ${'b'.repeat(900)}`;
    promptsReply = () => reply(200, page([row(1, deep)]));
    const user = userEvent.setup();
    await renderLoaded();
    expect(screen.queryByText('needle', { selector: 'mark' })).not.toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Search all prompts' }), 'Needle');
    const mark = await screen.findByText('needle', { selector: 'mark' });
    const text = mark.parentElement!.textContent ?? '';
    expect(text.startsWith('…')).toBe(true);
    expect(text.length).toBeLessThan(600);
    expect(text).toContain('needle');
  });
});

describe('PromptsView — states', () => {
  it('says it is loading, and says so to assistive tech', () => {
    promptsReply = () => new Promise<Response>(() => {});
    renderView();
    const loading = screen.getByText('Loading prompts…').closest('[role="status"]');
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(summaryText()).toBe('Loading…');
  });

  it('shows an alert with Retry when the request fails, and Retry loads the rows', async () => {
    let calls = 0;
    promptsReply = () => (++calls === 1 ? reply(500, {}) : reply(200, page([row(1, 'recovered')])));
    const user = userEvent.setup();
    renderView();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load prompts.');
    // The summary does not claim "No prompts" beside the error.
    expect(summaryText()).toBe('');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('recovered')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the rows when a refresh fails, says they are stale, and Retry recovers', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    promptsReply = () => reply(500, {});
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    const note = await screen.findByRole('alert');
    expect(note).toHaveTextContent("Couldn't refresh. Showing the last results.");
    // The rows and their count stay: this is not the full-page error state.
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText('Could not load prompts.')).not.toBeInTheDocument();
    expect(summaryText()).toBe('1 prompt · showing 1–1');

    promptsReply = () => reply(200, page([row(1, 'Fix the build')]));
    await user.click(within(note).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it("passes on the server's own reason, and offers no Retry for a refusal", async () => {
    promptsReply = () => reply(403, { error: 'Prompt history is only available on the host machine' });
    renderView();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load prompts.');
    expect(alert).toHaveTextContent('Prompt history is only available on the host machine');
    expect(within(alert).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('says nothing is recorded yet when there are no prompts and no filter', async () => {
    promptsReply = () => reply(200, page([]));
    renderView();
    expect(await screen.findByText('No prompts recorded yet.')).toBeInTheDocument();
    expect(summaryText()).toBe('No prompts');
  });

  it('counts a date-only filter as a filter', async () => {
    promptsReply = (url) => reply(200, page(url.searchParams.get('dateFrom') ? [] : [row(1, 'hi')]));
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    expect(await screen.findByText('No prompts match these filters.')).toBeInTheDocument();
    expect(screen.queryByText('No prompts recorded yet.')).not.toBeInTheDocument();
  });

  it('says nothing matches when a filter is set', async () => {
    promptsReply = (url) => reply(200, page(url.searchParams.get('kind') === 'agent' ? [] : [row(1, 'hi')]));
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(sourceButton('Agent'));
    expect(await screen.findByText('No prompts match these filters.')).toBeInTheDocument();
  });
});

describe('PromptsView — pagination', () => {
  it('has no pager for a single page', async () => {
    await renderLoaded();
    expect(screen.queryByRole('navigation', { name: 'Prompt pages' })).not.toBeInTheDocument();
  });

  it('pages through the results', async () => {
    promptsReply = (url) => reply(200, page([row(Number(url.searchParams.get('page')), 'hi')], { total: 120 }));
    const user = userEvent.setup();
    await renderLoaded();

    const nav = screen.getByRole('navigation', { name: 'Prompt pages' });
    expect(nav).toHaveTextContent('Page 1 of 3');
    expect(within(nav).getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(summaryText()).toBe('120 prompts · showing 1–50');

    await user.click(within(nav).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(summaryText()).toBe('120 prompts · showing 51–100'));
    expect(lastCall().searchParams.get('page')).toBe('2');
    expect(lastCall().searchParams.get('pageSize')).toBe('50');
    expect(within(nav).getByRole('button', { name: 'Previous' })).toBeEnabled();

    await user.click(within(nav).getByRole('button', { name: 'Page 3' }));
    await waitFor(() => expect(lastCall().searchParams.get('page')).toBe('3'));
    expect(within(nav).getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('starts a new page at the top of the list', async () => {
    promptsReply = (url) => reply(200, page([row(Number(url.searchParams.get('page')), 'hi')], { total: 120 }));
    const user = userEvent.setup();
    await renderLoaded();
    const results = screen.getAllByRole('listitem')[0].closest('ul')!.parentElement!.parentElement!;
    results.scrollTop = 1800;
    expect(results.scrollTop).toBe(1800); // jsdom keeps the offset, so the reset below is real
    await user.click(within(screen.getByRole('navigation', { name: 'Prompt pages' })).getByRole('button', { name: 'Next' }));
    expect(results.scrollTop).toBe(0);
  });

  it('starts at the top after Clear filters too', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(sourceButton('All'));
    await waitFor(() => expect(lastCall().searchParams.get('kind')).toBe('all'));
    const results = (await screen.findAllByRole('listitem'))[0].closest('ul')!.parentElement!.parentElement!;
    results.scrollTop = 1800;
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(results.scrollTop).toBe(0);
  });
});

// HistoryView.test.tsx — the HISTORY tab on the shared primitives.
//
// What this pins:
//  - a session is ONE <button> the keyboard can open (Enter), with Resume and
//    Delete as separate, named buttons beside it — never inside it;
//  - the detail is a real dialog: named, closed by Escape, focus handed back to
//    the row that opened it, never left open behind a tab you left;
//  - "1 prompt" / "1 tool", no seconds in a row, no year for this year, and an
//    ended session is neutral (not the red it used to be);
//  - loading, error (with Retry, and the server's own reason) and empty copy;
//  - the toolbar still builds the same request: filters, sort, pages.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Chip from '@/components/ui/Chip';
import { useUiStore } from '@/stores/uiStore';
import type { DbSessionRow, SessionDetailResponse } from '@/types';
import { authFetch } from '@/hooks/useAuth';
import { showToast } from '@/components/ui/ToastContainer';
import HistoryView from './HistoryView';

// Not the defaults (1 s per query, 10 s per test): the whole suite runs in
// parallel, and on a busy machine a first render alone can take seconds. The
// copy test also waits out the real 1.5 s "Copied" interval.
configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 20_000 });

vi.mock('@/hooks/useAuth', () => ({ authFetch: vi.fn() }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const THIS_YEAR = new Date().getFullYear();
const at = (year: number, month0: number, day: number, hour: number, minute: number): number =>
  new Date(year, month0, day, hour, minute).getTime();

const STARTED = at(THIS_YEAR, 0, 2, 9, 5);

function row(over: Partial<DbSessionRow> & Pick<DbSessionRow, 'id'>): DbSessionRow {
  return {
    project_path: '/Users/me/code/app',
    project_name: 'app',
    title: 'Fix login bug',
    model: 'claude-opus-4',
    status: 'ended',
    source: 'hook',
    label: null,
    summary: null,
    remark: null,
    team_id: null,
    team_role: null,
    character_model: null,
    accent_color: null,
    started_at: STARTED,
    ended_at: STARTED + 12 * 60_000 + 3_000, // 12m 3s
    last_activity_at: STARTED + 12 * 60_000,
    total_prompts: 3,
    total_tool_calls: 12,
    archived: 0,
    ...over,
  };
}

const page = (sessions: DbSessionRow[], total = sessions.length) => ({
  sessions,
  total,
  page: 1,
  pageSize: 50,
});

function detailOf(session: DbSessionRow): SessionDetailResponse {
  const t0 = session.started_at ?? 0;
  return {
    session,
    prompts: [{ id: 1, session_id: session.id, text: 'Fix the login redirect', timestamp: t0 + 1_000 }],
    responses: [{ id: 1, session_id: session.id, text_excerpt: 'Patched the redirect.', timestamp: t0 + 20_000 }],
    tool_calls: [{ id: 1, session_id: session.id, tool_name: 'Bash', tool_input_summary: 'npm test', timestamp: t0 + 5_000 }],
    events: [{ id: 1, session_id: session.id, event_type: 'Stop', detail: 'finished', timestamp: t0 + 30_000 }],
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// API stub — authFetch is the only door out of the view
// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  body: unknown;
}
const ok = (body: unknown): Reply => ({ status: 200, body });
const fail = (status: number, body: unknown = {}): Reply => ({ status, body });

interface Routes {
  sessions: (params: URLSearchParams) => Reply | Promise<Reply>;
  detail: (id: string) => Reply | Promise<Reply>;
  del: (id: string) => Reply;
  resume: (id: string) => Reply;
}

const ONE_SESSION = row({ id: 's1' });

function stubApi(routes: Partial<Routes> = {}) {
  const r: Routes = {
    sessions: () => ok(page([ONE_SESSION])),
    detail: (id) => ok(detailOf(id === 's1' ? ONE_SESSION : row({ id }))),
    del: () => ok({ ok: true }),
    resume: () => ok({ ok: true }),
    ...routes,
  };
  vi.mocked(authFetch).mockImplementation(async (input, init) => {
    const { pathname, searchParams } = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const detailId = pathname.match(/^\/api\/db\/sessions\/([^/]+)$/)?.[1];
    const resumeId = pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/)?.[1];
    let reply: Reply;
    if (pathname === '/api/db/projects') {
      reply = ok([
        { project_path: '/Users/me/code/app', project_name: 'app' },
        { project_path: '/Users/me/code/site', project_name: 'site' },
      ]);
    } else if (pathname === '/api/db/sessions') {
      reply = await r.sessions(searchParams);
    } else if (detailId && method === 'DELETE') {
      reply = r.del(decodeURIComponent(detailId));
    } else if (detailId) {
      reply = await r.detail(decodeURIComponent(detailId));
    } else if (resumeId && method === 'POST') {
      reply = r.resume(decodeURIComponent(resumeId));
    } else {
      reply = fail(404);
    }
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body } as Response;
  });
}

const sessionRequests = () =>
  vi.mocked(authFetch).mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter((u) => u.pathname === '/api/db/sessions');
const lastParams = () => sessionRequests().at(-1)!.searchParams;
const callsWith = (method: string) =>
  vi.mocked(authFetch).mock.calls.filter(([, init]) => init?.method === method);

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <HistoryView />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

async function openButton(name: RegExp | string = /Fix login bug/) {
  return screen.findByRole('button', { name });
}

beforeEach(() => {
  useUiStore.setState({ activeModal: null });
  stubApi();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(authFetch).mockReset();
  vi.mocked(showToast).mockReset();
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

describe('HistoryView — rows', () => {
  it('is one button that opens the session, with Resume and Delete beside it, not inside it', async () => {
    renderView();
    const open = await openButton();
    const resume = screen.getByRole('button', { name: 'Resume session' });
    const del = screen.getByRole('button', { name: 'Delete session' });

    expect(open.tagName).toBe('BUTTON');
    expect(open).not.toContainElement(resume);
    expect(open).not.toContainElement(del);
    // Every row repeats those two names, so each is described by its row's title.
    expect(resume).toHaveAccessibleDescription('Fix login bug');
    expect(del).toHaveAccessibleDescription('Fix login bug');
    expect(open).toHaveTextContent('app');
  });

  it('opens the detail from the keyboard, names the dialog, and gives focus back on Escape', async () => {
    const user = userEvent.setup();
    renderView();
    const open = await openButton();

    open.focus();
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', { name: 'Fix login bug' });
    expect(await within(dialog).findByText('Fix the login redirect')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(open).toHaveFocus();
    expect(useUiStore.getState().activeModal).toBeNull();
  });

  it('says "1 prompt" and "1 tool", never "1 prompts"', async () => {
    stubApi({
      sessions: () =>
        ok(page([
          row({ id: 'one', title: 'Just one', total_prompts: 1, total_tool_calls: 1 }),
          row({ id: 'many', title: 'Several', total_prompts: 2, total_tool_calls: 1234 }),
          row({ id: 'none', title: 'Nothing', total_prompts: 0, total_tool_calls: 0 }),
        ])),
    });
    renderView();
    await openButton(/Just one/);

    expect(screen.getByText('1 prompt')).toBeInTheDocument();
    expect(screen.getByText('1 tool')).toBeInTheDocument();
    expect(screen.getByText('2 prompts')).toBeInTheDocument();
    expect(screen.getByText('1,234 tools')).toBeInTheDocument();
    expect(screen.getByText('0 prompts')).toBeInTheDocument();
    expect(screen.queryByText('1 prompts')).not.toBeInTheDocument();
    expect(screen.queryByText('1 tools')).not.toBeInTheDocument();
  });

  it('shows the year only for another year, and never seconds', async () => {
    stubApi({
      sessions: () =>
        ok(page([
          row({ id: 'now', title: 'This year' }),
          row({
            id: 'old',
            title: 'Last year',
            started_at: at(THIS_YEAR - 1, 11, 31, 23, 30),
            ended_at: at(THIS_YEAR - 1, 11, 31, 23, 45),
          }),
        ])),
    });
    renderView();
    await openButton(/This year/);

    expect(screen.getByText('Jan 2, 09:05')).toBeInTheDocument();
    expect(screen.getByText(`Dec 31, ${THIS_YEAR - 1}, 23:30`)).toBeInTheDocument();
    expect(screen.getByText('12m 3s')).toBeInTheDocument();
    expect(screen.getByText('15m 0s')).toBeInTheDocument();
  });

  it('marks an ended or archived session neutral — not the danger red it used to be', async () => {
    stubApi({
      sessions: () =>
        ok(page([
          row({ id: 'e', title: 'Finished', status: 'ended' }),
          row({ id: 'i', title: 'Resting', status: 'idle' }),
          row({ id: 'a', title: 'Shelved', status: 'idle', archived: 1 }),
        ])),
    });
    renderView();
    await openButton(/Finished/);
    const neutral = render(<Chip>x</Chip>).getByText('x').className;
    // Scoped to the row: the Status filter has "Ended" and "Idle" options too.
    const chipIn = (row: RegExp, label: string) =>
      within(screen.getByRole('button', { name: row })).getByText(label);

    expect(chipIn(/Finished/, 'Ended').className).toBe(neutral);
    expect(chipIn(/Resting/, 'Idle').className).not.toBe(neutral);
    // Archived keeps its status word, and says why it is quiet.
    const shelved = chipIn(/Shelved/, 'Idle');
    expect(shelved.className).toBe(neutral);
    expect(shelved).toHaveAttribute('title', 'Archived');
    expect(screen.queryByText('Disconnected')).not.toBeInTheDocument();
    expect(screen.queryByText('ENDED')).not.toBeInTheDocument();
  });

  it('Resume posts to the session and leaves the detail closed', async () => {
    const user = userEvent.setup();
    renderView();
    await openButton();

    await user.click(screen.getByRole('button', { name: 'Resume session' }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Resuming Claude session in terminal', 'success'));
    expect(callsWith('POST').map(([url]) => String(url))).toEqual(['/api/sessions/s1/resume']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Delete asks first; Cancel deletes nothing, OK deletes and reloads the list', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderView();
    await openButton();

    await user.click(screen.getByRole('button', { name: 'Delete session' }));
    expect(confirm).toHaveBeenCalledWith('Delete this session from history? This cannot be undone.');
    expect(callsWith('DELETE')).toHaveLength(0);

    confirm.mockReturnValue(true);
    const before = sessionRequests().length;
    await user.click(screen.getByRole('button', { name: 'Delete session' }));
    await waitFor(() => expect(callsWith('DELETE').map(([url]) => String(url))).toEqual(['/api/db/sessions/s1']));
    await waitFor(() => expect(sessionRequests().length).toBeGreaterThan(before));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('hands focus to the next row after a delete, or to the search box once the page is empty', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let sessions = [ONE_SESSION, row({ id: 's2', title: 'Second' })];
    stubApi({
      sessions: () => ok(page(sessions)),
      del: (id) => {
        sessions = sessions.filter((s) => s.id !== id);
        return ok({ ok: true });
      },
    });
    renderView();
    await openButton();

    // The focused Delete leaves with its row; focus must not fall to <body>.
    await user.click(screen.getAllByRole('button', { name: 'Delete session' })[0]);
    await waitFor(() => expect(screen.getByRole('button', { name: /Second/ })).toHaveFocus());
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Delete session' })).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: 'Delete session' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search prompts' })).toHaveFocus());
  });

  it('says so when a delete fails, instead of failing silently', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    stubApi({ del: () => fail(500, { error: 'database is locked' }) });
    renderView();
    await openButton();
    const before = sessionRequests().length;

    await user.click(screen.getByRole('button', { name: 'Delete session' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('database is locked', 'error'));
    expect(sessionRequests().length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

describe('HistoryView — states', () => {
  it('says it is loading while the first page is in flight', () => {
    stubApi({ sessions: () => new Promise<Reply>(() => {}) });
    renderView();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading sessions…');
    expect(status).toHaveAttribute('aria-busy', 'true');
  });

  it('shows an error — not "no sessions" — and Retry loads the list', async () => {
    const user = userEvent.setup();
    const replies = [fail(500), ok(page([ONE_SESSION]))];
    stubApi({ sessions: () => replies.shift() ?? ok(page([ONE_SESSION])) });
    renderView();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load sessions');
    expect(alert).toHaveTextContent('Failed to load sessions (HTTP 500)');
    expect(screen.queryByText(/No sessions/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await openButton()).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the rows when a refresh fails, says they are stale, and Retry recovers', async () => {
    const user = userEvent.setup();
    let failing = false;
    stubApi({ sessions: () => (failing ? fail(500) : ok(page([ONE_SESSION]))) });
    const { client } = renderView();
    await openButton();

    // A background refetch of the same query (a delete's invalidation, window focus).
    failing = true;
    await act(() => client.invalidateQueries({ queryKey: ['db-sessions'] }));
    const note = await screen.findByRole('alert');
    expect(note).toHaveTextContent("Couldn't refresh. Showing the last results.");
    // The rows stay: this is not the full-page error state.
    expect(await openButton()).toBeInTheDocument();
    expect(screen.queryByText('Could not load sessions')).not.toBeInTheDocument();

    failing = false;
    await user.click(within(note).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('passes on the server\'s own reason, and offers no Retry that cannot change it (a remote device is refused history)', async () => {
    stubApi({
      sessions: () =>
        fail(403, { error: 'Session history is only available on the host machine', code: 'HISTORY_HOST_ONLY' }),
    });
    renderView();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Session history is only available on the host machine');
    expect(within(alert).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('with nothing recorded and no filter, says nothing is recorded yet', async () => {
    stubApi({ sessions: () => ok(page([])) });
    renderView();
    expect(await screen.findByText('No sessions recorded yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('with a filter on, says nothing matches, and Clear filters starts over', async () => {
    const user = userEvent.setup();
    stubApi({ sessions: (p) => ok(page(p.get('status') === 'idle' ? [] : [ONE_SESSION])) });
    renderView();
    await openButton();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'idle');
    expect(await screen.findByText('No sessions match these filters')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await openButton()).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('');
    expect(lastParams().get('status')).toBeNull();
  });

  it('Clear filters empties the search box too, not just the dropdowns', async () => {
    const user = userEvent.setup();
    stubApi({ sessions: (p) => ok(page(p.get('query') ? [] : [ONE_SESSION])) });
    renderView();
    await openButton();

    const search = screen.getByRole('textbox', { name: 'Search prompts' });
    await user.type(search, 'zzz');
    expect(await screen.findByText('No sessions match these filters')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await openButton()).toBeInTheDocument();
    expect(search).toHaveValue('');
    expect(lastParams().get('query')).toBeNull();
  });

  it('offers the last page when the open page has emptied under it', async () => {
    const user = userEvent.setup();
    stubApi({
      // 120 sessions = 3 pages; by the time page 3 is asked for, 20 are gone (2 pages).
      sessions: (p) => {
        if (p.get('page') === '3') return ok(page([], 100));
        return ok(page([ONE_SESSION], p.get('page') === '2' ? 100 : 120));
      },
    });
    renderView();
    await openButton();

    await user.click(screen.getByRole('button', { name: 'Page 3' }));
    expect(await screen.findByText('No sessions on this page')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Go to last page' }));
    await waitFor(() => expect(lastParams().get('page')).toBe('2'));
    expect(await openButton()).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Toolbar and pages
// ---------------------------------------------------------------------------

describe('HistoryView — toolbar', () => {
  it('names every control', async () => {
    renderView();
    await openButton();

    expect(screen.getByRole('search', { name: 'Filter sessions' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search prompts' })).toBeInTheDocument();
    for (const name of ['Project', 'Status', 'Sort']) {
      expect(screen.getByRole('combobox', { name })).toBeInTheDocument();
    }
    expect(screen.getByLabelText('From')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('To')).toHaveAttribute('type', 'date');
  });

  it('sends no filters until one is chosen', async () => {
    renderView();
    await openButton();
    expect(Object.fromEntries(lastParams())).toEqual({
      sortBy: 'started_at', sortDir: 'desc', page: '1', pageSize: '50',
    });
  });

  it('sends the project, from the list the server gave', async () => {
    const user = userEvent.setup();
    renderView();
    await openButton();

    await screen.findByRole('option', { name: 'site' }); // the project list loads on its own request
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), '/Users/me/code/site');
    await waitFor(() => expect(lastParams().get('project')).toBe('/Users/me/code/site'));
  });

  it('sends "archived" as its own flag, and every other status as a status', async () => {
    const user = userEvent.setup();
    renderView();
    await openButton();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'archived');
    await waitFor(() => expect(lastParams().get('archived')).toBe('true'));
    expect(lastParams().get('status')).toBeNull();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'ended');
    await waitFor(() => expect(lastParams().get('status')).toBe('ended'));
    expect(lastParams().get('archived')).toBeNull();
  });

  it('sends the sort column and the date range', async () => {
    const user = userEvent.setup();
    renderView();
    await openButton();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'duration');
    await waitFor(() => expect(lastParams().get('sortBy')).toBe('last_activity_at'));
    // "Prompts" / "Tools" sort by their own columns (they fell back to
    // started_at until the server whitelist gained them).
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'prompts');
    await waitFor(() => expect(lastParams().get('sortBy')).toBe('total_prompts'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'tools');
    await waitFor(() => expect(lastParams().get('sortBy')).toBe('total_tool_calls'));

    // Both ends are LOCAL time: `new Date('2026-01-02')` is UTC midnight, which
    // at GMT+13 dropped the From day's sessions before 13:00.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-02' } });
    await waitFor(() => expect(lastParams().get('dateFrom')).toBe(String(new Date('2026-01-02T00:00:00').getTime())));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-01-09' } });
    await waitFor(() =>
      expect(lastParams().get('dateTo')).toBe(String(new Date('2026-01-09T23:59:59').getTime())));
  });

  it('searches prompts after a pause in typing', async () => {
    const user = userEvent.setup();
    renderView();
    await openButton();

    await user.type(screen.getByRole('textbox', { name: 'Search prompts' }), 'login');
    await waitFor(() => expect(lastParams().get('query')).toBe('login'));
  });

  it('the direction button names the current direction and flips it', async () => {
    const user = userEvent.setup();
    renderView();
    await openButton();

    // The name starts with the visible word (WCAG 2.5.3), so "click Desc" works by voice.
    const button = screen.getByRole('button', { name: 'Descending sort' });
    expect(button).toHaveTextContent('Desc');

    await user.click(button);
    expect(await screen.findByRole('button', { name: 'Ascending sort' })).toHaveTextContent('Asc');
    await waitFor(() => expect(lastParams().get('sortDir')).toBe('asc'));
  });
});

describe('HistoryView — pages', () => {
  it('pages through the list and says which rows are showing', async () => {
    const user = userEvent.setup();
    stubApi({ sessions: () => ok(page([ONE_SESSION, row({ id: 's2', title: 'Second' })], 120)) });
    renderView();
    await openButton();

    expect(screen.getByRole('navigation', { name: 'Session pages' })).toBeInTheDocument();
    expect(screen.getByText('120 sessions · showing 1–2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(lastParams().get('page')).toBe('2'));
    expect(await screen.findByText('120 sessions · showing 51–52')).toBeInTheDocument();
  });

  it('keeps the rows and the pager up while the next page loads, so focus stays on Next', async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    stubApi({
      sessions: (params) =>
        params.get('page') === '2'
          ? new Promise<Reply>((resolve) => {
              release = () => resolve(ok(page([row({ id: 's3', title: 'Third' })], 120)));
            })
          : ok(page([ONE_SESSION, row({ id: 's2', title: 'Second' })], 120)),
    });
    renderView();
    await openButton();
    const next = within(screen.getByRole('navigation', { name: 'Session pages' })).getByRole('button', { name: 'Next' });

    await user.click(next);
    await waitFor(() => expect(lastParams().get('page')).toBe('2'));
    // Page 1 stays up until page 2 lands: no "Loading…" swap that unmounted the
    // pager and dropped keyboard focus to <body>.
    expect(screen.getByRole('button', { name: /Second/ })).toBeInTheDocument();
    expect(next).toHaveFocus();

    act(() => release!());
    expect(await screen.findByRole('button', { name: /Third/ })).toBeInTheDocument();
  });

  it('starts a new page at the top of the list', async () => {
    const user = userEvent.setup();
    stubApi({ sessions: () => ok(page([ONE_SESSION, row({ id: 's2', title: 'Second' })], 120)) });
    renderView();
    const body = (await openButton()).closest('ul')!.parentElement!;
    body.scrollTop = 1800;
    expect(body.scrollTop).toBe(1800); // jsdom keeps the offset, so the reset below is real
    await user.click(within(screen.getByRole('navigation', { name: 'Session pages' })).getByRole('button', { name: 'Next' }));
    expect(body.scrollTop).toBe(0);
  });

  it('has no pager for a single page, and counts "1 session"', async () => {
    renderView();
    await openButton();
    expect(screen.queryByRole('navigation', { name: 'Session pages' })).not.toBeInTheDocument();
    expect(screen.getByText('1 session')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Detail dialog
// ---------------------------------------------------------------------------

describe('HistoryView — detail dialog', () => {
  async function openDetail() {
    const user = userEvent.setup();
    renderView();
    await user.click(await openButton());
    const dialog = await screen.findByRole('dialog', { name: 'Fix login bug' });
    await within(dialog).findByText('Fix the login redirect');
    return { user, dialog };
  }

  it('leads with the status and the facts, and tells who spoke by word, not just colour', async () => {
    const { dialog } = await openDetail();

    expect(within(dialog).getByText('Ended')).toBeInTheDocument();
    expect(within(dialog).getByText('app · claude-opus-4 · 12m 3s · 3 prompts · 12 tools')).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: 'Conversation (2)' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByText('Prompt')).toBeInTheDocument();
    expect(within(dialog).getByText('Response')).toBeInTheDocument();
    // HH:MM here; the activity log keeps its seconds.
    expect(within(dialog).getAllByText(/^\d{2}:\d{2}$/)).toHaveLength(2);
  });

  it('lists the activity newest first, with seconds', async () => {
    const { user, dialog } = await openDetail();

    await user.click(within(dialog).getByRole('tab', { name: 'Activity (2)' }));
    expect(within(dialog).getByText('Bash')).toBeInTheDocument();
    expect(within(dialog).getByText('npm test')).toBeInTheDocument();
    const times = within(dialog).getAllByText(/^\d{2}:\d{2}:\d{2}$/);
    expect(times.map((t) => t.textContent)).toEqual(['09:05:30', '09:05:05']);
  });

  it('keeps the copy button on screen and confirms a copy for a moment', async () => {
    const { user, dialog } = await openDetail();

    const copies = within(dialog).getAllByRole('button', { name: 'Copy message' });
    expect(copies).toHaveLength(2);

    await user.click(copies[0]);
    expect(await navigator.clipboard.readText()).toBe('Fix the login redirect');
    const copied = await within(dialog).findByRole('button', { name: 'Copied' });
    expect(copied).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getAllByRole('button', { name: 'Copy message' })).toHaveLength(2), {
      timeout: 8000,
    });
  });

  it("describes each copy button by its entry's role and time", async () => {
    const { dialog } = await openDetail();
    const [prompt, response] = within(dialog).getAllByRole('button', { name: 'Copy message' });
    expect(prompt).toHaveAccessibleDescription(/^Prompt\s*\d{2}:\d{2}$/);
    expect(response).toHaveAccessibleDescription(/^Response\s*\d{2}:\d{2}$/);
  });

  it('says so when the copy fails', async () => {
    const { user, dialog } = await openDetail();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

    await user.click(within(dialog).getAllByRole('button', { name: 'Copy message' })[0]);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not copy to the clipboard', 'error'));
    expect(within(dialog).queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  });

  it('opens at once, named from the row, with focus inside, while the detail loads', async () => {
    const user = userEvent.setup();
    stubApi({ detail: () => new Promise<Reply>(() => {}) });
    renderView();
    await user.click(await openButton());

    const dialog = await screen.findByRole('dialog', { name: 'Fix login bug' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('Loading session…');
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('shows an error with Retry when the detail fails', async () => {
    const user = userEvent.setup();
    const replies = [fail(500), ok(detailOf(ONE_SESSION))];
    stubApi({ detail: () => replies.shift() ?? ok(detailOf(ONE_SESSION)) });
    renderView();
    await user.click(await openButton());

    const dialog = await screen.findByRole('dialog', { name: 'Fix login bug' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not load this session');
    expect(dialog).toHaveTextContent('Failed to load session detail (HTTP 500)');

    await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByText('Fix the login redirect')).toBeInTheDocument();
  });

  it('says a session is gone, without a Retry that cannot bring it back', async () => {
    const user = userEvent.setup();
    stubApi({ detail: () => fail(404, { error: 'Session not found' }) });
    renderView();
    await user.click(await openButton());

    const dialog = await screen.findByRole('dialog', { name: 'Fix login bug' });
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Session not found');
    expect(within(alert).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('closes its modal when you leave the tab, instead of stranding it', async () => {
    const user = userEvent.setup();
    const view = renderView();
    await user.click(await openButton());
    await screen.findByRole('dialog', { name: 'Fix login bug' });
    expect(useUiStore.getState().activeModal).toBe('history-session-detail');

    view.unmount();
    expect(useUiStore.getState().activeModal).toBeNull();
  });

  it('leaves another modal alone when it unmounts', async () => {
    const view = renderView();
    await openButton();
    act(() => useUiStore.setState({ activeModal: 'settings' }));

    view.unmount();
    expect(useUiStore.getState().activeModal).toBe('settings');
  });
});

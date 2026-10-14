// PhoneHistory.test.tsx — HISTORY on a phone (AASC-20, feature 3).
//
// What this pins:
//  - a remote device never asks for the host-only routes (the session list,
//    the project list): it lists the sessions shared with it, says what stays
//    on the Mac, and opens one session's own history;
//  - that history opens full screen, with Open session (and Resume once it has
//    ended) but no Delete: a phone may not delete history;
//  - a 404 (nothing recorded) is said in words, with no Retry to loop on;
//  - on the Mac itself the phone layout reads the whole history, and Delete
//    asks first.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DbSessionRow, Session, SessionDetailResponse } from '@/types';

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 20_000 });

vi.mock('@/hooks/useAuth', () => ({ authFetch: vi.fn() }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
const host = vi.hoisted(() => ({ isHost: false }));
vi.mock('./hostAccess', () => ({ useIsHostDevice: () => host.isHost }));
const actions = vi.hoisted(() => ({ resume: vi.fn() }));
vi.mock('@/lib/sessionActions', () => ({ requestSessionResume: actions.resume }));

import { authFetch } from '@/hooks/useAuth';
import { useSessionStore } from '@/stores/sessionStore';
import PhoneHistory from './PhoneHistory';

const live = (id: string, over: Partial<Session> = {}): Session =>
  ({ sessionId: id, title: id, projectName: 'app', status: 'idle', lastActivityAt: 10, events: [], promptHistory: [], ...over }) as unknown as Session;

function row(id: string, over: Partial<DbSessionRow> = {}): DbSessionRow {
  return {
    id, project_path: '/w/app', project_name: 'app', title: `Session ${id}`, model: 'opus', status: 'ended', source: 'ssh',
    label: null, summary: null, remark: null, team_id: null, team_role: null, character_model: null, accent_color: null,
    started_at: 1_000, ended_at: 61_000, last_activity_at: 60_000, total_prompts: 2, total_tool_calls: 5, archived: 0, ...over,
  };
}

const detail = (id: string, over: Partial<DbSessionRow> = {}): SessionDetailResponse => ({
  session: row(id, over),
  prompts: [{ id: 1, session_id: id, text: 'Fix the login redirect', timestamp: 2_000 }],
  responses: [{ id: 1, session_id: id, text_excerpt: 'Patched the redirect.', timestamp: 3_000 }],
  tool_calls: [],
  events: [],
  notes: [],
});

type Reply = { status: number; body: unknown };
let calls: string[];
let detailReply: (id: string) => Reply;

beforeEach(() => {
  host.isHost = false;
  calls = [];
  detailReply = (id) => ({ status: 200, body: detail(id) });
  actions.resume.mockResolvedValue({ ok: true, message: 'Resuming' });
  useSessionStore.setState({
    sessions: new Map([
      ['a', live('a', { title: 'Older', lastActivityAt: 5 })],
      ['b', live('b', { title: 'Newest', lastActivityAt: 50, status: 'working' })],
      ['c', live('c', { title: 'Finished', lastActivityAt: 20, status: 'ended' })],
    ]),
    selectedSessionId: null,
  });
  vi.mocked(authFetch).mockImplementation(async (input, init) => {
    const { pathname } = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${pathname}`);
    const id = pathname.match(/^\/api\/db\/sessions\/([^/]+)$/)?.[1];
    let reply: Reply = { status: 404, body: { error: 'Not found' } };
    if (pathname === '/api/db/sessions') reply = { status: 200, body: { sessions: [row('h1'), row('h2', { title: 'Second' })], total: 2, page: 1, pageSize: 50 } };
    else if (pathname === '/api/db/projects') reply = { status: 200, body: [{ project_path: '/w/app', project_name: 'app' }] };
    else if (id && method === 'DELETE') reply = { status: 200, body: { ok: true } };
    else if (id) reply = detailReply(decodeURIComponent(id));
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body } as Response;
  });
});

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/history']}>
        <Routes>
          <Route path="/history" element={<PhoneHistory />} />
          <Route path="/" element={<div data-testid="live-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rowButtons = () => within(screen.getByTestId('phone-history')).getAllByRole('button').filter((b) => b.closest('li'));

describe('PhoneHistory — a remote device', () => {
  it('lists the shared sessions, newest first, and never asks for the host-only list or projects', async () => {
    renderView();
    expect(rowButtons().map((b) => b.textContent)).toEqual([
      expect.stringContaining('Newest'),
      expect.stringContaining('Finished'),
      expect.stringContaining('Older'),
    ]);
    expect(screen.getByTestId('host-only-note').textContent).toMatch(/Mac keeps the full history/);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
  });

  it('searches and filters the shared list on the phone, with no request', async () => {
    const user = userEvent.setup();
    renderView();
    await user.type(screen.getByRole('textbox', { name: 'Search shared sessions' }), 'fin');
    await waitFor(() => expect(rowButtons()).toHaveLength(1));
    expect(rowButtons()[0].textContent).toContain('Finished');
    expect(calls).toEqual([]);
  });

  it('opens one session full screen from its own history, with Open session and no Delete', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(rowButtons()[0]);
    const sheet = await screen.findByRole('dialog', { name: 'Newest' });
    expect(await within(sheet).findByText('Fix the login redirect')).toBeTruthy();
    expect(calls).toEqual(['GET /api/db/sessions/b']);
    expect(within(sheet).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(sheet).queryByRole('button', { name: 'Resume' })).toBeNull();
    await user.click(within(sheet).getByRole('button', { name: 'Open session' }));
    expect(useSessionStore.getState().selectedSessionId).toBe('b');
    expect(await screen.findByTestId('live-page')).toBeTruthy();
  });

  it('offers Resume for a session that has ended', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(rowButtons()[1]);
    const sheet = await screen.findByRole('dialog', { name: 'Finished' });
    await user.click(within(sheet).getByRole('button', { name: 'Resume' }));
    expect(actions.resume).toHaveBeenCalledWith('c');
  });

  it('says so when nothing is recorded yet (404), with no Retry to loop on', async () => {
    detailReply = () => ({ status: 404, body: { error: 'Session not found' } });
    const user = userEvent.setup();
    renderView();
    await user.click(rowButtons()[0]);
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('No history recorded yet')).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(calls.filter((c) => c.startsWith('GET /api/db/sessions/'))).toHaveLength(1);
  });
});

describe('PhoneHistory — on the Mac itself', () => {
  beforeEach(() => { host.isHost = true; });

  it('reads the whole history, one column, with no host-only note', async () => {
    renderView();
    await waitFor(() => expect(rowButtons()).toHaveLength(2));
    expect(calls).toContain('GET /api/db/sessions');
    expect(calls).toContain('GET /api/db/projects');
    expect(screen.queryByTestId('host-only-note')).toBeNull();
    expect(screen.getByText('2 sessions')).toBeTruthy();
  });

  it('deletes from the full-screen detail only after a confirm', async () => {
    detailReply = (id) => ({ status: 200, body: detail(id, { title: 'Second' }) });
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(rowButtons()).toHaveLength(2));
    await user.click(rowButtons()[1]);
    const sheet = await screen.findByRole('dialog', { name: 'Second' });
    await user.click(within(sheet).getByRole('button', { name: 'Delete' }));
    expect(calls).not.toContain('DELETE /api/db/sessions/h2');
    const confirm = await screen.findByRole('dialog', { name: 'Delete this session from history?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls).toContain('DELETE /api/db/sessions/h2'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('puts the filters in a sheet and counts the ones set', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    await user.selectOptions(within(sheet).getByRole('combobox', { name: 'Status' }), 'ended');
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('button', { name: 'Filters, 1 set' })).toBeTruthy();
    await waitFor(() => expect(vi.mocked(authFetch).mock.calls.some(([u]) => String(u).includes('status=ended'))).toBe(true));
  });
});

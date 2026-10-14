// PhonePrompts.test.tsx — the prompt trace on a phone (AASC-20, feature 4).
//
// What this pins:
//  - a remote device always names one shared session (`?session=`, the only
//    way the server answers it) and never asks for the project list; the open
//    session is the default, and picking another re-reads;
//  - on the Mac itself it reads the whole trace, with the project filter;
//  - a row opens the whole prompt full screen with Copy, Save and Open session.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PromptTraceRow, Session } from '@/types';

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 20_000 });

vi.mock('@/hooks/useAuth', () => ({ authFetch: vi.fn() }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
const host = vi.hoisted(() => ({ isHost: false }));
vi.mock('./hostAccess', () => ({ useIsHostDevice: () => host.isHost }));

import { authFetch } from '@/hooks/useAuth';
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';
import { usePromptSnippetStore } from '@/stores/promptSnippetStore';
import PhonePrompts from './PhonePrompts';

const live = (id: string, title: string, lastActivityAt: number): Session =>
  ({ sessionId: id, title, projectName: 'app', status: 'idle', lastActivityAt, events: [], promptHistory: [] }) as unknown as Session;

const prompt = (id: number, session: string, text: string): PromptTraceRow => ({
  id, session_id: session, text, timestamp: new Date(2026, 9, 15, 9, id).getTime(),
  project_name: 'app', project_path: '/w/app', session_title: session === 'a' ? 'Alpha' : 'Beta',
});

let urls: URL[];

beforeEach(() => {
  host.isHost = false;
  urls = [];
  useSessionStore.setState({
    sessions: new Map([['a', live('a', 'Alpha', 10)], ['b', live('b', 'Beta', 50)]]),
    selectedSessionId: null,
  });
  vi.mocked(authFetch).mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    urls.push(url);
    let body: unknown = { error: 'Not found' };
    let status = 404;
    if (url.pathname === '/api/db/prompts') {
      const session = url.searchParams.get('session');
      const rows = [prompt(1, 'a', 'fix the alpha bug'), prompt(2, 'b', 'ship beta')].filter((r) => !session || r.session_id === session);
      body = { prompts: rows, total: rows.length, page: 1, pageSize: 50 };
      status = 200;
    } else if (url.pathname === '/api/db/projects') {
      body = [{ project_path: '/w/app', project_name: 'app' }];
      status = 200;
    }
    return { ok: status < 400, status, json: async () => body } as Response;
  });
});

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/prompts']}>
        <Routes>
          <Route path="/prompts" element={<PhonePrompts />} />
          <Route path="/" element={<div data-testid="live-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const promptRequests = () => urls.filter((u) => u.pathname === '/api/db/prompts');

describe('PhonePrompts — a remote device', () => {
  it('reads one shared session, the most recently active by default, and never the project list', async () => {
    renderView();
    expect(await screen.findByText('ship beta')).toBeTruthy();
    expect(screen.queryByText('fix the alpha bug')).toBeNull();
    expect(promptRequests().every((u) => u.searchParams.get('session') === 'b')).toBe(true);
    expect(urls.some((u) => u.pathname === '/api/db/projects')).toBe(false);
    expect(screen.getByTestId('host-only-note').textContent).toMatch(/on your Mac/);
  });

  it('starts on the open session, and re-reads when another is picked', async () => {
    useSessionStore.setState({ selectedSessionId: 'a' });
    const user = userEvent.setup();
    renderView();
    expect(await screen.findByText('fix the alpha bug')).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Session' }), 'b');
    expect(await screen.findByText('ship beta')).toBeTruthy();
    expect(promptRequests().map((u) => u.searchParams.get('session'))).toEqual(['a', 'b']);
  });

  it('asks for nothing when no session is shared with it', async () => {
    useSessionStore.setState({ sessions: new Map() });
    renderView();
    expect(screen.getByText('No sessions shared with this phone')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(urls).toEqual([]);
  });
});

describe('PhonePrompts — on the Mac itself', () => {
  beforeEach(() => { host.isHost = true; });

  it('reads the whole trace and offers the project filter', async () => {
    const user = userEvent.setup();
    renderView();
    expect(await screen.findByText('fix the alpha bug')).toBeTruthy();
    expect(screen.getByText('ship beta')).toBeTruthy();
    expect(promptRequests()[0].searchParams.has('session')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(sheet).getByRole('combobox', { name: 'Project' })).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: '/Cmd' }));
    await waitFor(() => expect(promptRequests().some((u) => u.searchParams.get('kind') === 'cmd')).toBe(true));
  });
});

describe('PhonePrompts — a prompt, full screen', () => {
  it('opens the whole text with Copy, Save and Open session', async () => {
    const save = vi.fn(async () => ({ id: 7, duplicate: false }));
    usePromptSnippetStore.setState({ save } as Partial<ReturnType<typeof usePromptSnippetStore.getState>>);
    const user = userEvent.setup();
    // After setup(): user-event installs its own clipboard on navigator.
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderView();
    await user.click(await screen.findByRole('button', { name: /ship beta/ }));
    const sheet = await screen.findByRole('dialog', { name: /^Prompt · / });
    expect(within(sheet).getByText('ship beta')).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('ship beta');
    await user.click(within(sheet).getByRole('button', { name: 'Save to prompts' }));
    expect(save).toHaveBeenCalledWith('ship beta');
    expect(showToast).toHaveBeenCalledWith('Saved to your prompts', 'success');
    await user.click(within(sheet).getByRole('button', { name: 'Open session' }));
    expect(useSessionStore.getState().selectedSessionId).toBe('b');
    expect(await screen.findByTestId('live-page')).toBeTruthy();
  });
});

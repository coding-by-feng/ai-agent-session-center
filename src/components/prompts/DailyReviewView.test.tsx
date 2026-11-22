// DailyReviewView.test.tsx — PROMPTS → Days as the user meets it (Nov 20 2026): one day at a time,
// its prompts grouped project › room › session, and the day's summary written when asked. The server
// half is test/dailyReview.test.ts; the grouping itself is src/lib/dailyReview.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configure, render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DailyReview, DailySummary } from '@/types/dailyReview';
import { localDayKey, shiftDay } from '@/lib/dailyReview';

const { authFetch } = vi.hoisted(() => ({
  authFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock('@/hooks/useAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAuth')>()),
  authFetch,
}));

import DailyReviewView from './DailyReviewView';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

configure({ asyncUtilTimeout: 4000 });

const TODAY = localDayKey(Date.now());
const YESTERDAY = shiftDay(TODAY, -1);
const at = (h: number, m = 0) => {
  const [y, mo, d] = TODAY.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};

function review(day: string, over: Partial<DailyReview> = {}): DailyReview {
  return {
    day,
    promptCount: 4,
    sessionCount: 3,
    projectCount: 2,
    summary: null,
    summarizing: false,
    projects: [
      {
        name: 'agent-manager', path: '/w/am', promptCount: 3, sessionCount: 2,
        rooms: [
          { name: 'Cloud', promptCount: 2, sessions: [{
            sessionId: 's1', title: 'Plan 18 devices', promptCount: 2, firstAt: at(9, 12), lastAt: at(16, 32),
            prompts: [{ id: 1, text: 'help me finish all of these', timestamp: at(9, 12) }, { id: 2, text: 'commit it', timestamp: at(16, 32) }],
          }] },
          { name: 'No room', promptCount: 1, sessions: [{
            sessionId: 's3', title: 'Fix rooms icon', promptCount: 1, firstAt: at(14, 2), lastAt: at(14, 2),
            prompts: [{ id: 3, text: 'move the icon', timestamp: at(14, 2) }],
          }] },
        ],
      },
      {
        name: 'website', path: '/w/site', promptCount: 1, sessionCount: 1,
        rooms: [{ name: 'No room', promptCount: 1, sessions: [{
          sessionId: 'w1', title: 'Terms', promptCount: 1, firstAt: at(10), lastAt: at(10),
          prompts: [{ id: 4, text: 'terms page', timestamp: at(10) }],
        }] }],
      },
    ],
    ...over,
  };
}

const summary = (over: Partial<DailySummary> = {}): DailySummary => ({
  text: '• agent-manager: committed plan 18\n• website: shipped the terms page',
  model: 'haiku', promptCount: 4, generatedAt: at(17, 5), stale: false, ...over,
});

function reply(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** What GET /api/daily-review answers, per day; and POST …/summary. */
let days: Map<string, DailyReview>;
let summaryReply: () => Response | Promise<Response>;

const getCalls = () => authFetch.mock.calls
  .map(([input, init]) => ({ url: new URL(String(input), 'http://localhost'), method: init?.method ?? 'GET' }))
  .filter((c) => c.url.pathname === '/api/daily-review' && c.method === 'GET');

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DailyReviewView viewSwitch={<span>switch</span>} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  days = new Map([[TODAY, review(TODAY)], [YESTERDAY, review(YESTERDAY, { promptCount: 0, sessionCount: 0, projectCount: 0, projects: [] })]]);
  // Like the server: a written summary is kept, so the next read of the day carries it.
  summaryReply = () => {
    days.set(TODAY, { ...days.get(TODAY)!, summary: summary() });
    return reply(200, { ok: true, summary: summary() });
  };
  authFetch.mockReset();
  authFetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/daily-review') return reply(200, days.get(url.searchParams.get('day') ?? '') ?? review(url.searchParams.get('day') ?? ''));
    if (init?.method === 'POST' && url.pathname === `/api/daily-review/${TODAY}/summary`) return summaryReply();
    throw new Error(`unexpected request ${String(input)}`);
  });
  useSessionStore.setState({ sessions: new Map() });
});

describe('the day', () => {
  it('opens on today and shows how much was typed', async () => {
    renderView();
    expect(await screen.findByText(/4 prompts in 3 sessions/)).toBeInTheDocument();
    expect(getCalls()[0].url.searchParams.get('day')).toBe(TODAY);
    expect(screen.getByLabelText('Day')).toHaveValue(TODAY);
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Today' })).not.toBeInTheDocument();
  });

  it('steps back a day, says when nothing was typed, and Today comes back', async () => {
    renderView();
    await screen.findByText(/4 prompts in 3 sessions/);
    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(await screen.findByText('Nothing typed on this day.')).toBeInTheDocument();
    expect(getCalls().at(-1)!.url.searchParams.get('day')).toBe(YESTERDAY);
    expect(screen.queryByRole('region', { name: 'Summary' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(await screen.findByText(/4 prompts in 3 sessions/)).toBeInTheDocument();
  });
});

describe('the groups', () => {
  it('lists projects, their rooms and sessions, with prompts folded until asked', async () => {
    renderView();
    const am = await screen.findByRole('region', { name: 'agent-manager' });
    expect(within(am).getByText('Cloud')).toBeInTheDocument();
    expect(within(am).getByText('No room')).toBeInTheDocument();
    const session = within(am).getByRole('button', { name: /Plan 18 devices/ });
    expect(session).toHaveAttribute('aria-expanded', 'false');
    expect(within(am).getByText(/2 prompts · 09:12–16:32/)).toBeInTheDocument();
    expect(screen.queryByText('help me finish all of these')).not.toBeInTheDocument();
    fireEvent.click(session);
    expect(session).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('help me finish all of these')).toBeInTheDocument();
  });

  it('shows no room heading in a project whose sessions are in no room', async () => {
    renderView();
    const site = await screen.findByRole('region', { name: 'website' });
    expect(within(site).queryByText('No room')).not.toBeInTheDocument();
    expect(within(site).getByRole('button', { name: /Terms/ })).toBeInTheDocument();
  });

  it('says where the rest of a clipped prompt is', async () => {
    const day = review(TODAY);
    const s1 = day.projects[0].rooms[0].sessions[0];
    const clipped = { ...s1, prompts: [{ id: 9, text: 'y'.repeat(4000), timestamp: at(9, 12), fullLength: 9000 }] };
    days.set(TODAY, { ...day, projects: [{ ...day.projects[0], rooms: [{ ...day.projects[0].rooms[0], sessions: [clipped] }, day.projects[0].rooms[1]] }, day.projects[1]] });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: /Plan 18 devices/ }));
    fireEvent.click(screen.getByRole('button', { name: /Show all \(9,000 chars\)/ }));
    expect(screen.getByText(/List shows the whole prompt/)).toBeInTheDocument();
  });

  it('offers Open only for a session still on the dashboard', async () => {
    useSessionStore.setState({ sessions: new Map([['s1', { sessionId: 's1' } as Session]]) });
    renderView();
    const am = await screen.findByRole('region', { name: 'agent-manager' });
    expect(within(am).getAllByRole('button', { name: 'Open this session' })).toHaveLength(1);
  });
});

describe('the summary', () => {
  it('is written when asked and shown as lines', async () => {
    renderView();
    const card = await screen.findByRole('region', { name: 'Summary' });
    fireEvent.click(within(card).getByRole('button', { name: 'Summarize' }));
    expect(await within(card).findByText(/committed plan 18/)).toBeInTheDocument();
    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
    expect(within(card).getByText(/haiku · from 4 prompts/)).toBeInTheDocument();
    const post = authFetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(String(post?.[0])).toBe(`/api/daily-review/${TODAY}/summary`);
  });

  it('offers Update when newer prompts were typed after it', async () => {
    days.set(TODAY, review(TODAY, { summary: summary({ stale: true }) }));
    renderView();
    const card = await screen.findByRole('region', { name: 'Summary' });
    expect(within(card).getByText(/the day has changed since/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Update' })).toBeInTheDocument();
  });

  it('says why when it could not be written, and keeps the button', async () => {
    summaryReply = () => reply(502, { success: false, error: 'Could not summarize: the Claude CLI isn’t installed on this Mac.' });
    renderView();
    const card = await screen.findByRole('region', { name: 'Summary' });
    fireEvent.click(within(card).getByRole('button', { name: 'Summarize' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('the Claude CLI isn’t installed on this Mac');
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Summarize' })).not.toHaveAttribute('aria-busy'));
  });

  it('shows the run in progress when the server says one is being written', async () => {
    days.set(TODAY, review(TODAY, { summarizing: true }));
    renderView();
    const card = await screen.findByRole('region', { name: 'Summary' });
    expect(within(card).getByText('Writing the summary…')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Summarizing…' })).toHaveAttribute('aria-busy', 'true');
  });
});

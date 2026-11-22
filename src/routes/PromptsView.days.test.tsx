// PromptsView.days.test.tsx — the List | Days switch on the PROMPTS tab (Nov 20 2026): it sits first
// in the toolbar of both views, swaps the list for the day view, and is remembered on this computer.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configure, render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { localDayKey } from '@/lib/dailyReview';

const { authFetch } = vi.hoisted(() => ({
  authFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock('@/hooks/useAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAuth')>()),
  authFetch,
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import PromptsView from './PromptsView';

configure({ asyncUtilTimeout: 4000 });

const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const paths = () => authFetch.mock.calls.map(([input]) => new URL(String(input), 'http://localhost').pathname);

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><PromptsView /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  authFetch.mockReset();
  authFetch.mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/db/projects') return reply([]);
    if (url.pathname === '/api/db/prompts') return reply({ prompts: [], total: 0, page: 1, pageSize: 50 });
    if (url.pathname === '/api/daily-review') {
      return reply({ day: url.searchParams.get('day'), promptCount: 0, sessionCount: 0, projectCount: 0, projects: [], summary: null, summarizing: false });
    }
    throw new Error(`unexpected request ${String(input)}`);
  });
});

describe('List | Days', () => {
  it('starts on List, and Days swaps in the day view without asking for the list again', async () => {
    renderView();
    const view = screen.getByRole('group', { name: 'View' });
    expect(within(view).getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    await screen.findByText('No prompts recorded yet.');
    const listCalls = paths().filter((p) => p === '/api/db/prompts').length;

    fireEvent.click(within(view).getByRole('button', { name: 'Days' }));
    expect(await screen.findByText('Nothing typed on this day.')).toBeInTheDocument();
    expect(screen.getByLabelText('Day')).toHaveValue(localDayKey(Date.now()));
    expect(within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name: 'Days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('searchbox', { name: 'Search all prompts' })).not.toBeInTheDocument();
    expect(paths().filter((p) => p === '/api/db/prompts').length).toBe(listCalls);
  });

  it('remembers Days on this computer', async () => {
    renderView();
    fireEvent.click(within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name: 'Days' }));
    await screen.findByText('Nothing typed on this day.');
    expect(localStorage.getItem('aasc-prompts-view')).toBe('days');
  });

  it('opens on Days when that was the last choice', async () => {
    localStorage.setItem('aasc-prompts-view', 'days');
    renderView();
    expect(await screen.findByText('Nothing typed on this day.')).toBeInTheDocument();
    expect(paths()).not.toContain('/api/db/prompts');
  });
});

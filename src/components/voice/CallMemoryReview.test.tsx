import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CallMemoryReview from './CallMemoryReview';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const item = (over: Record<string, unknown>) => ({
  id: 'm1', kind: 'correction', meant: 'central session', heard: 'central section', scope: 'global', status: 'proposed',
  callId: 'c', createdAt: 0, updatedAt: 0, lastUsedAt: null, supersedes: null, key: 'k', seenCount: 1, ...over,
});

function mockFetch(items: unknown[], projects: string[] = ['/repo/agent-manager']) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') return { ok: true, json: async () => ({ success: true, data: { items, projects } }) };
    const body = JSON.parse(String(init?.body)) as { action: string; scope?: string; meant?: string };
    const id = url.split('/').pop();
    const status = body.action === 'keep' ? 'kept' : body.action === 'skip' ? 'skipped' : 'retired';
    return { ok: true, json: async () => ({ success: true, data: { item: item({ id, status, scope: body.scope ?? 'global', meant: body.meant ?? 'central session' }) } }) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('CallMemoryReview (Nov 22 2026)', () => {
  it('shows what a call proposed with the words as heard, and keeps it with the chosen scope', async () => {
    const fetchFn = mockFetch([item({})]);
    render(<CallMemoryReview />);
    const row = await screen.findByRole('listitem', { name: /central session/ });
    expect(within(row).getByText('“central section” means central session')).toBeInTheDocument();
    fireEvent.change(within(row).getByLabelText('Use for'), { target: { value: 'project:/repo/agent-manager' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith('/api/voice/memory/m1', expect.objectContaining({ method: 'POST' })));
    const sent = JSON.parse(String(fetchFn.mock.calls.find((c) => c[1]?.method === 'POST')?.[1]?.body));
    expect(sent).toEqual({ action: 'keep', scope: 'project:/repo/agent-manager' });
    expect(await screen.findByRole('button', { name: /Forget/ })).toBeInTheDocument();
  });

  it('sends an edited meaning, and Skip drops the card', async () => {
    const fetchFn = mockFetch([item({ id: 'm2', kind: 'preference', meant: 'Open web work in worktrees', heard: 'web work in work trees' })]);
    render(<CallMemoryReview />);
    const row = await screen.findByRole('listitem', { name: /worktrees/ });
    fireEvent.click(within(row).getByRole('button', { name: /Edit/ }));
    fireEvent.change(within(row).getByLabelText('What you meant'), { target: { value: 'Use a worktree for web work' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Keep' }));
    await waitFor(() => {
      const post = fetchFn.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ action: 'keep', scope: 'global', meant: 'Use a worktree for web work' });
    });
  });

  it('skips', async () => {
    mockFetch([item({})]);
    render(<CallMemoryReview />);
    const row = await screen.findByRole('listitem', { name: /central session/ });
    fireEvent.click(within(row).getByRole('button', { name: /Skip/ }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: /central session/ })).toBeNull());
  });

  it('lists kept items to forget, and says when there is nothing', async () => {
    mockFetch([item({ status: 'kept', scope: 'project:/repo/agent-manager' })]);
    const { unmount } = render(<CallMemoryReview />);
    const row = await screen.findByRole('listitem', { name: /central session/ });
    expect(within(row).getByText('agent-manager')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /Forget/ })).toBeInTheDocument();
    unmount();
    mockFetch([item({ status: 'skipped' })]);
    render(<CallMemoryReview />);
    expect(await screen.findByText(/Nothing kept from calls yet/)).toBeInTheDocument();
  });
});

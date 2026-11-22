import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CallMemoryBanner from './CallMemoryBanner';
import { CALL_MEMORY_RECHECK_MS } from '@/lib/callMemoryClient';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const proposed = { id: 'm1', kind: 'correction', meant: 'central session', heard: 'central section', scope: 'global', status: 'proposed', createdAt: 0, seenCount: 1 };

function mockFetch(lists: unknown[][]) {
  const queue = [...lists];
  const fn = vi.fn(async () => {
    const items = queue.length > 1 ? queue.shift() : queue[0];
    return { ok: true, json: async () => ({ success: true, data: { items, projects: [] } }) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('CallMemoryBanner (Nov 22 2026)', () => {
  it('says nothing when no call left anything to review', async () => {
    const fetchFn = mockFetch([[]]);
    render(<CallMemoryBanner />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(screen.queryByText(/to review/)).toBeNull();
  });

  it('shows the count, and Review opens the list', async () => {
    mockFetch([[proposed]]);
    render(<CallMemoryBanner />);
    expect(await screen.findByText('Your call left 1 thing to review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByRole('listitem', { name: /central session/ })).toBeInTheDocument();
  });

  it('looks again shortly after a call (the suggestions come a little after hang-up)', async () => {
    const fetchFn = mockFetch([[], [proposed]]);
    render(<CallMemoryBanner />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(CALL_MEMORY_RECHECK_MS[0]); });
    expect(await screen.findByText(/1 thing to review/)).toBeInTheDocument();
  });
});

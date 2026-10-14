/**
 * Conversation search at phone width (AASC-18). A phone has no keyboard to open
 * the panel's find bar, so its toolbar carries the ▲▼ and an "n/N" position —
 * stepping through the same `.search-highlight` rows the find bar steps through
 * (the host's `onSearchStep`). A desktop toolbar is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConversationEntry } from '@/lib/transcript';

const fetchTranscript = vi.fn<() => Promise<ConversationEntry[]>>();
vi.mock('@/lib/transcript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transcript')>()),
  fetchTranscript: () => fetchTranscript(),
}));

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));

import ConversationView from './ConversationView';

const T = 1_700_000_000_000;
const ENTRIES: ConversationEntry[] = [
  { role: 'user', text: 'keep the queue panel collapsed', timestamp: T + 1 },
  { role: 'user', text: 'make the queue work on a phone', timestamp: T + 2 },
  { role: 'user', text: 'run the tests', timestamp: T + 3 },
  { role: 'user', text: 'and the queue history sheet', timestamp: T + 4 },
];

function renderView(props: Partial<React.ComponentProps<typeof ConversationView>> = {}) {
  return render(
    <ConversationView sessionId="s1" prompts={[]} responses={[]} toolCalls={[]} events={[]} {...props} />,
  );
}
const toolbar = () => document.querySelector('[data-conv-toolbar]') as HTMLElement;

beforeEach(() => {
  platform.isMobile = true;
  fetchTranscript.mockReset();
  fetchTranscript.mockResolvedValue(ENTRIES);
  localStorage.clear();
});

describe('ConversationView search on a phone', () => {
  it('steps through the matches with ▲▼ and says where it is', async () => {
    const onSearchStep = vi.fn();
    const { container, rerender } = renderView({ searchQuery: '', onSearchChange: vi.fn(), searchMatchIndex: 0, onSearchStep });
    await waitFor(() => expect(container.querySelectorAll('[class*="convEntry"]').length).toBe(4));
    expect(screen.queryByRole('button', { name: 'Next match' })).toBeNull(); // nothing to step yet

    rerender(
      <ConversationView sessionId="s1" prompts={[]} responses={[]} toolCalls={[]} events={[]}
        searchQuery="queue" onSearchChange={vi.fn()} searchMatchIndex={0} onSearchStep={onSearchStep} />,
    );
    await waitFor(() => expect(container.querySelectorAll('.search-highlight').length).toBe(3));
    expect(screen.getByTestId('conv-search-count').textContent).toBe('1/3');

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(onSearchStep.mock.calls).toEqual([['next'], ['prev']]);

    rerender(
      <ConversationView sessionId="s1" prompts={[]} responses={[]} toolCalls={[]} events={[]}
        searchQuery="queue" onSearchChange={vi.fn()} searchMatchIndex={1} onSearchStep={onSearchStep} />,
    );
    expect(screen.getByTestId('conv-search-count').textContent).toBe('2/3');
    // Matches only, the field and its clear button are all in the toolbar too.
    expect(screen.getByRole('button', { name: 'Matches only' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
    expect(toolbar().contains(screen.getByRole('button', { name: 'Next match' }))).toBe(true);
  });

  it('with no matches: says so and the arrows are off', async () => {
    renderView({ searchQuery: 'zebra', onSearchChange: vi.fn(), searchMatchIndex: 0, onSearchStep: vi.fn() });
    await waitFor(() => expect(screen.getByTestId('conv-search-count').textContent).toBe('No matches'));
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous match' })).toBeDisabled();
  });

  it('a desktop toolbar keeps its count and has no arrows of its own (the find bar has them)', async () => {
    platform.isMobile = false;
    renderView({ searchQuery: 'queue', onSearchChange: vi.fn(), searchMatchIndex: 0, onSearchStep: vi.fn() });
    await waitFor(() => expect(screen.getByTestId('conv-search-count').textContent).toBe('3 matches'));
    expect(screen.queryByRole('button', { name: 'Next match' })).toBeNull();
  });
});

/**
 * Conversation-tab search.
 *
 * The property under test throughout is that ONE rule decides everything: the
 * rows rendered, the number in the toolbar, and the `.search-highlight` nodes
 * DetailPanel's ▲▼ navigation steps through must always describe the same set.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ConversationEntry } from '@/lib/transcript';

const fetchTranscript = vi.fn<() => Promise<ConversationEntry[]>>();
vi.mock('@/lib/transcript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transcript')>();
  return { ...actual, fetchTranscript: () => fetchTranscript() };
});

import ConversationView from './ConversationView';

const T = 1_700_000_000_000;

const ENTRIES: ConversationEntry[] = [
  { role: 'user', text: 'move these two videos into one folder', timestamp: T + 1 },
  { role: 'assistant', text: 'I will find them first.', timestamp: T + 2 },
  { role: 'tool_use', tool: 'Bash', input: 'mdfind -name "Screen Recording"', timestamp: T + 3 },
  { role: 'tool_result', tool: 'Bash', output: '/opt/homebrew/bin/ffmpeg', timestamp: T + 4 },
  { role: 'assistant', text: 'ffmpeg is available, converting now.', timestamp: T + 5 },
  { role: 'event', eventType: 'Stop', detail: 'turn complete', timestamp: T + 6 },
];

function renderView(props: Partial<React.ComponentProps<typeof ConversationView>> = {}) {
  return render(
    <ConversationView
      sessionId="s1"
      prompts={[]}
      responses={[]}
      toolCalls={[]}
      events={[]}
      {...props}
    />,
  );
}

const rowCount = (c: HTMLElement) => c.querySelectorAll('[class*="convEntry"]').length;
const highlightCount = (c: HTMLElement) => c.querySelectorAll('.search-highlight').length;
const markTexts = (c: HTMLElement) => Array.from(c.querySelectorAll('mark')).map((m) => m.textContent);

async function typeSearch(value: string) {
  fireEvent.change(screen.getByTestId('conv-search-input'), { target: { value } });
}

beforeEach(() => {
  fetchTranscript.mockReset();
  fetchTranscript.mockResolvedValue(ENTRIES);
});

describe('ConversationView search', () => {
  it('shows every entry until a query is typed', async () => {
    const { container } = renderView();
    await waitFor(() => expect(rowCount(container)).toBe(ENTRIES.length));
    expect(screen.queryByTestId('conv-search-count')).toBeNull();
  });

  it('narrows to matching entries and reports an honest count', async () => {
    const { container } = renderView();
    await waitFor(() => expect(rowCount(container)).toBe(6));

    await typeSearch('ffmpeg');

    // tool_result output + assistant text — and nothing else.
    await waitFor(() => expect(rowCount(container)).toBe(2));
    expect(screen.getByTestId('conv-search-count').textContent).toBe('2 matches');
    // The counter, the rendered rows and the nodes ▲▼ steps through agree.
    expect(highlightCount(container)).toBe(2);
  });

  it('marks the matched substring, preserving its original casing', async () => {
    const { container } = renderView();
    await waitFor(() => expect(rowCount(container)).toBe(6));

    await typeSearch('Screen');
    await waitFor(() => expect(markTexts(container)).toEqual(['Screen']));
  });

  it('searches tool names and inputs, not just prose', async () => {
    const { container } = renderView();
    await waitFor(() => expect(rowCount(container)).toBe(6));

    await typeSearch('mdfind');
    await waitFor(() => expect(rowCount(container)).toBe(1));
    expect(container.textContent).toContain('Bash');
  });

  it('keeps the whole thread when MATCHES ONLY is switched off, still highlighting hits', async () => {
    const { container } = renderView();
    await waitFor(() => expect(rowCount(container)).toBe(6));

    await typeSearch('ffmpeg');
    await waitFor(() => expect(rowCount(container)).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: /matches only/i }));

    await waitFor(() => expect(rowCount(container)).toBe(6));
    // Count and highlight nodes still describe the matches, not the rows shown.
    expect(screen.getByTestId('conv-search-count').textContent).toBe('2 matches');
    expect(highlightCount(container)).toBe(2);
  });

  it('ANDs the search with the role filter', async () => {
    const { container } = renderView();
    await waitFor(() => expect(rowCount(container)).toBe(6));

    await typeSearch('ffmpeg');
    await waitFor(() => expect(rowCount(container)).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: 'Asst' }));

    // The tool_result drops out; only the assistant match survives.
    await waitFor(() => expect(rowCount(container)).toBe(1));
    expect(screen.getByTestId('conv-search-count').textContent).toBe('1 match');
  });

  it('says which query found nothing, and offers a way out', async () => {
    const { container } = renderView();
    await waitFor(() => expect(rowCount(container)).toBe(6));

    await typeSearch('zzz-nothing-here');

    await waitFor(() => expect(container.textContent).toContain('No entries match'));
    expect(container.textContent).toContain('zzz-nothing-here');
    expect(screen.getByTestId('conv-search-count').textContent).toBe('No matches');

    // The empty state's own escape hatch (distinct from the ✕ in the input).
    fireEvent.click(screen.getByText('clear search'));
    await waitFor(() => expect(rowCount(container)).toBe(6));
  });

  it('clears from the ✕ inside the search box', async () => {
    const { container } = renderView();
    await waitFor(() => expect(rowCount(container)).toBe(6));

    await typeSearch('ffmpeg');
    await waitFor(() => expect(rowCount(container)).toBe(2));

    fireEvent.click(screen.getByLabelText('Clear search'));
    await waitFor(() => expect(rowCount(container)).toBe(6));
  });

  it('ignores an all-whitespace query instead of matching everything', async () => {
    const { container } = renderView();
    await waitFor(() => expect(rowCount(container)).toBe(6));

    await typeSearch('   ');

    await waitFor(() => expect(rowCount(container)).toBe(6));
    expect(screen.queryByTestId('conv-search-count')).toBeNull();
  });

  it('reports the match count to the host so its find bar agrees', async () => {
    const onMatchCountChange = vi.fn();
    const { container } = renderView({ onMatchCountChange });
    await waitFor(() => expect(rowCount(container)).toBe(6));

    await typeSearch('ffmpeg');

    await waitFor(() => expect(onMatchCountChange).toHaveBeenLastCalledWith(2));
  });

  it('is controlled by the host when onSearchChange is supplied', async () => {
    const onSearchChange = vi.fn();
    const { container, rerender } = render(
      <ConversationView
        sessionId="s1"
        prompts={[]} responses={[]} toolCalls={[]} events={[]}
        searchQuery=""
        onSearchChange={onSearchChange}
      />,
    );
    await waitFor(() => expect(rowCount(container)).toBe(6));

    await typeSearch('ffmpeg');
    // The host owns the value: nothing filters until it flows back down.
    expect(onSearchChange).toHaveBeenCalledWith('ffmpeg');
    expect(rowCount(container)).toBe(6);

    rerender(
      <ConversationView
        sessionId="s1"
        prompts={[]} responses={[]} toolCalls={[]} events={[]}
        searchQuery="ffmpeg"
        onSearchChange={onSearchChange}
      />,
    );
    await waitFor(() => expect(rowCount(container)).toBe(2));
  });

  it('hides archived prior sessions while a narrowing search is active', async () => {
    const previousSessions = [
      { sessionId: 'old-1', startedAt: T - 100, endedAt: T - 50, promptHistory: [{ text: 'older work', timestamp: T - 90 }] },
    ];
    const { container } = renderView({ previousSessions });
    await waitFor(() => expect(container.textContent).toContain('Previous Session #1'));

    await typeSearch('ffmpeg');
    await waitFor(() => expect(container.textContent).not.toContain('Previous Session #1'));

    // They come back in context mode.
    fireEvent.click(screen.getByRole('button', { name: /matches only/i }));
    await waitFor(() => expect(container.textContent).toContain('Previous Session #1'));
  });
});

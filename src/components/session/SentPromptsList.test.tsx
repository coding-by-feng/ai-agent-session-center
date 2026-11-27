// SentPromptsList.test.tsx — the queue History sheet's Sent tab (Nov 27 2026): what this session was sent,
// typed or queued, newest first; Queue again adds a Once item; older pages load on request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import QueueHistorySheet from './QueueHistorySheet';
import { useSessionStore } from '@/stores/sessionStore';
import { useQueueStore } from '@/stores/queueStore';
import { useQueueHistoryStore } from '@/stores/queueHistoryStore';
import type { Session } from '@/types';

const platform = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('./QueueItemEditModal', () => ({ default: () => null }));

type Row = { text: string; timestamp: number };
let pages: Record<number, { prompts: Row[]; total: number } | 'fail'>;
const asked: string[] = [];

beforeEach(() => {
  asked.length = 0;
  pages = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    asked.push(url);
    const page = Number(new URL(url, 'http://x').searchParams.get('page'));
    const answer = pages[page];
    if (!answer || answer === 'fail') return new Response('', { status: answer === 'fail' ? 429 : 200 });
    return new Response(JSON.stringify({ prompts: answer.prompts.map((p, i) => ({ id: i, session_id: 's1', ...p })), total: answer.total, page, pageSize: 50 }));
  }));
  useSessionStore.setState({
    sessions: new Map([['s1', {
      sessionId: 's1', title: 'AASC', status: 'waiting',
      promptHistory: [{ text: 'typed in the terminal', timestamp: 2000 }, { text: '<task-notification>x</task-notification>', timestamp: 2500 }],
    } as unknown as Session]]),
  });
  useQueueStore.setState({ queues: new Map([['s1', []]]) });
  useQueueHistoryStore.setState({ entries: [] } as Partial<ReturnType<typeof useQueueHistoryStore.getState>>);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const open = () => render(<QueueHistorySheet open onClose={vi.fn()} currentSessionId="s1" currentSessionTitle="AASC" />);
const rows = () => screen.queryAllByTestId('sent-row').map((r) => within(r).getByRole('button', { expanded: false, hidden: true }).textContent ?? r.textContent);

describe('History → Sent to this session', () => {
  it('opens on Sent and lists typed and queued prompts, newest first, without harness rows', async () => {
    pages[1] = { prompts: [{ text: 'typed in the terminal', timestamp: 2000 }, { text: 'sent from the queue', timestamp: 1000 }], total: 2 };
    open();
    expect(screen.getByRole('tab', { name: 'Sent to this session' })).toHaveAttribute('aria-selected', 'true');
    // The card's prompts show before the record answers.
    expect(rows()).toEqual(['typed in the terminal']);
    await waitFor(() => expect(rows()).toEqual(['typed in the terminal', 'sent from the queue']));
    expect(asked[0]).toContain('/api/db/prompts?session=s1&kind=mine');
    expect(screen.queryByRole('button', { name: 'Load earlier' })).toBeNull();
  });

  it('loads earlier pages on request', async () => {
    pages[1] = { prompts: [{ text: 'typed in the terminal', timestamp: 2000 }], total: 51 };
    pages[2] = { prompts: [{ text: 'the very first prompt', timestamp: 1 }], total: 51 };
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier' }));
    await waitFor(() => expect(rows()).toEqual(['typed in the terminal', 'the very first prompt']));
    expect(screen.queryByRole('button', { name: 'Load earlier' })).toBeNull();
  });

  it('Queue again adds a Once item to this session’s queue', async () => {
    pages[1] = { prompts: [], total: 0 };
    open();
    await waitFor(() => expect(asked).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Queue again' }));
    const queue = useQueueStore.getState().queues.get('s1') ?? [];
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ text: 'typed in the terminal', type: 'once', sessionId: 's1', position: 0 });
  });

  it('keeps the card’s prompts and says so when the record can’t be read', async () => {
    pages[1] = 'fail';
    open();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Too many requests/);
    expect(rows()).toEqual(['typed in the terminal']);
  });

  it('shows only the new session’s prompts after a switch, and a late page of the old one is dropped (review, Nov 27 2026)', async () => {
    useSessionStore.setState({
      sessions: new Map([
        ['s1', { sessionId: 's1', title: 'AASC', status: 'waiting', promptHistory: [{ text: 'typed in the terminal', timestamp: 2000 }] } as unknown as Session],
        ['s2', { sessionId: 's2', title: 'Other', status: 'waiting', promptHistory: [{ text: 'other session prompt', timestamp: 3000 }] } as unknown as Session],
      ]),
    });
    pages[1] = { prompts: [{ text: 'from s1 record', timestamp: 1000 }], total: 51 };
    pages[2] = { prompts: [{ text: 's1 page two', timestamp: 500 }], total: 51 };
    let release: (() => void) | undefined;
    const slow = new Promise<void>((r) => { release = r; });
    const base = globalThis.fetch as unknown as (u: string) => Promise<Response>;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('page=2')) {
        await slow;
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      }
      if (url.includes('session=s2')) {
        asked.push(url);
        return new Response(JSON.stringify({ prompts: [], total: 0, page: 1, pageSize: 50 }));
      }
      return base(url);
    }));
    const view = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier' }));
    view.rerender(<QueueHistorySheet open onClose={vi.fn()} currentSessionId="s2" currentSessionTitle="Other" />);
    expect(rows()).toEqual(['other session prompt']);
    release?.();
    await waitFor(() => expect(asked.some((u) => u.includes('session=s2'))).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(rows()).toEqual(['other session prompt']);
  });

  it('filters, and the Saved tab still holds the favourites', async () => {
    pages[1] = { prompts: [{ text: 'sent from the queue', timestamp: 1000 }], total: 1 };
    open();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(screen.getByLabelText('Filter sent prompts'), { target: { value: 'queue' } });
    expect(rows()).toEqual(['sent from the queue']);
    fireEvent.click(screen.getByRole('tab', { name: 'Saved' }));
    expect(screen.getByText(/No saved items yet/)).toBeTruthy();
    expect(screen.queryByTestId('sent-prompts')).toBeNull();
  });
});

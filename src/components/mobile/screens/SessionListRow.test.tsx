// SessionListRow.test.tsx — the queue count on a phone session row (Oct 21 2026): how many
// prompts wait in that session's queue, from the shared queueStore as the desktop rail
// counts them; nothing at all when the queue is empty, and the count is in the row's name.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { Session } from '@/types';
import SessionListRow from './SessionListRow';
import { useQueueStore, type QueueItem } from '@/stores/queueStore';
import { useRoomStore } from '@/stores/roomStore';

const NOW = 1_800_000_000_000;

const session = { sessionId: 's1', title: 'AASC Phone APP', status: 'working', projectName: 'agent-manager', cliSource: 'claude', lastActivityAt: NOW } as unknown as Session;

const items = (n: number): QueueItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, sessionId: 's1', text: `prompt ${i + 1}`, position: i, createdAt: NOW }));

const row = () => screen.getByTestId('session-row-s1');
const pill = () => screen.queryByTestId('session-queue-s1');

function renderRow() {
  return render(<ul><SessionListRow session={session} onOpen={vi.fn()} now={NOW} /></ul>);
}

beforeEach(() => {
  useQueueStore.setState({ queues: new Map() });
  useRoomStore.setState({ rooms: [] });
});

describe('SessionListRow — queued prompts', () => {
  it('shows how many prompts are queued, and says so in the row’s name', () => {
    useQueueStore.setState({ queues: new Map([['s1', items(3)]]) });
    renderRow();
    expect(pill()?.textContent).toBe('3');
    expect(row().getAttribute('aria-label')).toContain('3 queued prompts');
  });

  it('says “1 queued prompt” for one', () => {
    useQueueStore.setState({ queues: new Map([['s1', items(1)]]) });
    renderRow();
    expect(row().getAttribute('aria-label')).toContain('1 queued prompt,');
  });

  it('shows nothing when the queue is empty', () => {
    useQueueStore.setState({ queues: new Map([['s1', []]]) });
    renderRow();
    expect(pill()).toBeNull();
    expect(row().getAttribute('aria-label')).not.toContain('queued');
  });

  it('follows the queue as prompts are added and sent', () => {
    renderRow();
    expect(pill()).toBeNull();
    act(() => useQueueStore.setState({ queues: new Map([['s1', items(2)]]) }));
    expect(pill()?.textContent).toBe('2');
    act(() => useQueueStore.setState({ queues: new Map([['s1', []]]) }));
    expect(pill()).toBeNull();
  });

  it('counts only this session’s queue', () => {
    useQueueStore.setState({ queues: new Map([['other', items(4)]]) });
    renderRow();
    expect(pill()).toBeNull();
  });
});

// Oct 23 2026: a session whose last answer asks "Reply proceed…" shows a filled amber P until someone replies.
describe('SessionListRow — asks you to proceed', () => {
  function renderWith(over: Partial<Session>) {
    return render(<ul><SessionListRow session={{ ...session, ...over } as Session} onOpen={vi.fn()} now={NOW} /></ul>);
  }

  it('shows the P ring and says so in the row’s name', () => {
    renderWith({ status: 'idle', pendingProceedAt: NOW - 60_000 });
    const ring = row().querySelector('[data-tone]');
    expect(ring?.getAttribute('data-tone')).toBe('approval');
    expect(ring?.hasAttribute('data-proceed')).toBe(true);
    expect(row().getAttribute('aria-label')).toContain('Asks you to proceed');
  });

  it('shows the plain status once nobody owes a reply', () => {
    renderWith({ status: 'idle', pendingProceedAt: null });
    expect(row().querySelector('[data-proceed]')).toBeNull();
    expect(row().getAttribute('aria-label')).toContain('Idle');
  });
});

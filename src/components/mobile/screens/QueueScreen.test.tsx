// QueueScreen.test.tsx — the phone's Queue tab (AASC-47): who sends queued
// prompts, every session's queue with its automation state, the edit form, ⚡,
// reorder (hold and drag, or the arrow keys), move, delete with a confirm. The
// send is mocked at its helper: nothing here reaches a terminal.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/types';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/chat/queueSendNow', () => ({ sendQueueItemNow: vi.fn(async () => true) }));
vi.mock('@/lib/deviceIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/deviceIdentity')>()),
  getClientId: () => 'phone',
}));
vi.mock('@/components/session/QueueItemEditModal', () => ({
  default: ({ item, onClose, onSave }: { item: { text: string }; onClose: () => void; onSave: (p: { text: string }) => void }) => (
    <div role="dialog" aria-label="Edit queue item">
      <span>{item.text}</span>
      <button type="button" onClick={() => onSave({ text: 'edited' })}>Save</button>
      <button type="button" onClick={onClose}>Close</button>
    </div>
  ),
}));

import QueueScreen, { REORDER_HOLD_MS } from './QueueScreen';
import { DEFAULT_AUTOMATION, useQueueStore, type QueueItem } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { usePhoneNavStore, defaultStacks } from '@/stores/phoneNavStore';
import { sendQueueItemNow } from '@/lib/chat/queueSendNow';

const sess = (id: string, title: string, status = 'idle') =>
  ({ sessionId: id, title, projectName: title, status, terminalId: `term-${id}`, lastActivityAt: 0 }) as unknown as Session;
const qi = (id: number, sessionId: string, text: string, position: number, over: Partial<QueueItem> = {}): QueueItem =>
  ({ id, sessionId, text, position, createdAt: 0, ...over });

const mac = { clientId: 'mac', label: 'MacBook', address: '', isLocal: true, connections: 1, connectedAt: 0, lastSeenAt: 0 };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  useSessionStore.setState({ sessions: new Map([['s1', sess('s1', 'web')], ['s2', sess('s2', 'api', 'approval')], ['s3', sess('s3', 'docs')]]) });
  useQueueStore.setState({
    queues: new Map([
      ['s1', [qi(1, 's1', 'first prompt', 0), qi(2, 's1', 'second prompt', 1), qi(3, 's1', 'nightly check', 2, { type: 'loop', intervalMs: 3_600_000 })]],
      ['s2', [qi(4, 's2', 'api prompt', 0)]],
    ]),
    automation: new Map([['s2', { ...DEFAULT_AUTOMATION, paused: true }]]),
  });
  usePresenceStore.getState().applyPresence({ devices: [mac], controllers: [], restoreOwner: 'mac', workspaceWriter: 'mac' });
  usePhoneNavStore.setState({ tab: 'queue', stacks: defaultStacks() });
  vi.mocked(sendQueueItemNow).mockClear();
});

afterEach(() => vi.unstubAllGlobals());

const order = (sessionId: string) => (useQueueStore.getState().queues.get(sessionId) ?? []).slice().sort((a, b) => a.position - b.position).map((i) => i.id);

describe('QueueScreen', () => {
  it('says the Mac sends queued prompts while AASC is open there', () => {
    render(<QueueScreen />);
    expect(screen.getByText('Your Mac sends queued prompts')).toBeTruthy();
    expect(screen.getByText(/AASC is open on your Mac/)).toBeTruthy();
  });

  it('asks to open AASC on the Mac when no writer is connected', () => {
    usePresenceStore.getState().applyPresence({ devices: [], controllers: [], restoreOwner: null, workspaceWriter: null });
    render(<QueueScreen />);
    expect(screen.getByText('Open AASC on your Mac')).toBeTruthy();
  });

  it('groups every session\'s queue in the desktop order, with its automation state', () => {
    render(<QueueScreen />);
    const headers = screen.getAllByRole('button', { name: /Open its queue/ }).map((b) => b.getAttribute('aria-label'));
    expect(headers).toEqual([
      'api, 1 queued, Waiting for you: answer the waiting approval first. Open its queue',
      'web, 3 queued, Auto-send on · Auto-Enter on. Open its queue',
    ]);
    expect(screen.getByTestId('queue-row-3').textContent).toContain('Every 1 h');
  });

  it('opens a session\'s own queue from its header', async () => {
    const user = userEvent.setup();
    render(<QueueScreen />);
    await user.click(screen.getByRole('button', { name: /^web, 3 queued/ }));
    expect(usePhoneNavStore.getState().stacks.queue.at(-1)).toBe('/sessions/s1/info/queue');
  });

  it('opens the full edit form on a tap and saves its changes', async () => {
    const user = userEvent.setup();
    render(<QueueScreen />);
    await user.click(screen.getByRole('button', { name: /^Prompt 2 for web: second prompt/ }));
    const form = screen.getByRole('dialog', { name: 'Edit queue item' });
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(useQueueStore.getState().queues.get('s1')?.find((i) => i.id === 2)?.text).toBe('edited');
  });

  it('sends a prompt now with ⚡', async () => {
    const user = userEvent.setup();
    render(<QueueScreen />);
    await user.click(screen.getByRole('button', { name: 'Send prompt 1 for web now' }));
    expect(sendQueueItemNow).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }), expect.objectContaining({ id: 1 }));
  });

  it('blocks ⚡ while the session waits on an approval, and says why', async () => {
    render(<QueueScreen />);
    const bolt = screen.getByRole('button', { name: /^Send prompt 1 for api now/ });
    expect(bolt).toHaveAttribute('aria-disabled', 'true');
    expect(bolt.getAttribute('aria-label')).toContain('Answer the waiting approval first.');
    expect(screen.getByRole('button', { name: 'Send prompt 1 for web now' })).not.toHaveAttribute('aria-disabled');
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Prompt 1 for api:/ }));
    const item = await screen.findByRole('menuitem', { name: /Send now/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item.textContent).toContain('Answer the waiting approval first.');
  });

  it('reorders with the arrow keys on the handle', async () => {
    render(<QueueScreen />);
    const handle = screen.getByRole('button', { name: /^Reorder prompt 1 for web/ });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(order('s1')).toEqual([2, 1, 3]);
    fireEvent.keyDown(screen.getByRole('button', { name: /^Reorder prompt 2 for web/ }), { key: 'ArrowUp' });
    expect(order('s1')).toEqual([1, 2, 3]);
  });

  it('reorders by holding the handle and dragging', () => {
    vi.useFakeTimers();
    try {
      render(<QueueScreen />);
      const handle = screen.getByRole('button', { name: /^Reorder prompt 1 for web/ });
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 100, pointerType: 'touch' });
      act(() => { vi.advanceTimersByTime(REORDER_HOLD_MS + 10); });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10, clientY: 100 + 64 * 2 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 10, clientY: 100 + 64 * 2 });
      expect(order('s1')).toEqual([2, 3, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reorder when the finger moves before the hold (a scroll)', () => {
    vi.useFakeTimers();
    try {
      render(<QueueScreen />);
      const handle = screen.getByRole('button', { name: /^Reorder prompt 1 for web/ });
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 100, pointerType: 'touch' });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10, clientY: 160 });
      act(() => { vi.advanceTimersByTime(REORDER_HOLD_MS + 10); });
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 10, clientY: 160 });
      expect(order('s1')).toEqual([1, 2, 3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a held grip is a drag, never the row\'s long-press menu', () => {
    render(<QueueScreen />);
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Reorder prompt 1 for web/ }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('ends the drag when the held prompt leaves the queue', () => {
    vi.useFakeTimers();
    try {
      render(<QueueScreen />);
      const handle = screen.getByRole('button', { name: /^Reorder prompt 1 for web/ });
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 100, pointerType: 'touch' });
      act(() => { vi.advanceTimersByTime(REORDER_HOLD_MS + 10); });
      expect(screen.getByTestId('queue-row-1')).toHaveAttribute('data-dragging');
      act(() => { useQueueStore.getState().remove('s1', 1); });
      expect(screen.getByTestId('queue-row-2')).not.toHaveAttribute('data-reordering');
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes only after a confirm, from the long-press menu', async () => {
    const user = userEvent.setup();
    render(<QueueScreen />);
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Prompt 1 for web: first prompt/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    expect(order('s1')).toEqual([1, 2, 3]);
    const confirm = await screen.findByRole('dialog', { name: 'Delete this prompt?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(order('s1')).toEqual([2, 3]);
  });

  it('moves a prompt to another session', async () => {
    const user = userEvent.setup();
    render(<QueueScreen />);
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Prompt 1 for web: first prompt/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to another session…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Move to another session' });
    await user.click(within(sheet).getByRole('button', { name: /docs/ }));
    await waitFor(() => expect(order('s3')).toEqual([1]));
  });

  it('queues a new prompt through a session\'s own queue', async () => {
    const user = userEvent.setup();
    render(<QueueScreen />);
    await user.click(screen.getByRole('button', { name: 'Queue a prompt' }));
    const sheet = await screen.findByRole('dialog', { name: 'Queue a prompt for…' });
    await user.click(within(sheet).getByRole('button', { name: /^docs/ }));
    expect(usePhoneNavStore.getState().stacks.queue.at(-1)).toBe('/sessions/s3/info/queue');
  });

  it('says when nothing is queued', () => {
    useQueueStore.setState({ queues: new Map() });
    render(<QueueScreen />);
    expect(screen.getByText('Nothing queued')).toBeTruthy();
  });
});

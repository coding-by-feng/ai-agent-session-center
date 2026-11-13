/**
 * The compose row's "Take the text from Claude's input box" (Nov 13 2026): dictate into Claude with
 * hold-Space (or type there), then one click moves the text into the queue box. Nothing is added.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const take = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/takeTerminalInput', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/takeTerminalInput')>()),
  takeTerminalInput: take,
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: toast }));
vi.mock('./QueueItemEditModal', () => ({ default: () => null }));
vi.mock('./QueueMovePicker', () => ({ default: () => null, MOVE_TRIGGER_ATTR: 'data-move-trigger' }));
vi.mock('./QueueHistorySheet', () => ({ default: () => null }));
vi.mock('./LoopExcludeWindowsModal', () => ({ default: () => null }));

import QueueTab from './QueueTab';
import { useQueueStore } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';

const SID = 'session-take-input';
const LABEL = "Take the text from Claude's input box";

function seed(cliSource: string) {
  useSessionStore.setState({
    sessions: new Map([[SID, { sessionId: SID, terminalId: 'term-1', status: 'working', cliSource, events: [] } as never]]),
    selectedSessionId: SID,
  });
}

describe('QueueTab — take the text from Claude\'s input box', () => {
  beforeEach(() => {
    take.mockReset();
    toast.mockReset();
    useQueueStore.setState({ queues: new Map(), automation: new Map(), composeDrafts: new Map() });
  });
  afterEach(() => cleanup());

  it('is offered on a Claude card with a terminal, not on Codex or without a terminal', () => {
    seed('claude');
    const { unmount } = render(<QueueTab sessionId={SID} sessionStatus="working" terminalId="term-1" />);
    expect(screen.getByRole('button', { name: LABEL })).toBeInTheDocument();
    unmount();
    render(<QueueTab sessionId={SID} sessionStatus="working" terminalId={null} />);
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
    cleanup();
    seed('codex');
    render(<QueueTab sessionId={SID} sessionStatus="working" terminalId="term-1" />);
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
  });

  it('moves the dictated text into the box and adds nothing to the queue', async () => {
    seed('claude');
    take.mockResolvedValue({ kind: 'text', text: 'fix the queue please', cleared: true });
    const user = userEvent.setup();
    render(<QueueTab sessionId={SID} sessionStatus="working" terminalId="term-1" />);
    const box = screen.getByPlaceholderText(/Add a prompt to the queue/i);
    await user.type(box, 'first');
    await user.click(screen.getByRole('button', { name: LABEL }));
    await waitFor(() => expect(box).toHaveValue('first fix the queue please'));
    expect(take).toHaveBeenCalledWith('term-1');
    expect(useQueueStore.getState().queues.get(SID) ?? []).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('says when Claude\'s box is empty, and warns when the text could not be cleared there', async () => {
    seed('claude');
    const user = userEvent.setup();
    render(<QueueTab sessionId={SID} sessionStatus="working" terminalId="term-1" />);
    take.mockResolvedValueOnce({ kind: 'empty' });
    await user.click(screen.getByRole('button', { name: LABEL }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining('empty'), 'info', expect.any(Number)));
    take.mockResolvedValueOnce({ kind: 'text', text: 'kept', cleared: false });
    await user.click(screen.getByRole('button', { name: LABEL }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("Claude's box still has text"), 'warning', expect.any(Number)));
    expect(screen.getByPlaceholderText(/Add a prompt to the queue/i)).toHaveValue('kept');
  });

  it('keeps text typed in the queue box while the take was in flight', async () => {
    seed('claude');
    let finish: (v: unknown) => void = () => {};
    take.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<QueueTab sessionId={SID} sessionStatus="working" terminalId="term-1" />);
    const box = screen.getByPlaceholderText(/Add a prompt to the queue/i);
    await user.click(box);
    await user.click(screen.getByRole('button', { name: LABEL }));
    await user.type(box, 'typed meanwhile');
    finish({ kind: 'text', text: 'dictated', cleared: true });
    await waitFor(() => expect(box).toHaveValue('typed meanwhile dictated'));
  });
});

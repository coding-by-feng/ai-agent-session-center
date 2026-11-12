/**
 * ⌘/Ctrl+Enter in the QUEUE compose box adds the prompt, exactly like ADD —
 * including while the `/` command list is open (e.g. "/clear").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import QueueTab from './QueueTab';
import { useQueueStore } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';

// A real `/` list: the menu must have rows for the "menu open" case to mean anything.
vi.mock('@/lib/commandIndex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/commandIndex')>()),
  fetchCommandIndex: vi.fn(async () => [
    { name: 'clear', description: 'Clear the conversation', cli: 'claude', kind: 'command', source: 'builtin' },
    { name: 'clear-cache', description: 'Another clear', cli: 'claude', kind: 'command', source: 'builtin' },
  ]),
}));

vi.mock('./QueueItemEditModal', () => ({ default: () => null }));
vi.mock('./QueueMovePicker', () => ({ default: () => null, MOVE_TRIGGER_ATTR: 'data-move-trigger' }));
vi.mock('./QueueHistorySheet', () => ({ default: () => null }));
vi.mock('./LoopExcludeWindowsModal', () => ({ default: () => null }));

const SID = 'session-cmd-enter';
const queued = () => (useQueueStore.getState().queues.get(SID) ?? []).map((i) => i.text);

describe('QueueTab — ⌘/Ctrl+Enter adds like ADD', () => {
  beforeEach(() => {
    useQueueStore.setState({ queues: new Map(), automation: new Map(), composeDrafts: new Map() });
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
  });
  afterEach(() => cleanup());

  it.each([
    ['⌘+Enter', '{Meta>}{Enter}{/Meta}'],
    ['Ctrl+Enter', '{Control>}{Enter}{/Control}'],
  ])('%s adds plain text and clears the box', async (_label, keys) => {
    const user = userEvent.setup();
    render(<QueueTab sessionId={SID} sessionStatus="idle" terminalId={null} />);
    const box = screen.getByPlaceholderText(/Add a prompt to the queue/i);
    await user.type(box, 'hello world');
    await user.keyboard(keys);
    await waitFor(() => expect(queued()).toEqual(['hello world']));
    expect(box).toHaveValue('');
  });

  it.each([
    ['⌘+Enter', '{Meta>}{Enter}{/Meta}'],
    ['Ctrl+Enter', '{Control>}{Enter}{/Control}'],
  ])('%s adds a /command typed with the command list open', async (_label, keys) => {
    const user = userEvent.setup();
    render(<QueueTab sessionId={SID} sessionStatus="idle" terminalId={null} />);
    const box = screen.getByPlaceholderText(/Add a prompt to the queue/i);
    await user.type(box, '/clear');
    // The list is really open with rows before the shortcut is pressed.
    await screen.findByText('Clear the conversation');
    await user.keyboard(keys);
    await waitFor(() => expect(queued()).toEqual(['/clear']));
    expect(box).toHaveValue('');
  });
});

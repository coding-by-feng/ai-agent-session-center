// ChatView.test.tsx — the phone chat (AASC-41): opens on the newest page, draws
// prompts / replies / folded tool rows, keeps a failure visible, pulls a queued
// prompt back into the draft, says when there is no transcript, searches with
// previous / next, reads again when the session moves, and Stop writes Esc only
// when this phone may type.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/types';
import type { ChatEntry, ChatPage } from '@/types/chat';
import type { ApiResult, PageCursor } from '@/lib/chat/chatApi';

const fetchChatPage = vi.fn<(id: string, cursor?: PageCursor) => Promise<ApiResult<ChatPage>>>();
vi.mock('@/lib/chat/chatApi', () => ({ fetchChatPage: (id: string, cursor?: PageCursor) => fetchChatPage(id, cursor) }));

const writeTerminal = vi.fn(async () => ({ ok: true as const }));
vi.mock('@/lib/terminalCompose', async (orig) => ({
  ...(await orig<typeof import('@/lib/terminalCompose')>()),
  writeTerminal: (...args: unknown[]) => writeTerminal(...(args as [])),
}));

const baton = { mode: 'solo', holder: undefined as { label: string } | undefined };
vi.mock('@/hooks/useControlBaton', () => ({ useControlBaton: () => baton }));

const { default: ChatView } = await import('./ChatView');
const { useChatStore } = await import('@/stores/chatStore');
const { useQueueStore } = await import('@/stores/queueStore');
const { useComposerDraftStore } = await import('@/stores/composerDraftStore');
const { useWsStore } = await import('@/stores/wsStore');
const { ScreenSlotContext } = await import('../kit');

/** This device's socket, as the terminal peek sees it: records what is sent, can push messages. */
class FakeSocket extends EventTarget {
  readyState = 1;
  sent: string[] = [];
  send(raw: string) {
    this.sent.push(raw);
  }
  push(msg: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) }));
  }
}

function connectSocket(): FakeSocket {
  const socket = new FakeSocket();
  useWsStore.setState({ client: { getRawSocket: () => socket } as never, connected: true });
  return socket;
}

/** What the peek asked of the server for terminal term-1, in order. */
const peekRequests = (socket: FakeSocket) =>
  socket.sent.map((raw) => JSON.parse(raw) as { type: string; terminalId?: string }).filter((m) => m.terminalId === 'term-1').map((m) => m.type);

let n = 0;
const entry = (d: Record<string, unknown>): ChatEntry => ({ key: `${(n += 1) * 10}:0`, timestamp: 1_000_000 + n * 1000, ...d }) as ChatEntry;

function claudePage(): ApiResult<ChatPage> {
  return {
    ok: true,
    data: {
      entries: [
        entry({ kind: 'user', text: 'Centre the minimize bar', images: 1 }),
        entry({ kind: 'assistant', text: 'Checking the **SVG** first.' }),
        entry({ kind: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/p/icons.tsx' } }),
        entry({ kind: 'tool_result', toolUseId: 'a', isError: false, output: 'svg', truncated: false }),
        entry({ kind: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'Minimize' } }),
        entry({ kind: 'tool_result', toolUseId: 'b', isError: false, output: 'Found 2 files', truncated: false }),
        entry({ kind: 'tool_use', id: 'c', name: 'Bash', input: { command: 'npm run lint' } }),
        entry({ kind: 'tool_result', toolUseId: 'c', isError: true, output: '1 error in icons.tsx', truncated: false }),
        entry({ kind: 'assistant', text: 'Fixed; npm test passes.' }),
      ],
      before: 'b0',
      after: 'a9',
      cli: 'claude',
      hasMore: false,
    },
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    status: 'waiting',
    terminalId: 'term-1',
    promptHistory: [{ text: 'Centre the minimize bar', timestamp: Date.now() - 5000 }],
    toolLog: [],
    responseLog: [],
    lastActivityAt: 1,
    totalToolCalls: 3,
    subagentCount: 0,
    ...over,
  } as unknown as Session;
}

beforeEach(() => {
  fetchChatPage.mockReset();
  writeTerminal.mockClear();
  baton.mode = 'solo';
  baton.holder = undefined;
  useChatStore.getState().clearAll();
  useQueueStore.setState({ queues: new Map() });
  useComposerDraftStore.setState({ drafts: {} });
  useWsStore.setState({ client: null, connected: false });
});

describe('ChatView', () => {
  it('opens on the newest page: prompts, replies, folded calls, a visible failure', async () => {
    fetchChatPage.mockResolvedValue(claudePage());
    render(<ChatView session={session()} onTerminal={() => {}} />);
    expect(await screen.findByText('Centre the minimize bar')).toBeInTheDocument();
    expect(fetchChatPage).toHaveBeenCalledWith('s1', undefined);
    expect(screen.getByText('1 image')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Read 1 file, searched once/ })).toHaveAttribute('aria-expanded', 'false');
    const failed = screen.getByRole('button', { name: /Ran npm run lint.*Failed/ });
    await userEvent.click(failed);
    expect(failed).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Error')).toHaveTextContent('1 error in icons.tsx');
  });

  it('gives the answer Copy and Read aloud, and only the answer', async () => {
    fetchChatPage.mockResolvedValue(claudePage());
    render(<ChatView session={session()} onTerminal={() => {}} />);
    await screen.findByText('Centre the minimize bar');
    expect(screen.getAllByRole('button', { name: 'Copy this answer' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Read aloud/ })).toHaveLength(1);
  });

  it('pulls a queued prompt back into the composer draft', async () => {
    fetchChatPage.mockResolvedValue(claudePage());
    useQueueStore.setState({ queues: new Map([['s1', [{ id: 7, sessionId: 's1', text: 'then commit', position: 0, createdAt: 1 }]]]) });
    render(<ChatView session={session()} onTerminal={() => {}} />);
    expect(await screen.findByText('then commit')).toBeInTheDocument();
    expect(screen.getByText(/Queued · 1st/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Pull back the 1st queued prompt/ }));
    expect(useQueueStore.getState().queues.get('s1')).toEqual([]);
    expect(useComposerDraftStore.getState().drafts.s1).toBe('then commit');
  });

  it('says a session with no transcript has none and offers the Terminal', async () => {
    fetchChatPage.mockResolvedValue({ ok: true, data: { entries: [], before: null, after: null, cli: null, hasMore: false } });
    const onTerminal = vi.fn();
    render(<ChatView session={session()} onTerminal={onTerminal} />);
    expect(await screen.findByText('This session has no transcript')).toBeInTheDocument();
    expect(screen.getByText('It’s a shell or another tool. Use Terminal.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));
    expect(onTerminal).toHaveBeenCalled();
  });

  it('searches with a count and previous / next', async () => {
    fetchChatPage.mockResolvedValue(claudePage());
    render(<ChatView session={session()} onTerminal={() => {}} />);
    await screen.findByText('Centre the minimize bar');
    await userEvent.click(screen.getByRole('button', { name: 'Search this chat' }));
    const search = screen.getByRole('search');
    await userEvent.type(within(search).getByRole('searchbox'), 'npm');
    expect(within(search).getByText('0/2')).toHaveAttribute('aria-label', '0 of 2');
    await userEvent.keyboard('{Enter}');
    expect(within(search).getByText('1/2')).toHaveAttribute('aria-label', '1 of 2');
    const current = document.querySelector('[data-current]');
    expect(current).toHaveTextContent('npm run lint');
    await userEvent.click(within(search).getByRole('button', { name: 'Next match' }));
    expect(within(search).getByText('2/2')).toHaveAttribute('aria-label', '2 of 2');
    expect(document.querySelector('[data-current]')).toHaveTextContent('npm test passes');
  });

  it('opens a folded group, and the call in it, that a search step lands on', async () => {
    fetchChatPage.mockResolvedValue(claudePage());
    render(<ChatView session={session()} onTerminal={() => {}} />);
    await screen.findByText('Centre the minimize bar');
    await userEvent.click(screen.getByRole('button', { name: 'Search this chat' }));
    const search = screen.getByRole('search');
    await userEvent.type(within(search).getByRole('searchbox'), 'found 2');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: /Read 1 file, searched once/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /Searched “Minimize”/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByLabelText('Output').map((o) => o.textContent)).toContain('Found 2 files');
    expect(screen.getByRole('button', { name: /Read icons\.tsx/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('says an open call waits for you while the session waits for an approval', async () => {
    fetchChatPage.mockResolvedValue({ ok: true, data: { entries: [entry({ kind: 'user', text: 'clean up' }), entry({ kind: 'tool_use', id: 'z', name: 'Bash', input: { command: 'rm -rf dist' } })], before: 'b', after: 'a', cli: 'claude', hasMore: false } });
    render(<ChatView session={session({ status: 'approval' })} onTerminal={() => {}} />);
    expect(await screen.findByText('Waiting for you')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-status-strip')).toBeNull();
  });

  it('draws a command that only names a secret file by its note, with a lock and no input', async () => {
    fetchChatPage.mockResolvedValue({ ok: true, data: { entries: [
      entry({ kind: 'assistant', text: 'Checking.' }),
      entry({ kind: 'tool_use', id: 'h', name: 'Bash', input: { redacted: true, note: 'Ran a command that touches a secret file' }, secret: true }),
      entry({ kind: 'tool_result', toolUseId: 'h', isError: false, output: '[Hidden on phones: this touched a secret file]', truncated: false, secret: true }),
    ], before: 'b', after: 'a', cli: 'claude', hasMore: false } });
    render(<ChatView session={session()} onTerminal={() => {}} />);
    const row = await screen.findByRole('button', { name: /Ran a command that touches a secret file.*a secret file/ });
    await userEvent.click(row);
    expect(screen.getByText('Hidden on phones: this touched a secret file.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Input')).toBeNull();
    expect(screen.queryByText(/"note"/)).toBeNull();
  });

  it('reads what was written since when the session moves', async () => {
    fetchChatPage.mockResolvedValue(claudePage());
    const { rerender } = render(<ChatView session={session()} onTerminal={() => {}} />);
    await screen.findByText('Centre the minimize bar');
    fetchChatPage.mockResolvedValue({ ok: true, data: { entries: [entry({ kind: 'assistant', text: 'One more thing.' })], before: 'b0', after: 'a10', cli: 'claude', hasMore: false } });
    rerender(<ChatView session={session({ lastActivityAt: 2 })} onTerminal={() => {}} />);
    expect(await screen.findByText('One more thing.')).toBeInTheDocument();
    expect(fetchChatPage).toHaveBeenLastCalledWith('s1', { after: 'a9' });
  });

  it('while working: the strip, and Stop writes Esc to the terminal', async () => {
    fetchChatPage.mockResolvedValue(claudePage());
    render(<ChatView session={session({ status: 'working', toolLog: [{ tool: 'Bash', input: 'npm test', timestamp: Date.now() }] })} onTerminal={() => {}} />);
    const strip = await screen.findByTestId('chat-status-strip');
    expect(strip).toHaveTextContent('Working · Bash');
    await userEvent.click(within(strip).getByRole('button', { name: 'Stop the agent (Esc)' }));
    expect(writeTerminal).toHaveBeenCalledWith('term-1', '\x1b');
  });

  it('while compacting, even idle: the strip says so, with its trigger and time, and Stop still sends Esc', async () => {
    fetchChatPage.mockResolvedValue(claudePage());
    render(<ChatView session={session({ status: 'idle', compacting: { since: Date.now() - 23_000, trigger: 'auto' } })} onTerminal={() => {}} />);
    const strip = await screen.findByTestId('chat-status-strip');
    expect(strip).toHaveTextContent(/^Compacting context · auto · 0:2\d/);
    expect(strip).not.toHaveTextContent('Working');
    await userEvent.click(within(strip).getByRole('button', { name: 'Stop the agent (Esc)' }));
    expect(writeTerminal).toHaveBeenCalledWith('term-1', '\x1b');
  });

  it('shows no strip for a compaction whose end hook never came (stale)', async () => {
    fetchChatPage.mockResolvedValue(claudePage());
    render(<ChatView session={session({ status: 'idle', compacting: { since: Date.now() - 60 * 60_000, trigger: null } })} onTerminal={() => {}} />);
    await waitFor(() => expect(fetchChatPage).toHaveBeenCalled());
    expect(screen.queryByTestId('chat-status-strip')).toBeNull();
  });

  it('opens the terminal from the live preview’s "Open terminal" (AASC-56)', async () => {
    fetchChatPage.mockResolvedValue(claudePage());
    const onTerminal = vi.fn();
    render(<ChatView session={session({ status: 'working' })} onTerminal={onTerminal} />);
    await userEvent.click(await screen.findByTestId('chat-terminal-peek'));
    await userEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it('stays subscribed to the terminal across turns: a status flip never re-downloads the scrollback', async () => {
    const socket = connectSocket();
    fetchChatPage.mockResolvedValue(claudePage());
    const view = (status: Session['status']) => <ChatView session={session({ status })} onTerminal={() => {}} />;
    const { rerender } = render(view('working'));
    await screen.findByTestId('chat-status-strip');
    rerender(view('waiting'));
    expect(screen.queryByTestId('chat-status-strip')).toBeNull();
    // Output while the strip is down still reaches the peek.
    act(() => socket.push({ type: 'terminal_output', terminalId: 'term-1', data: btoa('npm test: 3 passed\r\n') }));
    rerender(view('approval'));
    rerender(view('working'));
    expect(await screen.findByText('npm test: 3 passed')).toBeInTheDocument();
    rerender(view('waiting'));
    rerender(view('prompting'));
    expect(peekRequests(socket)).toEqual(['terminal_subscribe']);
  });

  it('lets go of the terminal when the chat leaves the top, and when it unmounts', async () => {
    const socket = connectSocket();
    fetchChatPage.mockResolvedValue(claudePage());
    const view = (isTop: boolean) => (
      <ScreenSlotContext.Provider value={{ isTop, registerScroller: () => {} }}>
        <ChatView session={session({ status: 'working' })} onTerminal={() => {}} />
      </ScreenSlotContext.Provider>
    );
    const { rerender, unmount } = render(view(true));
    await screen.findByTestId('chat-status-strip');
    rerender(view(false));
    expect(peekRequests(socket)).toEqual(['terminal_subscribe', 'terminal_disconnect']);
    rerender(view(true));
    unmount();
    expect(peekRequests(socket)).toEqual(['terminal_subscribe', 'terminal_disconnect', 'terminal_subscribe', 'terminal_disconnect']);
  });

  it('keeps Stop off, saying who drives, while another device has control', async () => {
    baton.mode = 'spectator';
    baton.holder = { label: 'MacBook' };
    fetchChatPage.mockResolvedValue(claudePage());
    render(<ChatView session={session({ status: 'working' })} onTerminal={() => {}} />);
    const strip = await screen.findByTestId('chat-status-strip');
    const stop = within(strip).getByRole('button', { name: 'Stop the agent (Esc)' });
    expect(stop).toHaveAttribute('aria-disabled', 'true');
    expect(strip).toHaveTextContent('MacBook is driving');
    await userEvent.click(stop);
    expect(writeTerminal).not.toHaveBeenCalled();
  });

  it('says so when the first read fails, and tries again', async () => {
    fetchChatPage.mockResolvedValueOnce({ ok: false, status: 0, message: 'Couldn’t reach your Mac.' });
    render(<ChatView session={session()} onTerminal={() => {}} />);
    expect(await screen.findByText('Couldn’t reach your Mac.')).toBeInTheDocument();
    fetchChatPage.mockResolvedValueOnce(claudePage());
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Centre the minimize bar')).toBeInTheDocument();
  });
});

// SessionScreen.recentPrompts.test.tsx — a hold on a session's title (Oct 23 2026)
// opens its recent prompts: the last ones the user typed, newest first. A prompt
// opens in the Prompts tab; "All prompts" opens that tab; a tap on the title still
// opens Info. The Prompts tab itself is a stand-in that says what it was asked to open.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Session } from '@/types';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('../chat/ChatView', () => ({ default: () => <div data-testid="chat" /> }));
vi.mock('../chat/ChatFooter', () => ({ default: () => <div data-testid="chat-footer" /> }));
vi.mock('../chat/ChangesView', () => ({ default: () => <div />, ChangesBadge: () => null }));
vi.mock('./SessionTerminal', () => ({ default: () => <div data-testid="terminal" /> }));
vi.mock('../views/PhonePrompts', () => ({
  default: ({ openAt, onOpenAtDone }: { openAt?: { at: number; text?: string } | null; onOpenAtDone?: () => void }) => (
    <div data-testid="prompts">
      {openAt ? `open ${openAt.at}` : 'list'}
      <button type="button" onClick={onOpenAtDone}>close the prompt</button>
    </div>
  ),
}));
vi.mock('@/components/session/AgentsTab', () => ({ default: () => <div /> }));
vi.mock('../PhoneProjectBrowser', () => ({ default: () => <div /> }));

import SessionScreen from './SessionScreen';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { usePhoneNavStore, defaultStacks } from '@/stores/phoneNavStore';
import { LONG_PRESS_MS } from '../kit/menuPosition';

const T0 = Date.now();
const claude = {
  sessionId: 's1', cliSource: 'claude', title: 'AASC Phone APP', projectName: 'agent-manager', projectPath: '/w/am',
  status: 'working', source: 'ssh', terminalId: 'term-1', startedAt: 0, lastActivityAt: T0, events: [], toolLog: [], responseLog: [],
  remark: 'phone polish',
  promptHistory: [
    { text: 'fix the queue badge', timestamp: T0 - 9 * 60_000 },
    { text: '<task-notification>done</task-notification>', timestamp: T0 - 5 * 60_000 },
    { text: '/update-feature-docs', timestamp: T0 - 2 * 60_000 },
  ],
} as unknown as Session;

const stack = () => usePhoneNavStore.getState().stacks.sessions;

function show() {
  usePhoneNavStore.setState({ tab: 'sessions', stacks: { ...defaultStacks(), sessions: ['/sessions', '/sessions/s1/chat'] } });
  return render(<SessionScreen sessionId="s1" segment="chat" />);
}
const title = () => screen.getByRole('button', { name: /AASC Phone APP/ });
async function hold() {
  vi.useFakeTimers();
  fireEvent.pointerDown(title(), { pointerType: 'touch', clientX: 100, clientY: 20 });
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_MS);
  });
  fireEvent.pointerUp(title(), { pointerType: 'touch', clientX: 100, clientY: 20 });
  fireEvent.click(title());
  vi.useRealTimers();
  return screen.findByTestId('recent-prompts-sheet');
}

beforeEach(() => {
  useWsStore.setState({ snapshotReceived: true, connected: true });
  useSessionStore.setState({ sessions: new Map([['s1', claude]]), selectedSessionId: null });
});

describe('a hold on the session title', () => {
  it('opens the recent prompts, typed ones only, newest first, and does not also open Info', async () => {
    show();
    const sheet = await hold();
    expect(within(sheet).getByText(/agent-manager · Working/)).toBeInTheDocument();
    expect(within(sheet).getByText('phone polish')).toBeInTheDocument();
    const rows = within(sheet).getAllByRole('button').map((b) => b.textContent ?? '');
    const prompts = rows.filter((t) => t.includes('/update-feature-docs') || t.includes('fix the queue badge') || t.includes('task-notification'));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('/update-feature-docs');
    expect(prompts[1]).toContain('fix the queue badge');
    expect(stack().at(-1)).toBe('/sessions/s1/chat');
  });

  // The stack keys a session's slot by the session, not its tab (PhoneStack's slotKey), so the
  // screen is the same one re-rendered with the new segment: as here.
  it('a prompt opens in the Prompts tab', async () => {
    const { rerender } = show();
    const sheet = await hold();
    fireEvent.click(within(sheet).getByText('/update-feature-docs'));
    expect(stack().at(-1)).toBe('/sessions/s1/prompts');
    rerender(<SessionScreen sessionId="s1" segment="prompts" />);
    expect(await screen.findByTestId('prompts')).toHaveTextContent(`open ${T0 - 2 * 60_000}`);
    expect(screen.queryByTestId('recent-prompts-sheet')).toBeNull();
  });

  it('"All prompts" opens the tab without picking one', async () => {
    const { rerender } = show();
    const sheet = await hold();
    fireEvent.click(within(sheet).getByText('All prompts'));
    expect(stack().at(-1)).toBe('/sessions/s1/prompts');
    rerender(<SessionScreen sessionId="s1" segment="prompts" />);
    expect(await screen.findByTestId('prompts')).toHaveTextContent('list');
  });

  it('a tap on the title still opens Info, and says the hold is there', () => {
    show();
    expect(title()).toHaveAccessibleDescription('Hold for recent prompts');
    fireEvent.click(title());
    expect(stack().at(-1)).toBe('/sessions/s1/info');
  });
});

describe('the asked-for prompt is asked for once', () => {
  it('closing it ends the request, so the tab does not open it again next time', async () => {
    const { rerender } = show();
    fireEvent.click(within(await hold()).getByText('/update-feature-docs'));
    rerender(<SessionScreen sessionId="s1" segment="prompts" />);
    fireEvent.click(await screen.findByText('close the prompt'));
    rerender(<SessionScreen sessionId="s1" segment="chat" />);
    rerender(<SessionScreen sessionId="s1" segment="prompts" />);
    expect(await screen.findByTestId('prompts')).toHaveTextContent('list');
  });

  it('leaving the tab ends it too', async () => {
    const { rerender } = show();
    fireEvent.click(within(await hold()).getByText('/update-feature-docs'));
    rerender(<SessionScreen sessionId="s1" segment="prompts" />);
    await screen.findByTestId('prompts');
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    rerender(<SessionScreen sessionId="s1" segment="chat" />);
    rerender(<SessionScreen sessionId="s1" segment="prompts" />);
    expect(await screen.findByTestId('prompts')).toHaveTextContent('list');
  });
});

describe('a plain shell', () => {
  it('has no Prompts tab, so its title has no hold either', () => {
    const shell = { ...claude, sessionId: 'sh', cliSource: undefined, title: 'zsh', startupCommand: 'zsh', promptHistory: [] } as unknown as Session;
    useSessionStore.setState({ sessions: new Map([['sh', shell]]) });
    usePhoneNavStore.setState({ tab: 'sessions', stacks: { ...defaultStacks(), sessions: ['/sessions', '/sessions/sh/terminal'] } });
    render(<SessionScreen sessionId="sh" segment="terminal" />);
    const t = screen.getByRole('button', { name: /zsh/ });
    expect(t).not.toHaveAccessibleDescription(/hold/i);
  });
});

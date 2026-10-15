// SessionScreen.nav.test.tsx — the session screen's nav bar (AASC-46): the title
// opens Info, and ⋯ opens the four-action menu (not the old actions sheet).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/types';

vi.mock('@/components/terminal/TerminalContainer', () => ({ default: () => <div data-testid="terminal-container" /> }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import SessionScreen from './SessionScreen';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { usePhoneNavStore, defaultStacks } from '@/stores/phoneNavStore';

beforeEach(() => {
  useWsStore.setState({ snapshotReceived: true, connected: true });
  useSessionStore.setState({
    sessions: new Map([['s1', {
      sessionId: 's1', title: 'web', projectName: 'web', status: 'idle', source: 'ssh', terminalId: 'term-1', cliSource: 'claude',
      startedAt: 0, lastActivityAt: 0, events: [], promptHistory: [], toolLog: [], responseLog: [],
    } as unknown as Session]]),
    selectedSessionId: null,
  });
  usePhoneNavStore.setState({ tab: 'sessions', stacks: { ...defaultStacks(), sessions: ['/sessions', '/sessions/s1/terminal'] } });
});

describe('SessionScreen nav bar', () => {
  it('opens Info from the title', async () => {
    const user = userEvent.setup();
    render(<SessionScreen sessionId="s1" segment="terminal" />);
    await user.click(screen.getByRole('button', { name: /^web/ }));
    expect(usePhoneNavStore.getState().stacks.sessions.at(-1)).toBe('/sessions/s1/info');
  });

  it('opens the four-action menu from ⋯', async () => {
    const user = userEvent.setup();
    render(<SessionScreen sessionId="s1" segment="terminal" />);
    await user.click(screen.getByRole('button', { name: 'Session actions' }));
    expect(await screen.findByTestId('session-menu-sheet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Restart/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kill session' })).toBeTruthy();
  });
});

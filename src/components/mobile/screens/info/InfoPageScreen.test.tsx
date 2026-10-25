// InfoPageScreen.test.tsx — what a session's Info opens (AASC-46): each page
// mounts today's phone piece for that session, lazily. The pieces have their
// own tests; here they are stand-ins that show what they were given.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Session } from '@/types';

vi.mock('@/components/session/NotesTab', () => ({ default: ({ sessionId }: { sessionId: string }) => <div data-testid="notes">{sessionId}</div> }));
vi.mock('@/components/session/QueueTab', () => ({
  default: ({ sessionId, terminalId, fullHeight }: { sessionId: string; terminalId: string; fullHeight: boolean }) => (
    <div data-testid="queue">{sessionId}:{terminalId}:{String(fullHeight)}</div>
  ),
}));
vi.mock('@/components/session/AiPopupHistory', () => ({ default: ({ sessionId }: { sessionId: string }) => <div data-testid="popups">{sessionId}</div> }));

import InfoPageScreen from './InfoPageScreen';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';

beforeEach(() => {
  useWsStore.setState({ snapshotReceived: true });
  useSessionStore.setState({
    sessions: new Map([['s1', { sessionId: 's1', title: 'web', projectName: 'web', projectPath: '/w/web', status: 'idle', terminalId: 'term-1' } as unknown as Session]]),
  });
});

describe('InfoPageScreen', () => {
  it.each([
    ['notes', 'Notes', 's1'],
    ['queue', 'Queue', 's1:term-1:true'],
    ['popups', 'AI popups', 's1'],
  ] as const)('shows %s for the session', async (page, title, shows) => {
    render(<InfoPageScreen sessionId="s1" page={page} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(title);
    expect((await screen.findByTestId(page)).textContent).toBe(shows);
  });

  it('says the session is gone when it isn’t here', () => {
    render(<InfoPageScreen sessionId="nope" page="notes" />);
    expect(screen.getByText('This session isn’t here')).toBeTruthy();
  });
});

// DetailPanel.phone.test.tsx — a phone gets its own session header in place of
// the switcher's top row, and the phone app's COMMANDS tab explains why there is
// no shell (AASC-18). Desktop keeps the switcher's row.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Session } from '@/types';

const platform = vi.hoisted(() => ({ isMobile: true, nativeApp: false }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
  isNativeMobileApp: () => platform.nativeApp,
}));
vi.mock('@/components/ui/ResizablePanel', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./DetailTabs', () => ({
  default: ({ commandsContent }: Record<string, React.ReactNode>) => (
    <div data-testid="detail-tabs"><div data-testid="commands-tab">{commandsContent}</div></div>
  ),
}));
vi.mock('./ConversationView', () => ({ default: () => null }));
vi.mock('@/components/mobile/MobileSessionHeader', () => ({
  default: ({ session }: { session: Session }) => <div data-testid="mobile-header">{session.title}</div>,
}));

import DetailPanel from './DetailPanel';
import { useSessionStore } from '@/stores/sessionStore';

function select(over: Partial<Session> = {}) {
  const session = {
    sessionId: 'sess-1', status: 'working', projectName: 'p', projectPath: '/tmp/p', title: 'Phone Task',
    source: 'ssh', model: 'claude', startedAt: Date.now() - 1000, lastActivityAt: Date.now(),
    promptHistory: [], toolLog: [], responseLog: [], events: [], terminalId: null,
    ...over,
  } as unknown as Session;
  useSessionStore.setState({ sessions: new Map([[session.sessionId, session]]), selectedSessionId: session.sessionId });
}

beforeEach(() => {
  platform.isMobile = true;
  platform.nativeApp = false;
});

describe('DetailPanel header', () => {
  it('a phone shows its own header instead of the switcher row', () => {
    select();
    render(<DetailPanel />);
    expect(screen.getByTestId('mobile-header')).toHaveTextContent('Phone Task');
    expect(screen.queryByRole('button', { name: 'Minimize session panel' })).toBeNull();
  });

  it('a desktop keeps the switcher row and no phone header', () => {
    platform.isMobile = false;
    select();
    render(<DetailPanel />);
    expect(screen.queryByTestId('mobile-header')).toBeNull();
    expect(screen.getByRole('button', { name: 'Minimize session panel' })).toBeInTheDocument();
  });
});

describe('DetailPanel COMMANDS in the phone app', () => {
  it('says a paired phone has no shell instead of mounting one', () => {
    platform.nativeApp = true;
    select({ opsTerminalId: 'ops-1' } as Partial<Session>);
    render(<DetailPanel />);
    expect(screen.getByTestId('commands-tab')).toHaveTextContent('Commands stay on the Mac');
  });
});

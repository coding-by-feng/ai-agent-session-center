// DetailPanel.phoneProject.test.tsx — on a phone the PROJECT tab is the read-only
// drill-down (AASC-20), never the desktop's split tree and editor; the desktop
// keeps ProjectTabContainer. Both stay lazy (their own chunks).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Session } from '@/types';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
  isNativeMobileApp: () => false,
}));
vi.mock('@/components/ui/ResizablePanel', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./DetailTabs', () => ({
  default: ({ projectContent }: Record<string, React.ReactNode>) => <div data-testid="project-tab">{projectContent}</div>,
}));
vi.mock('./ConversationView', () => ({ default: () => null }));
vi.mock('@/components/mobile/MobileSessionHeader', () => ({ default: () => null }));
vi.mock('@/components/mobile/PhoneProjectBrowser', () => ({
  default: ({ projectPath, sessionId }: { projectPath: string; sessionId: string }) => (
    <div data-testid="phone-project">{`${sessionId}:${projectPath}`}</div>
  ),
}));
vi.mock('./ProjectTabContainer', () => ({ default: () => <div data-testid="desktop-project" /> }));

import DetailPanel from './DetailPanel';
import { useSessionStore } from '@/stores/sessionStore';

function select() {
  const session = {
    sessionId: 'sess-1', status: 'idle', projectName: 'p', projectPath: '/Users/me/p', title: 'Task',
    source: 'ssh', model: 'claude', startedAt: Date.now() - 1000, lastActivityAt: Date.now(),
    promptHistory: [], toolLog: [], responseLog: [], events: [], terminalId: null,
  } as unknown as Session;
  useSessionStore.setState({ sessions: new Map([[session.sessionId, session]]), selectedSessionId: session.sessionId });
}

beforeEach(() => {
  platform.isMobile = true;
  localStorage.setItem('active-tab', 'project');
});

describe('DetailPanel PROJECT tab', () => {
  it('is the phone drill-down on a phone, for the shown session', async () => {
    select();
    render(<DetailPanel />);
    expect(await screen.findByTestId('phone-project')).toHaveTextContent('sess-1:/Users/me/p');
    expect(screen.queryByTestId('desktop-project')).toBeNull();
  });

  it('is not mounted on a phone until the PROJECT tab is opened (no listing on every switch)', () => {
    localStorage.setItem('active-tab', 'terminal');
    select();
    render(<DetailPanel />);
    expect(screen.queryByTestId('phone-project')).toBeNull();
    expect(screen.queryByTestId('desktop-project')).toBeNull();
  });

  it('is the desktop project browser on the desktop', async () => {
    platform.isMobile = false;
    select();
    render(<DetailPanel />);
    expect(await screen.findByTestId('desktop-project')).toBeInTheDocument();
    expect(screen.queryByTestId('phone-project')).toBeNull();
  });
});

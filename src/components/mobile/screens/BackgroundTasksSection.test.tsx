// BackgroundTasksSection.test.tsx — the phone Agents tab's Background list (Oct 25 2026).
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useSessionStore } from '@/stores/sessionStore';
import type { BackgroundTasks, Session } from '@/types/session';
import BackgroundTasksSection from './BackgroundTasksSection';

const background: BackgroundTasks = {
  items: [
    { id: 'b1', type: 'shell', status: 'running', description: 'Wait for harness report', command: 'cd /x && until [ -f done ]; do sleep 5; done', firstSeenAt: Date.UTC(2026, 9, 25, 8, 18) },
    { id: 't1', type: 'teammate', status: 'running', description: 'FW-A: ledger and delivery fixes', command: null, firstSeenAt: 1 },
    { id: 't2', type: 'teammate', status: 'completed', description: 'FW-B: docs', command: null, firstSeenAt: 1 },
  ],
  agents: 82,
  shells: 1,
  activeShells: 1,
  at: Date.UTC(2026, 9, 25, 8, 19),
};

function withSession(bg: BackgroundTasks | null) {
  const session = { sessionId: 's1', backgroundTasks: bg } as unknown as Session;
  useSessionStore.setState({ sessions: new Map([['s1', session]]) });
}

describe('BackgroundTasksSection', () => {
  beforeEach(() => withSession(background));

  it('shows nothing until a Stop has listed the session’s background work', () => {
    withSession(null);
    const { container } = render(<BackgroundTasksSection sessionId="s1" />);
    expect(container.textContent).toBe('');
  });

  it('shows the summary, every kept item with its status, and how many the cap left out', () => {
    render(<BackgroundTasksSection sessionId="s1" />);
    expect(screen.getByText('82 agents · 1 active shell')).toBeTruthy();
    expect(screen.getByText(/^Background · as of /)).toBeTruthy();
    expect(screen.getByText('FW-A: ledger and delivery fixes')).toBeTruthy();
    expect(screen.getByText('Teammate · completed')).toBeTruthy();
    expect(screen.getByText('80 more not shown')).toBeTruthy();
    // Agents are not tappable; a shell is.
    expect(screen.queryByRole('button', { name: /FW-A/ })).toBeNull();
  });

  it('opens a shell’s details: status, command, description and the missing-output note', () => {
    render(<BackgroundTasksSection sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Shell details: Wait for harness report' }));
    expect(screen.getByText('cd /x && until [ -f done ]; do sleep 5; done')).toBeTruthy();
    expect(screen.getByText('Seen since')).toBeTruthy();
    expect(screen.getByText(/doesn’t send a shell’s output/)).toBeTruthy();
  });
});

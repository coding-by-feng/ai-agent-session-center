// DetailTabs.lite.test.tsx — the session tabs in the Lite build (lib/edition.ts): TERMINAL first, then
// PROJECT, and QUEUE only while the session has queued prompts, because the scheduler keeps sending.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));

import DetailTabs from './DetailTabs';
import { useQueueStore } from '@/stores/queueStore';
import type { QueueItem } from '@/stores/queueStore';

const props = {
  sessionId: 's1',
  terminalContent: <div>Terminal Content</div>,
  promptsContent: <div>Prompts Content</div>,
  aiPopupsContent: <div>AI Popups Content</div>,
  projectContent: <div>Project Content</div>,
  notesContent: <div>Notes Content</div>,
  queueContent: <div>Queue Content</div>,
  agentsContent: <div>Agents Content</div>,
  commandsContent: <div>Commands Content</div>,
  activityContent: <div>Activity Content</div>,
};

const tabButton = (id: string) => document.querySelector<HTMLElement>(`[data-tab="${id}"]`);
const tabLabels = () => [...document.querySelectorAll('[data-tab]')].map((tab) => tab.textContent?.replace(/\d+$/, ''));

function setQueue(items: number): void {
  const queued = Array.from({ length: items }, (_, id) => ({ id }) as unknown as QueueItem);
  useQueueStore.setState({ queues: new Map(items ? [['s1', queued]] : []) });
}

describe('DetailTabs in the Lite build', () => {
  beforeEach(() => {
    localStorage.removeItem('active-tab');
    setQueue(0);
  });

  it('keeps the PROJECT layout toggles without the detach button', () => {
    render(<DetailTabs {...props} />);
    expect(screen.queryByRole('button', { name: /Detach Project/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Merge with Terminal|Split/ })).toBeInTheDocument();
  });

  it('opens with TERMINAL, then PROJECT, and nothing else', () => {
    render(<DetailTabs {...props} />);
    expect(tabLabels()).toEqual(['TERMINAL', 'PROJECT']);
  });

  it('adds CONVERSATION for a session with no terminal, such as a claude started in iTerm', () => {
    render(<DetailTabs {...props} hasTerminal={false} />);
    expect(tabLabels()).toEqual(['TERMINAL', 'CONVERSATION', 'PROJECT']);
  });

  it('adds QUEUE while the session has queued prompts', () => {
    setQueue(2);
    render(<DetailTabs {...props} />);
    expect(tabLabels()).toEqual(['TERMINAL', 'PROJECT', 'QUEUE']);
  });

  it.each(['notes', 'conversation', 'agents', 'aiPopups', 'activity'])(
    'shows the terminal when the saved tab is %s, one Lite leaves out (Full wrote it)',
    (saved) => {
      localStorage.setItem('active-tab', saved);
      render(<DetailTabs {...props} />);
      expect(tabButton('terminal')?.className).toMatch(/active/);
      expect(screen.queryByText('Notes Content')).not.toBeInTheDocument();
    },
  );

  it('leaves the choice saved for Full, which reads the same key', () => {
    localStorage.setItem('active-tab', 'notes');
    render(<DetailTabs {...props} />);
    expect(localStorage.getItem('active-tab')).toBe('notes');
  });

  it('goes back to the terminal when the last queued prompt leaves the open QUEUE tab', () => {
    setQueue(1);
    localStorage.setItem('active-tab', 'queue');
    render(<DetailTabs {...props} />);
    expect(tabButton('queue')?.className).toMatch(/active/);

    act(() => setQueue(0));

    expect(tabButton('queue')).toBeNull();
    expect(tabButton('terminal')?.className).toMatch(/active/);
  });
});

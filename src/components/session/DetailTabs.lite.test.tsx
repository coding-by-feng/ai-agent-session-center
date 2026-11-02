// DetailTabs.lite.test.tsx — the session tabs in the Lite build (lib/edition.ts): TERMINAL first, then
// PROJECT, AI POPUPS and QUEUE.
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

  it('opens with TERMINAL, then PROJECT, AI POPUPS and QUEUE, and nothing else', () => {
    render(<DetailTabs {...props} />);
    expect(tabLabels()).toEqual(['TERMINAL', 'PROJECT', 'AI POPUPS', 'QUEUE']);
  });

  it('adds CONVERSATION for a session with no terminal, such as a claude started in iTerm', () => {
    render(<DetailTabs {...props} hasTerminal={false} />);
    expect(tabLabels()).toEqual(['TERMINAL', 'CONVERSATION', 'PROJECT', 'AI POPUPS', 'QUEUE']);
  });

  it('counts the queued prompts on the QUEUE tab', () => {
    setQueue(2);
    render(<DetailTabs {...props} />);
    expect(tabButton('queue')?.textContent).toBe('QUEUE2');
  });

  it.each([['aiPopups', 'AI Popups Content'], ['queue', 'Queue Content']])('reopens on a saved %s tab', (saved, content) => {
    localStorage.setItem('active-tab', saved);
    render(<DetailTabs {...props} />);
    expect(tabButton(saved)?.className).toMatch(/active/);
    expect(screen.getByText(content)).toBeInTheDocument();
  });

  it.each(['notes', 'conversation', 'agents', 'activity'])(
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

  it('stays on the QUEUE tab when the last queued prompt leaves it', () => {
    setQueue(1);
    localStorage.setItem('active-tab', 'queue');
    render(<DetailTabs {...props} />);
    expect(tabButton('queue')?.className).toMatch(/active/);

    act(() => setQueue(0));

    expect(tabButton('queue')?.className).toMatch(/active/);
  });
});

/**
 * The tab bar on a phone (AASC-18): one tab at a time, so no split / stacked /
 * project-window controls even on a phone held sideways (wider than the split
 * threshold), and the tabs in a phone's order — what you watch and drive a
 * session with first. A desktop keeps its order and its split controls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import DetailTabs from './DetailTabs';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));

const props = {
  terminalContent: <div>Terminal Content</div>,
  promptsContent: <div>Prompts Content</div>,
  aiPopupsContent: <div>AI Popups Content</div>,
  projectContent: <div>Project Content</div>,
  notesContent: <div>Notes Content</div>,
  queueContent: <div>Queue Content</div>,
  agentsContent: <div>Agents Content</div>,
};

const tabOrder = () =>
  within(document.querySelector('[data-tab-strip]') as HTMLElement)
    .getAllByRole('button')
    .map((b) => b.getAttribute('data-tab'))
    .filter(Boolean);

let width: number;
beforeEach(() => {
  platform.isMobile = true;
  width = window.innerWidth;
  // A phone held sideways: wider than the 700px split threshold.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 844 });
  try { localStorage.removeItem('active-tab'); } catch { /* ignore */ }
});
afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
});

describe('DetailTabs on a phone', () => {
  it('puts TERMINAL, CONVERSATION, QUEUE, AGENTS first', () => {
    render(<DetailTabs {...props} />);
    expect(tabOrder()).toEqual(['terminal', 'conversation', 'queue', 'agents', 'project', 'notes', 'aiPopups', 'commands']);
  });

  it('offers no split, stacked or project-window control, even when wide', () => {
    render(<DetailTabs {...props} />);
    for (const name of [/merge/i, /stack/i, /separate/i, /window/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    const project = document.querySelector('[data-tab="project"]') as HTMLElement;
    expect(within(project).queryAllByRole('button')).toHaveLength(0);
  });

  it('shows one tab at a time', () => {
    render(<DetailTabs {...props} />);
    fireEvent.click(screen.getByText('QUEUE'));
    expect(screen.getByText('Queue Content')).toBeInTheDocument();
    expect(screen.queryByText('Prompts Content')).toBeNull();
    fireEvent.click(screen.getByText('CONVERSATION'));
    expect(screen.getByText('Prompts Content')).toBeInTheDocument();
    expect(screen.queryByText('Queue Content')).toBeNull();
  });
});

describe('DetailTabs on a desktop is unchanged', () => {
  it('keeps the desktop order and the split controls on a wide panel', () => {
    platform.isMobile = false;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
    render(<DetailTabs {...props} />);
    expect(tabOrder()[0]).toBe('project');
    expect(tabOrder()[1]).toBe('terminal');
    const project = document.querySelector('[data-tab="project"]') as HTMLElement;
    expect(within(project).getAllByRole('button').length).toBeGreaterThanOrEqual(3);
  });
});

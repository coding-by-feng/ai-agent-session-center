import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import DetailTabs from './DetailTabs';
import { useSessionStore } from '@/stores/sessionStore';
import { useNotesStore } from '@/stores/notesStore';
import { useQueueStore } from '@/stores/queueStore';

describe('DetailTabs', () => {
  const defaultProps = {
    terminalContent: <div>Terminal Content</div>,
    promptsContent: <div>Prompts Content</div>,
    aiPopupsContent: <div>AI Popups Content</div>,
    projectContent: <div>Project Content</div>,
    notesContent: <div>Notes Content</div>,
    queueContent: <div>Queue Content</div>,
  };

  beforeEach(() => {
    // Clear localStorage before each test so default tab is 'terminal'
    try { localStorage.removeItem('active-tab'); } catch { /* ignore */ }
  });

  it('renders all 7 tab buttons', () => {
    render(<DetailTabs {...defaultProps} />);
    expect(screen.getByText('PROJECT')).toBeInTheDocument();
    expect(screen.getByText('TERMINAL')).toBeInTheDocument();
    expect(screen.getByText('COMMANDS')).toBeInTheDocument();
    expect(screen.getByText('CONVERSATION')).toBeInTheDocument();
    expect(screen.getByText('AI POPUPS')).toBeInTheDocument();
    expect(screen.getByText('NOTES')).toBeInTheDocument();
    expect(screen.getByText('QUEUE')).toBeInTheDocument();
  });

  it('shows terminal content by default', () => {
    render(<DetailTabs {...defaultProps} />);
    expect(screen.getByText('Terminal Content')).toBeInTheDocument();
  });

  it('switches to conversation tab on click', () => {
    render(<DetailTabs {...defaultProps} />);
    fireEvent.click(screen.getByText('CONVERSATION'));
    expect(screen.getByText('Prompts Content')).toBeInTheDocument();
  });

  it('switches to AI popups tab on click', () => {
    render(<DetailTabs {...defaultProps} />);
    fireEvent.click(screen.getByText('AI POPUPS'));
    expect(screen.getByText('AI Popups Content')).toBeInTheDocument();
  });

  it('switches to notes tab on click', () => {
    render(<DetailTabs {...defaultProps} />);
    fireEvent.click(screen.getByText('NOTES'));
    expect(screen.getByText('Notes Content')).toBeInTheDocument();
  });

  it('calls onTabChange callback when tab changes', () => {
    const onTabChange = vi.fn();
    render(<DetailTabs {...defaultProps} onTabChange={onTabChange} />);
    fireEvent.click(screen.getByText('NOTES'));
    expect(onTabChange).toHaveBeenCalledWith('notes');
  });

  it('persists active tab to localStorage', () => {
    render(<DetailTabs {...defaultProps} />);
    fireEvent.click(screen.getByText('NOTES'));
    expect(localStorage.getItem('active-tab')).toBe('notes');
  });

  it('restores active tab from localStorage', () => {
    localStorage.setItem('active-tab', 'notes');
    render(<DetailTabs {...defaultProps} />);
    expect(screen.getByText('Notes Content')).toBeInTheDocument();
  });
});

describe('DetailTabs — open Project in a native window', () => {
  const defaultProps = {
    terminalContent: <div>Terminal Content</div>,
    promptsContent: <div>Prompts Content</div>,
    aiPopupsContent: <div>AI Popups Content</div>,
    projectContent: <div>Project Content</div>,
    notesContent: <div>Notes Content</div>,
    queueContent: <div>Queue Content</div>,
  };
  const seedSession = (projectPath?: string) => {
    useSessionStore.setState({
      sessions: new Map([['s1', { id: 's1', projectPath } as never]]),
    });
  };
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });
  afterEach(() => {
    useSessionStore.setState({ sessions: new Map() });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens the native project window (Electron) with the session path', () => {
    seedSession('/Users/me/proj');
    const openProjectWindow = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('electronAPI', { openProjectWindow });

    render(<DetailTabs {...defaultProps} sessionId="s1" />);
    fireEvent.click(screen.getByLabelText('Open Project in a window'));

    expect(openProjectWindow).toHaveBeenCalledWith({ path: '/Users/me/proj', label: 'Project' });
  });

  it('falls back to window.open on the /project-browser route in the browser', () => {
    seedSession('/Users/me/proj');
    vi.stubGlobal('electronAPI', undefined);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window);

    render(<DetailTabs {...defaultProps} sessionId="s1" />);
    fireEvent.click(screen.getByLabelText('Open Project in a window'));

    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining('/project-browser?path='),
      'aasc-project-_Users_me_proj',
      // The third argument is required: a features string is what forces the
      // browser to open a real separate WINDOW (draggable to another monitor)
      // rather than a new tab. Its width/height derive from
      // window.screen.avail*, which jsdom reports as 0, so assert on the shape
      // rather than the numbers.
      expect.stringContaining('popup'),
    );
  });

  it('is a no-op when the session has no project path', () => {
    seedSession(undefined);
    const openProjectWindow = vi.fn();
    vi.stubGlobal('electronAPI', { openProjectWindow });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window);

    render(<DetailTabs {...defaultProps} sessionId="s1" />);
    fireEvent.click(screen.getByLabelText('Open Project in a window'));

    expect(openProjectWindow).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('DetailTabs — NOTES / QUEUE count badges', () => {
  const defaultProps = {
    terminalContent: <div>Terminal Content</div>,
    promptsContent: <div>Prompts Content</div>,
    aiPopupsContent: <div>AI Popups Content</div>,
    projectContent: <div>Project Content</div>,
    notesContent: <div>Notes Content</div>,
    queueContent: <div>Queue Content</div>,
  };

  const tabText = (tabId: string) =>
    document.querySelector(`[data-tab="${tabId}"]`)?.textContent ?? '';

  const seedNotes = (sessionId: string, count: number) => {
    useNotesStore.setState({
      notes: new Map([[sessionId, Array.from({ length: count }, (_, i) => ({
        id: i + 1, sessionId, text: `n${i}`, createdAt: i, updatedAt: i,
      }))]]),
    });
  };

  const seedQueue = (sessionId: string, count: number) => {
    useQueueStore.setState({
      queues: new Map([[sessionId, Array.from({ length: count }, (_, i) => ({
        id: i + 1, sessionId, text: `p${i}`, position: i, createdAt: i,
      }))]]),
    });
  };

  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
    useNotesStore.setState({ notes: new Map() });
    useQueueStore.setState({ queues: new Map() });
    // The tab bar warms the notes cache on mount; keep it off the network and
    // make it a no-op so it can't clobber seeded state mid-assertion.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
  });

  afterEach(() => {
    useNotesStore.setState({ notes: new Map() });
    useQueueStore.setState({ queues: new Map() });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('badges the NOTES and QUEUE tabs with their counts', () => {
    seedNotes('s1', 3);
    seedQueue('s1', 2);

    render(<DetailTabs {...defaultProps} sessionId="s1" />);

    expect(tabText('notes')).toBe('NOTES3');
    expect(tabText('queue')).toBe('QUEUE2');
  });

  it('shows no chip when a tab is empty', () => {
    seedNotes('s1', 0);
    seedQueue('s1', 1);

    render(<DetailTabs {...defaultProps} sessionId="s1" />);

    expect(tabText('notes')).toBe('NOTES');
    expect(tabText('queue')).toBe('QUEUE1');
  });

  it('counts only the displayed session', () => {
    seedNotes('other', 5);
    seedQueue('other', 5);

    render(<DetailTabs {...defaultProps} sessionId="s1" />);

    expect(tabText('notes')).toBe('NOTES');
    expect(tabText('queue')).toBe('QUEUE');
  });

  it('caps the badge at 99+ so a long count cannot stretch the tab bar', () => {
    seedQueue('s1', 120);

    render(<DetailTabs {...defaultProps} sessionId="s1" />);

    expect(tabText('queue')).toBe('QUEUE99+');
  });

  it('labels the count for screen readers instead of a bare digit', () => {
    seedNotes('s1', 1);
    seedQueue('s1', 4);

    render(<DetailTabs {...defaultProps} sessionId="s1" />);

    expect(screen.getByLabelText('1 note')).toBeInTheDocument();
    expect(screen.getByLabelText('4 queued prompts')).toBeInTheDocument();
  });

  it('warms the notes cache on mount so the badge is right before NOTES is opened', () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => [] };
    }));

    render(<DetailTabs {...defaultProps} sessionId="s1" />);

    expect(urls).toContain('/api/db/sessions/s1/notes');
  });
});

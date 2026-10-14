import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, SubagentRun } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { showToast } from '@/components/ui/ToastContainer';
import AgentsTab from './AgentsTab';

// The toast is how a clipboard refusal is reported; the container itself is not what these tests are about.
vi.mock('@/components/ui/ToastContainer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/ToastContainer')>()),
  showToast: vi.fn(),
}));

const T0 = 1_791_000_000_000;

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    sessionId: id, status: 'idle', animationState: 'Idle', emote: null,
    projectName: 'agent-manager', projectPath: '/tmp/agent-manager', title: `Session ${id}`,
    source: 'terminal', model: 'claude-opus-5-5', startedAt: T0, lastActivityAt: T0, endedAt: null,
    currentPrompt: '', promptHistory: [], toolUsage: {}, totalToolCalls: 0, toolLog: [],
    responseLog: [], events: [], pendingTool: null, waitingDetail: null, subagentCount: 0,
    terminalId: null, cachedPid: null, archived: 0, queueCount: 0,
    ...overrides,
  };
}

function makeRun(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    agentId: 'a1', agentType: 'Explore', description: 'Find hook files', descriptionConfirmed: false, status: 'working',
    startedAt: T0 + 10, endedAt: null, lastActivityAt: T0 + 10, toolCount: 2,
    currentTool: 'Grep', currentTarget: 'agent_id', ...over,
  };
}

function seed(...sessions: Session[]) {
  useSessionStore.setState({ sessions: new Map(sessions.map((s) => [s.sessionId, s])), selectedSessionId: null });
}

describe('AgentsTab', () => {
  beforeEach(() => seed());
  afterEach(() => vi.unstubAllGlobals());

  it('draws the leader, one card per agent, and animates only the working connectors', () => {
    seed(makeSession('L', {
      title: 'fix the queue', status: 'working', cliSource: 'claude',
      subagents: [
        makeRun(),
        makeRun({ agentId: 'd', agentType: 'Plan', status: 'done', endedAt: T0 + 50, currentTool: null, currentTarget: null }),
      ],
    }));
    render(<AgentsTab sessionId="L" />);

    const diagram = screen.getByRole('region', { name: /agent diagram/i });
    expect(within(diagram).getByRole('article', { name: /fix the queue, leader, working/i })).toBeTruthy();
    const explore = within(diagram).getByRole('article', { name: /Explore, subagent, working/i });
    expect(within(explore).getByText('Grep')).toBeTruthy();
    expect(within(explore).getByText('Find hook files')).toBeTruthy();
    expect(within(diagram).getByRole('article', { name: /Plan, subagent, done/i })).toBeTruthy();

    const links = diagram.querySelectorAll('[data-link]');
    const active = [...links].filter((el) => el.getAttribute('data-active') === 'true').map((el) => el.getAttribute('data-link'));
    expect(active).toContain('a1');
    expect(active).not.toContain('d');
    expect(screen.getByText(/1 working · 1 finished/)).toBeTruthy();
  });

  it('lights the whole path to a working agent, through the finished cards before it', () => {
    // jsdom has no layout: report an 800px diagram so both cards share a row.
    class WideObserver {
      constructor(private cb: (entries: { contentRect: { width: number } }[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 800 } }]); }
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', WideObserver);
    seed(makeSession('L', {
      status: 'working',
      subagents: [
        makeRun({ agentId: 'first', status: 'done', startedAt: T0 + 1, endedAt: T0 + 5, currentTool: null }),
        makeRun({ agentId: 'second', startedAt: T0 + 2 }),
      ],
    }));
    render(<AgentsTab sessionId="L" />);
    const diagram = screen.getByRole('region', { name: /agent diagram/i });
    const attr = (sel: string) => diagram.querySelector(sel)?.getAttribute('data-active');
    expect(attr('[data-link="first"]')).toBe('true');
    expect(attr('[data-stub="first"]')).toBe('false');
    expect(attr('[data-stub="second"]')).toBe('true');
  });

  it('lists activity newest first', () => {
    seed(makeSession('L', {
      toolLog: [
        { tool: 'Agent', input: 'Find hook files', timestamp: T0 + 5 },
        { tool: 'Grep', input: 'agent_id', timestamp: T0 + 20, agentId: 'a1' },
      ],
      subagents: [makeRun()],
    }));
    render(<AgentsTab sessionId="L" />);
    const rows = within(screen.getByRole('table', { name: /agent activity/i })).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[2].textContent)).toEqual(['Grep', 'start', 'Agent']);
  });

  it('marks a failed call with a word-backed glyph, not colour alone', () => {
    seed(makeSession('L', { toolLog: [{ tool: 'Bash', input: 'npm test', timestamp: T0, failed: true }] }));
    render(<AgentsTab sessionId="L" />);
    const row = within(screen.getByRole('table', { name: /agent activity/i })).getAllByRole('row')[1];
    expect(within(row).getByLabelText('failed')).toBeTruthy();
  });

  it('includes the session\'s agent-team teammates', () => {
    seed(
      makeSession('L', { teamId: 'team-L', teamRole: 'leader' }),
      makeSession('T', { teamId: 'team-L', teamRole: 'member', agentName: 'reviewer', status: 'approval', startedAt: T0 + 1 }),
    );
    render(<AgentsTab sessionId="L" />);
    expect(screen.getByRole('article', { name: /reviewer, teammate, waiting on you/i })).toBeTruthy();
    expect(screen.getByText('0 working · 1 waiting on you · 0 finished')).toBeTruthy();
  });

  it('explains an empty diagram', () => {
    seed(makeSession('L', { cliSource: 'claude' }));
    render(<AgentsTab sessionId="L" />);
    expect(screen.getByText(/no subagents or teammates yet/i)).toBeTruthy();
  });

  it('says Codex does not report subagents', () => {
    seed(makeSession('C', { cliSource: 'codex', model: 'gpt-5.5' }));
    render(<AgentsTab sessionId="C" />);
    expect(screen.getByText(/codex doesn.t report subagents/i)).toBeTruthy();
  });

  it('lays out at its real width on the first frame (no one-column flash)', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { width: 800, height: 600, left: 0, right: 800, top: 0, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    );
    seed(makeSession('L', { subagents: [makeRun({ agentId: 'p' }), makeRun({ agentId: 'q' })] }));
    render(<AgentsTab sessionId="L" />);
    expect(document.querySelector('[data-cols]')?.getAttribute('data-cols')).toBe('4');
    vi.restoreAllMocks();
  });

  it('renders nothing for an unknown session', () => {
    const { container } = render(<AgentsTab sessionId="missing" />);
    expect(container.textContent).toBe('');
  });
});

// Click a log row to read its whole TARGET: the cell clips one line, and the
// server keeps only a summary, so a longer `detail` rides on the newest entries.
describe('AgentsTab — opening a log row', () => {
  const LONG = 'cd ~/Documents/exmouth && python3 -c "import json;json.load(open(\'docs/feature/.manifest.json\'))" && echo manifest-ok; git status --short';
  const SHORT = LONG.slice(0, 40);
  const log = () => screen.getByRole('table', { name: /agent activity/i });
  const showsFull = () => screen.queryByText(LONG, { selector: 'pre' });

  beforeEach(() => {
    seed(makeSession('L', {
      toolLog: [
        { tool: 'Bash', input: 'npm test', timestamp: T0 + 1 },
        { tool: 'Bash', input: SHORT, timestamp: T0 + 2, detail: LONG },
      ],
    }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(showToast).mockClear();
    window.getSelection()?.removeAllRanges();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('every row with a target is a button that says it is closed', () => {
    render(<AgentsTab sessionId="L" />);
    const open = within(log()).getByRole('button', { name: SHORT });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(showsFull()).toBeNull();
  });

  it('a click opens the full text under the row, and a second click closes it', async () => {
    const user = userEvent.setup();
    render(<AgentsTab sessionId="L" />);
    const button = within(log()).getByRole('button', { name: SHORT });

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(showsFull()).not.toBeNull();
    expect(button.getAttribute('aria-controls')).toBe(showsFull()!.closest('tr')!.id);

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(showsFull()).toBeNull();
  });

  it('works from the keyboard: Enter opens it once, Space closes it', async () => {
    const user = userEvent.setup();
    render(<AgentsTab sessionId="L" />);
    const button = within(log()).getByRole('button', { name: SHORT });
    button.focus();
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true'); // not toggled twice by the bubbling click
    await user.keyboard(' ');
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('a click anywhere on the row opens it, not only on the target text', async () => {
    const user = userEvent.setup();
    render(<AgentsTab sessionId="L" />);
    const row = within(log()).getByRole('button', { name: SHORT }).closest('tr')!;
    await user.click(within(row).getAllByRole('cell')[0]); // the time cell
    expect(showsFull()).not.toBeNull();
  });

  it('shows the target itself when the call has no longer detail', async () => {
    const user = userEvent.setup();
    render(<AgentsTab sessionId="L" />);
    await user.click(within(log()).getByRole('button', { name: 'npm test' }));
    expect(screen.getByText('npm test', { selector: 'pre' })).toBeTruthy();
  });

  it('shows the error of a failed call and marks it', async () => {
    const user = userEvent.setup();
    seed(makeSession('L', { toolLog: [{ tool: 'Bash', input: 'npm test', timestamp: T0, failed: true, error: 'exit code 1: 3 tests failed' }] }));
    render(<AgentsTab sessionId="L" />);
    await user.click(within(log()).getByRole('button', { name: /npm test/ }));
    expect(screen.getByText(/exit code 1: 3 tests failed/)).toBeTruthy();
  });

  it('names the agent, the action and the full time of the call', async () => {
    const user = userEvent.setup();
    render(<AgentsTab sessionId="L" />);
    await user.click(within(log()).getByRole('button', { name: SHORT }));
    const detail = showsFull()!.closest('tr')!;
    expect(within(detail).getByText(/Bash/)).toBeTruthy();
    expect(within(detail).getByText(/leader/)).toBeTruthy();
    expect(within(detail).getByText(/20\d\d/)).toBeTruthy(); // a year: the cell shows only HH:MM:SS
  });

  it('several rows can be open at once', async () => {
    const user = userEvent.setup();
    render(<AgentsTab sessionId="L" />);
    await user.click(within(log()).getByRole('button', { name: SHORT }));
    await user.click(within(log()).getByRole('button', { name: 'npm test' }));
    expect(within(log()).getAllByRole('button', { expanded: true })).toHaveLength(2);
  });

  it('a row with nothing in its target is not a button', () => {
    seed(makeSession('L', { subagents: [makeRun({ description: '', status: 'working' })] }));
    render(<AgentsTab sessionId="L" />);
    const startRow = within(log()).getAllByRole('row').find((r) => within(r).queryByText('start'))!;
    expect(within(startRow).queryByRole('button')).toBeNull();
  });

  // The guard is for a drag-select that ends in a click on the row: it must look at THIS row's
  // selection, not at whatever is selected anywhere on the page.
  const selectIn = (el: Element) => window.getSelection()!.selectAllChildren(el);

  it('selecting text in a row does not toggle that row', () => {
    render(<AgentsTab sessionId="L" />);
    const row = within(log()).getByRole('button', { name: SHORT }).closest('tr')!;
    selectIn(within(row).getAllByRole('cell')[1]);
    fireEvent.click(within(row).getAllByRole('cell')[1], { detail: 1 });
    expect(showsFull()).toBeNull();
  });

  it('a selection in one row does not stop another row from opening', () => {
    render(<AgentsTab sessionId="L" />);
    const rows = within(log()).getAllByRole('row');
    const other = within(log()).getByRole('button', { name: 'npm test' }).closest('tr')!;
    const selected = within(log()).getByRole('button', { name: SHORT }).closest('tr')!;
    selectIn(within(selected).getAllByRole('cell')[1]);
    fireEvent.click(within(other).getByRole('button', { name: 'npm test' }), { detail: 1 });
    expect(rows.length).toBeGreaterThan(1);
    expect(screen.getByText('npm test', { selector: 'pre' })).toBeTruthy();
  });

  it('the keyboard is never blocked by a selection', () => {
    render(<AgentsTab sessionId="L" />);
    const button = within(log()).getByRole('button', { name: SHORT });
    selectIn(within(button.closest('tr')!).getAllByRole('cell')[1]);
    fireEvent.click(button, { detail: 0 }); // what Enter and Space on a button send
    expect(showsFull()).not.toBeNull();
  });

  it('copies the full text', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AgentsTab sessionId="L" />);
    await user.click(within(log()).getByRole('button', { name: SHORT }));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(LONG);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('says when the text was cut at the server\'s cap, and copies it without the marker', async () => {
    const user = userEvent.setup();
    const cut = `${'a'.repeat(1000)}…`;
    seed(makeSession('L', { toolLog: [{ tool: 'Bash', input: 'a'.repeat(120), timestamp: T0, detail: cut }] }));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AgentsTab sessionId="L" />);
    await user.click(within(log()).getByRole('button', { name: 'a'.repeat(120) }));
    expect(screen.getByText(/first 1,000 characters/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('a'.repeat(1000));
  });

  it('does not claim a cut when the text was whole', async () => {
    const user = userEvent.setup();
    render(<AgentsTab sessionId="L" />);
    await user.click(within(log()).getByRole('button', { name: SHORT }));
    expect(screen.queryByText(/first 1,000 characters/i)).toBeNull();
  });

  it('tells the user when the clipboard refuses', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
    render(<AgentsTab sessionId="L" />);
    await user.click(within(log()).getByRole('button', { name: SHORT }));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(showToast).toHaveBeenCalledWith('Could not copy to the clipboard', 'error');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy(); // not "Copied"
  });

  it('opened rows do not follow you to another session', async () => {
    const user = userEvent.setup();
    seed(
      makeSession('L', { toolLog: [{ tool: 'Bash', input: 'npm test', timestamp: T0 + 1 }] }),
      makeSession('M', { toolLog: [{ tool: 'Bash', input: 'npm test', timestamp: T0 + 1 }] }),
    );
    const { rerender } = render(<AgentsTab sessionId="L" />);
    await user.click(within(log()).getByRole('button', { name: 'npm test' }));
    rerender(<AgentsTab sessionId="M" />);
    expect(within(log()).getByRole('button', { name: 'npm test' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('copying does not close the detail', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
    render(<AgentsTab sessionId="L" />);
    await user.click(within(log()).getByRole('button', { name: SHORT }));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(showsFull()).not.toBeNull();
  });

  it('an open row stays with its command when the capped tool log rolls over', async () => {
    const user = userEvent.setup();
    render(<AgentsTab sessionId="L" />);
    await user.click(within(log()).getByRole('button', { name: SHORT }));
    // the server shifts the oldest entry out and appends a new call: every array index moves
    act(() => seed(makeSession('L', {
      toolLog: [
        { tool: 'Bash', input: SHORT, timestamp: T0 + 2, detail: LONG },
        { tool: 'Bash', input: 'git push', timestamp: T0 + 3 },
      ],
    })));
    expect(showsFull()).not.toBeNull();
    expect(within(log()).getByRole('button', { name: 'git push' })).toHaveAttribute('aria-expanded', 'false');
  });
});


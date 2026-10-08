import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Session, SubagentRun } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import AgentsTab from './AgentsTab';

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

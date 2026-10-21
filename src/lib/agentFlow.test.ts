import { describe, it, expect } from 'vitest';
import type { Session, SubagentRun } from '@/types';
import {
  buildAgentFlow,
  teammatesOf,
  countLiveAgents,
  columnsFor,
  chunkRows,
  AGENT_CARD_MIN_PX,
  AGENT_GAP_PX,
  LOG_LIMIT,
  MAX_FINISHED_CARDS,
  subagentNode,
  subagentLog,
} from './agentFlow';
import { TOOL_DETAIL_KEEP } from '../../server/sessionTrim';

const T0 = 1_791_000_000_000;

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    sessionId: id,
    status: 'idle',
    animationState: 'Idle',
    emote: null,
    projectName: 'agent-manager',
    projectPath: '/tmp/agent-manager',
    title: `Session ${id}`,
    source: 'terminal',
    model: 'claude-opus-5-5',
    startedAt: T0,
    lastActivityAt: T0,
    endedAt: null,
    currentPrompt: '',
    promptHistory: [],
    toolUsage: {},
    totalToolCalls: 0,
    toolLog: [],
    responseLog: [],
    events: [],
    pendingTool: null,
    waitingDetail: null,
    subagentCount: 0,
    terminalId: null,
    cachedPid: null,
    archived: 0,
    queueCount: 0,
    ...overrides,
  };
}

function makeRun(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    agentId: 'a1',
    agentType: 'Explore',
    description: 'Find hook files',
    descriptionConfirmed: false,
    status: 'working',
    startedAt: T0 + 10,
    endedAt: null,
    lastActivityAt: T0 + 10,
    toolCount: 2,
    currentTool: 'Grep',
    currentTarget: 'agent_id',
    ...over,
  };
}

describe('buildAgentFlow: leader', () => {
  it('names the leader with its display title and maps a working status', () => {
    const flow = buildAgentFlow(makeSession('L', {
      title: 'fix the queue', status: 'working', cliSource: 'claude',
      toolLog: [{ tool: 'Read', input: 'queue.ts', timestamp: T0 + 1 }],
    }), []);
    expect(flow.leader).toMatchObject({
      kind: 'leader', name: 'fix the queue', state: 'working', tool: 'Read', target: 'queue.ts',
    });
    expect(flow.leader.role).toBe('claude · claude-opus-5-5');
  });

  it('shows the leader\'s own latest call, never one a subagent made', () => {
    const flow = buildAgentFlow(makeSession('L', {
      status: 'working',
      toolLog: [
        { tool: 'Agent', input: 'Find hook files', timestamp: T0 + 1 },
        { tool: 'Grep', input: 'agent_id', timestamp: T0 + 2, agentId: 'a1' },
      ],
      subagents: [makeRun()],
    }), []);
    expect(flow.leader.tool).toBe('Agent');
  });

  it('has no current tool once the leader is not working', () => {
    const flow = buildAgentFlow(makeSession('L', {
      status: 'waiting', toolLog: [{ tool: 'Read', input: 'x', timestamp: T0 }],
    }), []);
    expect(flow.leader).toMatchObject({ state: 'idle', tool: null, target: null });
  });

  it.each([
    ['prompting', 'working'], ['approval', 'attention'], ['input', 'attention'],
    ['idle', 'idle'], ['connecting', 'idle'], ['ended', 'ended'],
  ] as const)('maps status %s to %s', (status, state) => {
    expect(buildAgentFlow(makeSession('L', { status }), []).leader.state).toBe(state);
  });
});

describe('buildAgentFlow: agents', () => {
  it('turns subagent runs and teammates into cards in start order', () => {
    const mate = makeSession('T', {
      teamId: 'team-L', teamRole: 'member', agentName: 'reviewer', agentType: 'code-reviewer',
      status: 'working', startedAt: T0 + 5,
      toolLog: [{ tool: 'Read', input: 'server/db.ts', timestamp: T0 + 6 }],
    });
    const flow = buildAgentFlow(makeSession('L', { subagents: [makeRun()] }), [mate]);
    expect(flow.agents.map((a) => [a.kind, a.name])).toEqual([['teammate', 'reviewer'], ['subagent', 'Explore']]);
    expect(flow.agents[0]).toMatchObject({ state: 'working', tool: 'Read', target: 'server/db.ts', role: 'teammate' });
    expect(flow.agents[1]).toMatchObject({
      state: 'working', tool: 'Grep', target: 'agent_id', description: 'Find hook files', toolCount: 2, role: 'subagent',
    });
  });

  it('shows a finished subagent as done or ended, without a current tool', () => {
    const flow = buildAgentFlow(makeSession('L', {
      subagents: [
        makeRun({ agentId: 'd', status: 'done', endedAt: T0 + 50, currentTool: null, currentTarget: null }),
        makeRun({ agentId: 'e', status: 'ended', endedAt: T0 + 60, currentTool: null, currentTarget: null }),
      ],
    }), []);
    expect(flow.agents.map((a) => a.state)).toEqual(['done', 'ended']);
    expect(flow.agents[0].tool).toBeNull();
  });

  it('shows an ended teammate as done', () => {
    const mate = makeSession('T', { status: 'ended', agentName: 'r', endedAt: T0 + 9 });
    expect(buildAgentFlow(makeSession('L'), [mate]).agents[0].state).toBe('done');
  });

  it('keeps every working agent but only the latest finished ones, and counts the rest', () => {
    const runs = [makeRun({ agentId: 'w', startedAt: T0 })];
    for (let i = 0; i < MAX_FINISHED_CARDS + 3; i++) {
      runs.push(makeRun({ agentId: `d${i}`, status: 'done', startedAt: T0 + 1 + i, endedAt: T0 + 100 + i }));
    }
    const flow = buildAgentFlow(makeSession('L', { subagents: runs }), []);
    expect(flow.agents).toHaveLength(1 + MAX_FINISHED_CARDS);
    expect(flow.agents[0].id).toBe('w');
    expect(flow.agents.some((a) => a.id === 'd0')).toBe(false);
    expect(flow.hiddenFinished).toBe(3);
    expect(flow.live).toBe(1);
    expect(flow.finished).toBe(MAX_FINISHED_CARDS + 3);
  });

  it('says a Codex session reports no subagents', () => {
    expect(buildAgentFlow(makeSession('C', { cliSource: 'codex', model: 'gpt-5.5' }), []).reportsSubagents).toBe(false);
    expect(buildAgentFlow(makeSession('L', { cliSource: 'claude' }), []).reportsSubagents).toBe(true);
  });
});

describe('buildAgentFlow: log', () => {
  it('merges every agent\'s calls and subagent start/finish, newest first', () => {
    const mate = makeSession('T', {
      agentName: 'reviewer', toolLog: [{ tool: 'Read', input: 'db.ts', timestamp: T0 + 30 }],
    });
    const flow = buildAgentFlow(makeSession('L', {
      toolLog: [
        { tool: 'Agent', input: 'Find hook files', timestamp: T0 + 5 },
        { tool: 'Grep', input: 'agent_id', timestamp: T0 + 20, agentId: 'a1', failed: true },
      ],
      subagents: [makeRun({ startedAt: T0 + 10, status: 'done', endedAt: T0 + 40 })],
    }), [mate]);
    expect(flow.log.map((r) => [r.agent, r.action, r.target])).toEqual([
      ['Explore', 'done', '2 tools'],
      ['reviewer', 'Read', 'db.ts'],
      ['Explore', 'Grep', 'agent_id'],
      ['Explore', 'start', 'Find hook files'],
      ['leader', 'Agent', 'Find hook files'],
    ]);
    expect(flow.log[2].failed).toBe(true);
    expect(new Set(flow.log.map((r) => r.key)).size).toBe(flow.log.length);
  });

  it('labels a call from a subagent that fell out of the capped list as "subagent"', () => {
    const flow = buildAgentFlow(makeSession('L', {
      toolLog: [{ tool: 'Read', input: 'x', timestamp: T0, agentId: 'gone' }],
    }), []);
    expect(flow.log[0]).toMatchObject({ agent: 'subagent', kind: 'subagent' });
  });

  it('caps the log', () => {
    const toolLog = Array.from({ length: LOG_LIMIT + 20 }, (_, i) => ({ tool: 'Read', input: `${i}`, timestamp: T0 + i }));
    const flow = buildAgentFlow(makeSession('L', { toolLog }), []);
    expect(flow.log).toHaveLength(LOG_LIMIT);
    expect(flow.log[0].target).toBe(`${LOG_LIMIT + 19}`);
  });
});

describe('one subagent (the detail view)', () => {
  const leader = (over: Partial<Session> = {}) => makeSession('L', {
    status: 'working',
    toolLog: [
      { tool: 'Agent', input: 'Find hook files', timestamp: T0 + 5 },
      { tool: 'Grep', input: 'agent_id', timestamp: T0 + 20, agentId: 'a1' },
      { tool: 'Read', input: 'b.ts', timestamp: T0 + 21, agentId: 'b2' },
    ],
    subagents: [makeRun(), makeRun({ agentId: 'b2', agentType: 'Plan' })],
    ...over,
  });

  it('subagentNode is the run as its card shows it, or null for an unknown id', () => {
    expect(subagentNode(leader(), 'a1')).toMatchObject({ id: 'a1', kind: 'subagent', name: 'Explore', state: 'working' });
    expect(subagentNode(leader(), 'nope')).toBeNull();
  });

  it('subagentNode shows a run still working under an ended leader as ended, like its card', () => {
    expect(subagentNode(leader({ status: 'ended' }), 'a1')?.state).toBe('ended');
  });

  it('subagentLog keeps only that run\'s rows (its calls and its start), newest first', () => {
    expect(subagentLog(leader(), 'a1').map((r) => [r.action, r.target])).toEqual([
      ['Grep', 'agent_id'],
      ['start', 'Find hook files'],
    ]);
  });

  it('subagentLog is not crowded out by other agents\' rows in the capped log', () => {
    const busy = Array.from({ length: LOG_LIMIT + 5 }, (_, i) => ({ tool: 'Read', input: `${i}`, timestamp: T0 + 100 + i, agentId: 'b2' }));
    const rows = subagentLog(leader({ toolLog: [{ tool: 'Grep', input: 'mine', timestamp: T0 + 20, agentId: 'a1' }, ...busy] }), 'a1');
    expect(rows.map((r) => r.target)).toContain('mine');
  });
});

describe('buildAgentFlow: log rows you can open', () => {
  it('the server keeps the longer detail on every call the log can show', () => {
    // The log shows the newest LOG_LIMIT rows, and a leader's own calls among them are at most that many
    // newest tool-log entries; a smaller window left the older half of the rows with a cut-off "detail".
    expect(TOOL_DETAIL_KEEP).toBeGreaterThanOrEqual(LOG_LIMIT);
  });

  const bash = (input: string, timestamp: number, extra: Record<string, unknown> = {}) => ({ tool: 'Bash', input, timestamp, ...extra });

  it('keys a row by what it is, so it keeps its key when the capped tool log rolls over', () => {
    const entries = [bash('a', T0 + 1), bash('b', T0 + 2), bash('c', T0 + 3)];
    const before = buildAgentFlow(makeSession('L', { toolLog: entries }), []);
    // the server shifts the oldest entry out and appends a new one: every array index moves
    const after = buildAgentFlow(makeSession('L', { toolLog: [...entries.slice(1), bash('d', T0 + 4)] }), []);
    const keyOf = (flow: typeof before, target: string) => flow.log.find((r) => r.target === target)!.key;
    expect(keyOf(after, 'b')).toBe(keyOf(before, 'b'));
    expect(keyOf(after, 'c')).toBe(keyOf(before, 'c'));
  });

  it('tells two calls of one tool in the same millisecond apart', () => {
    const flow = buildAgentFlow(makeSession('L', { toolLog: [bash('first', T0), bash('second', T0)] }), []);
    expect(new Set(flow.log.map((r) => r.key)).size).toBe(2);
  });

  it('keys a teammate\'s rows the same way', () => {
    const mate = makeSession('T', { agentName: 'reviewer', toolLog: [bash('x', T0 + 1), bash('y', T0 + 2)] });
    const before = buildAgentFlow(makeSession('L'), [mate]);
    const rolled = makeSession('T', { agentName: 'reviewer', toolLog: [bash('y', T0 + 2), bash('z', T0 + 3)] });
    const after = buildAgentFlow(makeSession('L'), [rolled]);
    const keyOf = (flow: typeof before, target: string) => flow.log.find((r) => r.target === target)!.key;
    expect(keyOf(after, 'y')).toBe(keyOf(before, 'y'));
  });

  it('carries the longer detail and the error of a call into its row', () => {
    const flow = buildAgentFlow(makeSession('L', {
      toolLog: [bash('cd ~/x && git sta', T0, { detail: 'cd ~/x && git status --short', failed: true, error: 'exit 1' })],
    }), []);
    expect(flow.log[0]).toMatchObject({ target: 'cd ~/x && git sta', detail: 'cd ~/x && git status --short', error: 'exit 1', failed: true });
  });

  it('leaves detail and error off a row that has neither', () => {
    const flow = buildAgentFlow(makeSession('L', { toolLog: [bash('npm test', T0)] }), []);
    expect('detail' in flow.log[0]).toBe(false);
    expect('error' in flow.log[0]).toBe(false);
  });
});

describe('teammatesOf + countLiveAgents', () => {
  const leader = makeSession('L', { teamId: 'team-L', teamRole: 'leader' });
  const sessions = new Map<string, Session>([
    ['L', leader],
    ['T1', makeSession('T1', { teamId: 'team-L', teamRole: 'member', status: 'working' })],
    ['T2', makeSession('T2', { teamId: 'team-L', teamRole: 'member', status: 'approval' })],
    ['T3', makeSession('T3', { teamId: 'team-L', teamRole: 'member', status: 'waiting' })],
    ['X', makeSession('X', { teamId: 'team-X', teamRole: 'member', status: 'working' })],
  ]);

  it('finds the members of the session\'s own team only', () => {
    expect(teammatesOf(leader, sessions).map((s) => s.sessionId)).toEqual(['T1', 'T2', 'T3']);
  });

  it('finds no teammates for a member or a session outside a team', () => {
    expect(teammatesOf(sessions.get('T1')!, sessions)).toEqual([]);
    expect(teammatesOf(makeSession('solo'), sessions)).toEqual([]);
  });

  it('counts working subagents plus working or waiting-on-you teammates', () => {
    const withRuns = { ...leader, subagents: [makeRun(), makeRun({ agentId: 'd', status: 'done' })] };
    expect(countLiveAgents(withRuns, sessions)).toBe(3);
    expect(countLiveAgents(undefined, sessions)).toBe(0);
  });
});

describe('layout helpers', () => {
  it('fits as many card columns as the width allows, at least one', () => {
    expect(columnsFor(0)).toBe(1);
    expect(columnsFor(AGENT_CARD_MIN_PX)).toBe(1);
    expect(columnsFor(AGENT_CARD_MIN_PX * 2 + AGENT_GAP_PX)).toBe(2);
    expect(columnsFor(AGENT_CARD_MIN_PX * 3 + AGENT_GAP_PX * 2 - 1)).toBe(2);
  });

  it('chunks cards into rows', () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkRows([], 3)).toEqual([]);
    expect(chunkRows([1], 0)).toEqual([[1]]);
  });
});

describe('review fixes', () => {
  it('shows no run as working once the leader has ended (a kill or crash sends no more hooks)', () => {
    const leader = makeSession('L', { status: 'ended', endedAt: T0 + 100, subagents: [makeRun()] });
    const flow = buildAgentFlow(leader, []);
    expect(flow.agents[0].state).toBe('ended');
    expect(flow.live).toBe(0);
    expect(countLiveAgents(leader, new Map([['L', leader]]))).toBe(0);
  });

  it('does not show a stale tool on the leader when the newest call came from a subagent', () => {
    const flow = buildAgentFlow(makeSession('L', {
      status: 'working',
      toolLog: [
        { tool: 'Edit', input: 'old.ts', timestamp: T0 + 1 },
        { tool: 'Grep', input: 'x', timestamp: T0 + 9, agentId: 'a1' },
      ],
      subagents: [makeRun()],
    }), []);
    expect(flow.leader.tool).toBeNull();
  });

  it('labels a teammate\'s own subagent calls with the subagent\'s type', () => {
    const mate = makeSession('T', {
      agentName: 'reviewer',
      subagents: [makeRun({ agentId: 'm1', agentType: 'Plan' })],
      toolLog: [{ tool: 'Read', input: 'a.ts', timestamp: T0 + 3, agentId: 'm1' }],
    });
    const row = buildAgentFlow(makeSession('L'), [mate]).log.find((r) => r.action === 'Read');
    expect(row).toMatchObject({ agent: 'reviewer › Plan', kind: 'subagent' });
  });

  it('counts agents waiting on the user separately from working ones', () => {
    const mate = makeSession('T', { agentName: 'r', status: 'approval' });
    const flow = buildAgentFlow(makeSession('L', { subagents: [makeRun()] }), [mate]);
    expect(flow.live).toBe(1);
    expect(flow.waiting).toBe(1);
  });
});

describe('helper-fork ghosts (unknown type, 0 tools, no task)', () => {
  const ghost = (id: string) => makeRun({
    agentId: id, agentType: 'unknown', description: null, toolCount: 0, status: 'done', endedAt: T0 + 20,
  });

  it('are left out of the cards, the counts and the log', () => {
    const real = makeRun({ agentId: 'r1', toolCount: 3, status: 'done', endedAt: T0 + 30 });
    const flow = buildAgentFlow(makeSession('L', { subagents: [ghost('g1'), real, ghost('g2')] }), []);
    expect(flow.agents.map((a) => a.id)).toEqual(['r1']);
    expect(flow.finished).toBe(1);
    expect(flow.hiddenFinished).toBe(0);
    expect(flow.log.some((row) => row.agentId === 'g1' || row.agentId === 'g2')).toBe(false);
  });

  it('keeps an unknown-type run that did work, has a task, or is still running', () => {
    const runs = [
      makeRun({ agentId: 'tools', agentType: 'unknown', description: null, toolCount: 2, status: 'done', endedAt: T0 + 20 }),
      makeRun({ agentId: 'task', agentType: 'unknown', description: 'Check CI', toolCount: 0, status: 'done', endedAt: T0 + 21 }),
      makeRun({ agentId: 'live', agentType: 'unknown', description: null, toolCount: 0, status: 'working' }),
    ];
    const flow = buildAgentFlow(makeSession('L', { subagents: runs }), []);
    expect(flow.agents.map((a) => a.id).sort()).toEqual(['live', 'task', 'tools']);
  });
});

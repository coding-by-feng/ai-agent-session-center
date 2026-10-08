// test/subagentTracker.test.ts — server/subagentTracker.ts
//
// Payload shapes are the ones Claude Code 2.1.293 actually sent (recorded from a
// real `claude -p` run, Oct 2026): SubagentStart/SubagentStop and every tool call
// made INSIDE a subagent carry `agent_id` + `agent_type` under the LEADER's
// session_id, and the leader's Stop lists still-running subagents in
// `background_tasks` as { id, type: 'subagent', status, description, agent_type }.
// A background subagent outlives its leader's Stop, so "close every run on Stop"
// is wrong; hooks are delivered by detached shells, so events can arrive in any
// order or not at all.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  subagentIdentity,
  noteSpawn,
  startRun,
  recordToolCall,
  finishRun,
  reconcileWithBackground,
  endAllRuns,
  capRuns,
  trackSubagentEvent,
  forgetSubagentSession,
  MAX_SUBAGENT_RUNS,
  SPAWN_MATCH_WINDOW_MS,
  MAX_AGENT_FIELD_CHARS,
  MAX_PENDING_SPAWNS,
} from '../server/subagentTracker.js';
import type { SubagentRun } from '../src/types/session.js';

const T0 = 1_791_000_000_000;

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    agentId: 'a1',
    agentType: 'Explore',
    description: null,
    descriptionConfirmed: false,
    status: 'working',
    startedAt: T0,
    endedAt: null,
    lastActivityAt: T0,
    toolCount: 0,
    currentTool: null,
    currentTarget: null,
    ...over,
  };
}

describe('subagentIdentity', () => {
  it('reads the preserved Claude fields written by the macOS/Linux hook', () => {
    expect(subagentIdentity({ claude_agent_id: 'a1', claude_agent_type: 'Explore', agent_id: null }))
      .toEqual({ id: 'a1', type: 'Explore' });
  });

  it('is null for the leader\'s own events (Claude sends no agent_id there)', () => {
    expect(subagentIdentity({ claude_agent_id: null, claude_agent_type: null, agent_id: null })).toBeNull();
    expect(subagentIdentity({})).toBeNull();
  });

  it('falls back to agent_id when the hook passes the payload through untouched (Windows, older hook)', () => {
    expect(subagentIdentity({ agent_id: 'a2', agent_type: 'Plan' })).toEqual({ id: 'a2', type: 'Plan' });
  });

  it('does NOT fall back to agent_id when claude_agent_id is present but null: agent_id is then the team env id', () => {
    expect(subagentIdentity({ claude_agent_id: null, agent_id: 'teammate-env-id', agent_type: 'researcher' }))
      .toBeNull();
  });

  it('ignores an id equal to the session\'s own team identity', () => {
    expect(subagentIdentity({ claude_agent_id: 'same', agent_id: 'same' })).toBeNull();
  });

  it('reports a missing type as null', () => {
    expect(subagentIdentity({ claude_agent_id: 'a3', claude_agent_type: '' })).toEqual({ id: 'a3', type: null });
  });
});

describe('noteSpawn + startRun: the leader\'s Agent call names the task', () => {
  it('gives a started run the description of the matching Agent call (same type, FIFO)', () => {
    let pending = noteSpawn([], { description: 'Find hook files', subagent_type: 'Explore' }, T0);
    pending = noteSpawn(pending, { description: 'Review the diff', subagent_type: 'code-reviewer' }, T0 + 1);
    pending = noteSpawn(pending, { description: 'Second explore', subagent_type: 'Explore' }, T0 + 2);

    const a = startRun([], pending, { agentId: 'x', agentType: 'Explore', at: T0 + 10 });
    expect(a.runs[0].description).toBe('Find hook files');
    const b = startRun(a.runs, a.pending, { agentId: 'y', agentType: 'Explore', at: T0 + 11 });
    expect(b.runs[1].description).toBe('Second explore');
    expect(b.pending).toHaveLength(1);
    expect(b.pending[0].agentType).toBe('code-reviewer');
  });

  it('defaults an Agent call without subagent_type to general-purpose', () => {
    const pending = noteSpawn([], { description: 'Do it' }, T0);
    expect(pending[0].agentType).toBe('general-purpose');
  });

  it('ignores Agent calls with no description and expires stale ones', () => {
    expect(noteSpawn([], { subagent_type: 'Explore' }, T0)).toEqual([]);
    const old = noteSpawn([], { description: 'old', subagent_type: 'Explore' }, T0);
    const r = startRun([], old, { agentId: 'x', agentType: 'Explore', at: T0 + SPAWN_MATCH_WINDOW_MS + 1 });
    expect(r.runs[0].description).toBeNull();
    expect(r.pending).toEqual([]);
  });

  it('does not duplicate a run whose tool call arrived before its SubagentStart', () => {
    const early = recordToolCall([], { id: 'x', type: 'Explore' }, 'Grep', 'agent_id', T0);
    const r = startRun(early.runs, [], { agentId: 'x', agentType: 'Explore', at: T0 + 5 });
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0].toolCount).toBe(1);
  });

  it('never mutates its inputs', () => {
    const runs = Object.freeze([run()]) as readonly SubagentRun[];
    const pending = Object.freeze([]) as readonly never[];
    expect(() => startRun(runs, pending, { agentId: 'b', agentType: 'Plan', at: T0 })).not.toThrow();
    expect(runs).toHaveLength(1);
  });
});

describe('recordToolCall', () => {
  it('stamps the current tool and counts calls on the matching run', () => {
    const r = recordToolCall([run()], { id: 'a1', type: 'Explore' }, 'Grep', '"agent_id" src/', T0 + 3);
    expect(r.matched).toBe(true);
    expect(r.runs[0]).toMatchObject({ toolCount: 1, currentTool: 'Grep', currentTarget: '"agent_id" src/', lastActivityAt: T0 + 3 });
  });

  it('creates the run when its SubagentStart was lost (type known)', () => {
    const r = recordToolCall([], { id: 'late', type: 'Plan' }, 'Read', 'a.ts', T0);
    expect(r.matched).toBe(true);
    expect(r.runs[0]).toMatchObject({ agentId: 'late', agentType: 'Plan', status: 'working', toolCount: 1 });
  });

  it('does not invent a run from an id with no type', () => {
    const r = recordToolCall([], { id: 'mystery', type: null }, 'Read', 'a.ts', T0);
    expect(r).toEqual({ runs: [], matched: false });
  });

  it('reopens a run that was closed as ended but is evidently still working', () => {
    const r = recordToolCall([run({ status: 'ended', endedAt: T0 })], { id: 'a1', type: 'Explore' }, 'Bash', 'ls', T0 + 9);
    expect(r.runs[0]).toMatchObject({ status: 'working', endedAt: null, toolCount: 1 });
  });

  it('leaves a done run done (a straggler hook after SubagentStop)', () => {
    const r = recordToolCall([run({ status: 'done', endedAt: T0 })], { id: 'a1', type: 'Explore' }, 'Bash', 'ls', T0 + 9);
    expect(r.runs[0].status).toBe('done');
    expect(r.matched).toBe(true);
  });
});

describe('finishRun', () => {
  it('marks the run done and clears its current tool', () => {
    const runs = finishRun([run({ currentTool: 'Grep' })], { id: 'a1', type: 'Explore' }, T0 + 42);
    expect(runs[0]).toMatchObject({ status: 'done', endedAt: T0 + 42, currentTool: null, currentTarget: null });
  });

  it('upgrades an ended run to done when its SubagentStop arrives late', () => {
    const runs = finishRun([run({ status: 'ended', endedAt: T0 + 1 })], { id: 'a1', type: 'Explore' }, T0 + 2);
    expect(runs[0]).toMatchObject({ status: 'done', endedAt: T0 + 2 });
  });

  it('takes the description from background_tasks when the Agent call was missed', () => {
    const bg = [{ id: 'a1', type: 'subagent', status: 'running', description: 'List .txt files', agent_type: 'Explore' }];
    const runs = finishRun([run()], { id: 'a1', type: 'Explore' }, T0 + 5, bg);
    expect(runs[0].description).toBe('List .txt files');
  });

  it('records a run whose start was never seen, as done', () => {
    const runs = finishRun([], { id: 'ghost', type: 'Plan' }, T0 + 5);
    expect(runs[0]).toMatchObject({ agentId: 'ghost', agentType: 'Plan', status: 'done', endedAt: T0 + 5 });
  });

  it('without an id closes the oldest working run', () => {
    const runs = finishRun(
      [run({ agentId: 'old', startedAt: T0 }), run({ agentId: 'new', startedAt: T0 + 1 })],
      null,
      T0 + 9,
    );
    expect(runs.map((r) => r.status)).toEqual(['done', 'working']);
  });
});

describe('reconcileWithBackground (the leader\'s Stop)', () => {
  it('keeps a background subagent that is still running', () => {
    const bg = [{ id: 'a1', type: 'subagent', status: 'running', description: 'List .txt files', agent_type: 'Explore' }];
    const runs = reconcileWithBackground([run()], bg, T0 + 5);
    expect(runs[0]).toMatchObject({ status: 'working', description: 'List .txt files' });
  });

  it('closes a working run the CLI no longer lists, as ended (its stop hook was lost)', () => {
    const runs = reconcileWithBackground([run()], [], T0 + 5);
    expect(runs[0]).toMatchObject({ status: 'ended', endedAt: T0 + 5 });
  });

  it('adds a running subagent it never saw start (server restarted mid-run)', () => {
    const bg = [{ id: 'b9', type: 'subagent', status: 'running', description: 'Audit docs', agent_type: 'general-purpose' }];
    const runs = reconcileWithBackground([], bg, T0 + 5);
    expect(runs[0]).toMatchObject({ agentId: 'b9', agentType: 'general-purpose', description: 'Audit docs', status: 'working' });
  });

  it('ignores non-subagent background work (shells, crons)', () => {
    const bg = [{ id: 'sh1', type: 'bash', status: 'running', description: 'npm run dev' }];
    expect(reconcileWithBackground([], bg, T0)).toEqual([]);
  });

  it('changes nothing when the CLI sent no background_tasks at all (older CLI): no guessing', () => {
    const runs = [run()];
    expect(reconcileWithBackground(runs, undefined, T0 + 5)).toBe(runs);
  });

  it('leaves done runs alone', () => {
    const runs = reconcileWithBackground([run({ status: 'done', endedAt: T0 })], [], T0 + 5);
    expect(runs[0]).toMatchObject({ status: 'done', endedAt: T0 });
  });
});

describe('endAllRuns + capRuns', () => {
  it('ends every working run and keeps finished ones as they were', () => {
    const runs = endAllRuns([run(), run({ agentId: 'd', status: 'done', endedAt: T0 })], T0 + 7);
    expect(runs.map((r) => [r.status, r.endedAt])).toEqual([['ended', T0 + 7], ['done', T0]]);
  });

  it('caps the list, dropping the oldest finished runs first and never a working one', () => {
    const many: SubagentRun[] = [];
    many.push(run({ agentId: 'w-old', startedAt: T0, status: 'working' }));
    for (let i = 0; i < MAX_SUBAGENT_RUNS + 5; i++) {
      many.push(run({ agentId: `d${i}`, startedAt: T0 + 1 + i, status: 'done', endedAt: T0 + 1 + i }));
    }
    const capped = capRuns(many);
    expect(capped).toHaveLength(MAX_SUBAGENT_RUNS);
    expect(capped[0].agentId).toBe('w-old');
    expect(capped.some((r) => r.agentId === 'd0')).toBe(false);
    expect(capped[capped.length - 1].agentId).toBe(`d${MAX_SUBAGENT_RUNS + 4}`);
  });
});

describe('trackSubagentEvent: one session, events as Claude Code sent them', () => {
  const SID = 'sess-1';
  beforeEach(() => forgetSubagentSession(SID));

  it('follows spawn → start → tool calls → leader Stop (still running) → stop', () => {
    let runs: SubagentRun[] = [];
    const step = (event: string, hook: Record<string, unknown>, target: string | null, at: number) => {
      const r = trackSubagentEvent(SID, runs, event, hook, target, at);
      runs = r.runs;
      return r;
    };

    const leaderAgentCall = step('PreToolUse', {
      tool_name: 'Agent', claude_agent_id: null,
      tool_input: { description: 'List .txt files via Glob', subagent_type: 'Explore', prompt: '…' },
    }, 'List .txt files via Glob', T0);
    expect(leaderAgentCall.toolAgentId).toBeNull();

    step('SubagentStart', { claude_agent_id: 'aef7301b0d329d4ad', claude_agent_type: 'Explore' }, null, T0 + 1);
    expect(runs[0]).toMatchObject({ agentType: 'Explore', description: 'List .txt files via Glob', status: 'working' });

    const leaderStop = step('Stop', {
      claude_agent_id: null,
      background_tasks: [{ id: 'aef7301b0d329d4ad', type: 'subagent', status: 'running', description: 'List .txt files via Glob', agent_type: 'Explore' }],
    }, null, T0 + 2);
    expect(leaderStop.runs[0].status).toBe('working');

    const sub = step('PreToolUse', {
      tool_name: 'Bash', claude_agent_id: 'aef7301b0d329d4ad', claude_agent_type: 'Explore',
    }, 'ls *.txt', T0 + 3);
    expect(sub.toolAgentId).toBe('aef7301b0d329d4ad');
    expect(runs[0]).toMatchObject({ currentTool: 'Bash', currentTarget: 'ls *.txt', toolCount: 1 });

    step('SubagentStop', { claude_agent_id: 'aef7301b0d329d4ad', claude_agent_type: 'Explore' }, null, T0 + 4);
    expect(runs[0]).toMatchObject({ status: 'done', endedAt: T0 + 4 });

    step('Stop', { claude_agent_id: null, background_tasks: [] }, null, T0 + 5);
    expect(runs[0].status).toBe('done');
  });

  it('a leader tool call is never attributed to a subagent', () => {
    const r = trackSubagentEvent(SID, [run()], 'PreToolUse', { tool_name: 'Read', claude_agent_id: null }, 'a.ts', T0);
    expect(r.toolAgentId).toBeNull();
    expect(r.runs[0].toolCount).toBe(0);
  });

  it('SessionStart and SessionEnd end every working run', () => {
    for (const ev of ['SessionStart', 'SessionEnd']) {
      const r = trackSubagentEvent(SID, [run()], ev, {}, null, T0 + 1);
      expect(r.runs[0].status).toBe('ended');
    }
  });

  it('returns the same array for events it does not care about', () => {
    const runs = [run()];
    expect(trackSubagentEvent(SID, runs, 'Notification', {}, null, T0).runs).toBe(runs);
  });

  it('keeps pending Agent descriptions per session', () => {
    trackSubagentEvent('other', [], 'PreToolUse', { tool_name: 'Agent', tool_input: { description: 'Not mine', subagent_type: 'Explore' } }, null, T0);
    const r = trackSubagentEvent(SID, [], 'SubagentStart', { claude_agent_id: 'z', claude_agent_type: 'Explore' }, null, T0 + 1);
    expect(r.runs[0].description).toBeNull();
    forgetSubagentSession('other');
  });
});

describe('untrusted payload values (hooks can be forged by any local process)', () => {
  it('caps an agent id and type, which would otherwise ride on every session broadcast', () => {
    const id = subagentIdentity({ claude_agent_id: 'x'.repeat(10_000), claude_agent_type: 'y'.repeat(10_000) })!;
    expect(id.id.length).toBeLessThanOrEqual(MAX_AGENT_FIELD_CHARS);
    expect(id.type!.length).toBeLessThanOrEqual(MAX_AGENT_FIELD_CHARS);
    const bg = [{ id: 'z'.repeat(10_000), type: 'subagent', status: 'running', agent_type: 'w'.repeat(10_000) }];
    const runs = reconcileWithBackground([], bg, T0);
    expect(runs[0].agentId.length).toBeLessThanOrEqual(MAX_AGENT_FIELD_CHARS);
    expect(runs[0].agentType.length).toBeLessThanOrEqual(MAX_AGENT_FIELD_CHARS);
  });

  it('ignores a background description that is not a string instead of throwing or storing it', () => {
    const bg = [{ id: 'a1', type: 'subagent', status: 'running', description: { length: 500, slice: 1 } }];
    expect(() => reconcileWithBackground([run({ description: null })], bg, T0)).not.toThrow();
    expect(reconcileWithBackground([run({ description: null })], bg, T0)[0].description).toBeNull();
    expect(reconcileWithBackground([], [{ id: 'b', type: 'subagent', status: 'running', description: 42 }], T0)[0].description).toBeNull();
    expect(finishRun([run({ description: null })], { id: 'a1', type: 'Explore' }, T0, bg)[0].description).toBeNull();
  });
});

describe('exact descriptions (review: parallel same-type spawns got each other\'s task)', () => {
  const SID2 = 'sess-exact';
  beforeEach(() => forgetSubagentSession(SID2));

  const agentCall = (description: string) => ({ tool_name: 'Agent', claude_agent_id: null, tool_input: { description, subagent_type: 'Explore' } });
  const launched = (agentId: string, description: string) => ({
    tool_name: 'Agent', claude_agent_id: null,
    tool_input: { description, subagent_type: 'Explore' },
    tool_response: { isAsync: true, status: 'async_launched', agentId, description },
  });

  it('the leader\'s PostToolUse binds each description to its agent, swapping back a wrong FIFO guess', () => {
    let runs: SubagentRun[] = [];
    const step = (event: string, hook: Record<string, unknown>, at: number) => {
      runs = trackSubagentEvent(SID2, runs, event, hook, null, at).runs;
    };
    step('PreToolUse', agentCall('task A'), T0);
    step('PreToolUse', agentCall('task B'), T0 + 1);
    // Racing shells: B's SubagentStart lands first and takes "task A" by FIFO.
    step('SubagentStart', { claude_agent_id: 'B', claude_agent_type: 'Explore' }, T0 + 2);
    step('SubagentStart', { claude_agent_id: 'A', claude_agent_type: 'Explore' }, T0 + 3);
    expect(runs.find((r) => r.agentId === 'B')?.description).toBe('task A');

    step('PostToolUse', launched('A', 'task A'), T0 + 4);
    expect(runs.find((r) => r.agentId === 'A')).toMatchObject({ description: 'task A', descriptionConfirmed: true });
    expect(runs.find((r) => r.agentId === 'B')).toMatchObject({ description: 'task B', descriptionConfirmed: false });
  });

  it('creates the run from an async launch that beats its SubagentStart, without spending another run\'s description', () => {
    let runs: SubagentRun[] = [];
    const step = (event: string, hook: Record<string, unknown>, at: number) => {
      runs = trackSubagentEvent(SID2, runs, event, hook, null, at).runs;
    };
    step('PreToolUse', agentCall('task A'), T0);
    step('PreToolUse', agentCall('task B'), T0 + 1);
    step('PostToolUse', launched('A', 'task A'), T0 + 2);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: 'A', status: 'working', description: 'task A', descriptionConfirmed: true });
    step('SubagentStart', { claude_agent_id: 'A', claude_agent_type: 'Explore' }, T0 + 3);
    step('SubagentStart', { claude_agent_id: 'B', claude_agent_type: 'Explore' }, T0 + 4);
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.agentId === 'B')?.description).toBe('task B');
  });

  it('does not invent a working run from a synchronous Agent call that already finished', () => {
    const r = trackSubagentEvent(SID2, [], 'PostToolUse', {
      tool_name: 'Agent', claude_agent_id: null, tool_input: { description: 'x', subagent_type: 'Plan' },
      tool_response: { status: 'completed', agentId: 'S' },
    }, null, T0);
    expect(r.runs).toEqual([]);
  });

  it('the CLI\'s id-keyed background_tasks description replaces a guess, and a confirmed one is kept', () => {
    const guessed = run({ description: 'wrong guess', descriptionConfirmed: false });
    const bg = [{ id: 'a1', type: 'subagent', status: 'running', description: 'the real task' }];
    expect(reconcileWithBackground([guessed], bg, T0)[0]).toMatchObject({ description: 'the real task', descriptionConfirmed: true });
    const exact = run({ description: 'exact', descriptionConfirmed: true });
    expect(reconcileWithBackground([exact], [{ ...bg[0], description: 'other' }], T0)[0].description).toBe('exact');
  });

  it('caps the pending description queue (forged hooks)', () => {
    let pending = noteSpawn([], { description: 'p0', subagent_type: 'Explore' }, T0);
    for (let i = 1; i < 50; i++) pending = noteSpawn(pending, { description: `p${i}`, subagent_type: 'Explore' }, T0 + i);
    expect(pending.length).toBeLessThanOrEqual(MAX_PENDING_SPAWNS);
    expect(pending[pending.length - 1].description).toBe('p49');
  });
});

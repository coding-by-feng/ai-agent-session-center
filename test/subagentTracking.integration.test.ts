/**
 * Subagent runs through the real `handleEvent`: proves the session store hands
 * every hook to subagentTracker and tags a subagent's tool calls, which the
 * tracker's own unit tests cannot (they never see a call site).
 *
 * Payloads are shaped as the macOS/Linux hook delivers them: Claude Code's own
 * ids under `claude_agent_id` / `claude_agent_type`, and `agent_id` /
 * `agent_type` overwritten with the (absent) team env, i.e. null.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
}));

vi.mock('../server/wsManager.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/wsManager.js')>();
  return { ...mod, broadcast: vi.fn() };
});

vi.mock('../server/processMonitor.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/processMonitor.js')>();
  return { ...mod, startMonitoring: vi.fn(), stopMonitoring: vi.fn(), startExternalDiscovery: vi.fn() };
});

// The store starts its auto-idle interval on import, so fake the clock first.
vi.useFakeTimers({ now: 1_800_000_000_000 });
const { handleEvent, getSession } = await import('../server/sessionStore.js');

const SID = 'sub-int-1';
const SUB = 'aef7301b0d329d4ad';

function hook(event: string, extra: Record<string, unknown> = {}): void {
  handleEvent({
    session_id: SID,
    hook_event_name: event,
    cwd: '/tmp/subagent-int',
    tty_path: '/dev/ttys901',
    cli_source: 'claude',
    agent_id: null,
    agent_type: null,
    claude_agent_id: null,
    claude_agent_type: null,
    permission_mode: 'bypassPermissions',
    ...extra,
  } as never);
}

afterAll(() => {
  vi.useRealTimers();
});

describe('subagent runs through handleEvent', () => {
  it('records the run, tags its calls, keeps it alive across the leader\'s Stop, and closes it on SubagentStop', () => {
    hook('SessionStart');
    hook('UserPromptSubmit', { prompt: 'list the txt files with an Explore agent' });
    hook('PreToolUse', {
      tool_name: 'Agent',
      tool_input: { description: 'List .txt files via Glob', subagent_type: 'Explore', prompt: '…' },
    });
    hook('SubagentStart', { claude_agent_id: SUB, claude_agent_type: 'Explore' });

    expect(getSession(SID)?.subagents).toMatchObject([
      { agentId: SUB, agentType: 'Explore', description: 'List .txt files via Glob', status: 'working' },
    ]);

    // The leader finishes its turn while the background subagent keeps going.
    hook('Stop', {
      background_tasks: [{ id: SUB, type: 'subagent', status: 'running', description: 'List .txt files via Glob', agent_type: 'Explore' }],
    });
    expect(getSession(SID)?.subagents?.[0].status).toBe('working');

    hook('PreToolUse', {
      tool_name: 'Bash', tool_input: { command: 'ls *.txt' },
      claude_agent_id: SUB, claude_agent_type: 'Explore',
    });
    const session = getSession(SID)!;
    const last = session.toolLog[session.toolLog.length - 1];
    expect(last).toMatchObject({ tool: 'Bash', agentId: SUB });
    expect(session.toolLog.find((t) => t.tool === 'Agent')?.agentId).toBeUndefined();
    expect(session.subagents?.[0]).toMatchObject({ currentTool: 'Bash', toolCount: 1 });

    hook('SubagentStop', { claude_agent_id: SUB, claude_agent_type: 'Explore' });
    expect(getSession(SID)?.subagents?.[0]).toMatchObject({ status: 'done', currentTool: null });
  });

  it('a session restart ends whatever was still running', () => {
    hook('SubagentStart', { claude_agent_id: 'second', claude_agent_type: 'Plan' });
    hook('SessionStart', { source: 'clear' });
    const runs = getSession(SID)?.subagents ?? [];
    expect(runs.find((r) => r.agentId === 'second')?.status).toBe('ended');
  });
});

describe('review fixes through the real store', () => {
  it('a failed call is marked on the agent that made it, not on another agent\'s same-named call', () => {
    const id = 'sub-int-fail';
    const ev = (event: string, extra: Record<string, unknown> = {}) => handleEvent({
      session_id: id, hook_event_name: event, cwd: '/tmp/subagent-int-fail', tty_path: '/dev/ttys902',
      cli_source: 'claude', agent_id: null, agent_type: null, claude_agent_id: null, claude_agent_type: null,
      permission_mode: 'bypassPermissions', ...extra,
    } as never);
    ev('SessionStart');
    ev('SubagentStart', { claude_agent_id: 'A', claude_agent_type: 'Explore' });
    ev('SubagentStart', { claude_agent_id: 'B', claude_agent_type: 'Explore' });
    ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'a' }, claude_agent_id: 'A', claude_agent_type: 'Explore' });
    ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'b' }, claude_agent_id: 'B', claude_agent_type: 'Explore' });
    ev('PostToolUseFailure', { tool_name: 'Bash', error: 'exit 1', claude_agent_id: 'A', claude_agent_type: 'Explore' });
    const log = getSession(id)!.toolLog;
    expect(log.find((t) => t.agentId === 'A')?.failed).toBe(true);
    expect(log.find((t) => t.agentId === 'B')?.failed).toBeUndefined();
  });

  it('the SubagentStart event names the real agent type, not "unknown"', () => {
    const id = 'sub-int-detail';
    handleEvent({
      session_id: id, hook_event_name: 'SubagentStart', cwd: '/tmp/subagent-int-detail', tty_path: '/dev/ttys903',
      cli_source: 'claude', agent_id: null, agent_type: null, claude_agent_id: 'Q1234567890', claude_agent_type: 'Explore',
    } as never);
    const ev = getSession(id)!.events.find((e) => e.type === 'SubagentStart');
    expect(ev?.detail).toContain('Explore');
  });

  it('killing a session ends its running subagents', async () => {
    const { killSession } = await import('../server/sessionStore.js');
    const id = 'sub-int-kill';
    handleEvent({
      session_id: id, hook_event_name: 'SubagentStart', cwd: '/tmp/subagent-int-kill', tty_path: '/dev/ttys904',
      cli_source: 'claude', agent_id: null, agent_type: null, claude_agent_id: 'K', claude_agent_type: 'Plan',
    } as never);
    expect(getSession(id)!.subagents?.[0].status).toBe('working');
    killSession(id);
    expect(getSession(id)?.subagents?.[0].status).toBe('ended');
  });

  it('a resume re-key starts the new session with no subagent runs', async () => {
    const { reKeyResumedSession } = await import('../server/sessionMatcher.js');
    const sessions = new Map();
    const old = { ...getSession(SID)!, sessionId: 'rekey-old' };
    sessions.set('rekey-old', old);
    const result = reKeyResumedSession(sessions, old, 'rekey-new', 'rekey-old');
    expect(result.subagents ?? []).toEqual([]);
  });
});

/**
 * AASC-43: a waiting session carries a structured `pendingRequest` (what the CLI is asking, with
 * its input and choices), set and cleared by the hooks, broadcast with every session update and
 * snapshot, and never archived or written to the restart snapshot.
 *
 * Goes through the real `handleEvent`, so it also proves the store wires the helpers in
 * (a unit test on pendingRequests.ts alone could not catch a call site that forgets one).
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// The restart snapshot is written under APP_USER_DATA: give this file a folder of its own,
// so no other test file's snapshot can land between the write and the read below.
const dataDir = await vi.hoisted(async () => {
  // Hoisted above the imports, so it loads its own.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const previous = process.env.APP_USER_DATA;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aasc-pending-request-'));
  process.env.APP_USER_DATA = dir;
  return { dir, previous };
});

const ws = vi.hoisted(() => ({ broadcast: vi.fn() }));

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
  return { ...mod, broadcast: ws.broadcast };
});

vi.mock('../server/processMonitor.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/processMonitor.js')>();
  return {
    ...mod,
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    startExternalDiscovery: vi.fn(),
  };
});

// The store starts its 10 s auto-idle interval when it is imported, so the clock has to be fake first.
vi.useFakeTimers({ now: 1_800_000_000_000 });
const { handleEvent, getSession, getAllSessions, saveSnapshot, clearPendingRequest } = await import('../server/sessionStore.js');
const { toArchivedSession } = await import('../server/sessionTrim.js');

let n = 0;
function hook(id: string, event: string, extra: Record<string, unknown> = {}) {
  return handleEvent({
    session_id: id,
    hook_event_name: event,
    cwd: `/tmp/pending-request-${id}`,
    tty_path: `/dev/ttys7${String(n).padStart(2, '0')}`,
    ...extra,
  } as never);
}
function newSession(extra: Record<string, unknown> = {}): string {
  n += 1;
  const id = `pr-${n}`;
  hook(id, 'SessionStart', extra);
  hook(id, 'UserPromptSubmit', { prompt: 'go', ...extra });
  return id;
}
const pendingOf = (id: string) => getSession(id)?.pendingRequest ?? null;

const BASH = { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' }, tool_use_id: 'toolu_bash' };
const QUESTION = {
  tool_name: 'AskUserQuestion',
  tool_use_id: 'toolu_ask',
  tool_input: { questions: [{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] },
};

beforeEach(() => {
  ws.broadcast.mockClear();
});

afterAll(() => {
  vi.useRealTimers();
  if (dataDir.previous === undefined) delete process.env.APP_USER_DATA;
  else process.env.APP_USER_DATA = dataDir.previous;
  rmSync(dataDir.dir, { recursive: true, force: true });
});

describe('pendingRequest is raised', () => {
  it('by a PermissionRequest, with the tool, its input and the call id, next to the old fields', () => {
    const id = newSession();
    hook(id, 'PreToolUse', BASH);
    const result = hook(id, 'PermissionRequest', BASH);
    expect(result?.session.pendingRequest).toMatchObject({
      id: 'toolu_bash', kind: 'permission', cli: 'claude', tool: 'Bash', input: { command: 'rm -rf dist' }, source: 'permission_request',
    });
    const session = getSession(id);
    expect(session?.status).toBe('approval');
    expect(session?.approvalSource).toBe('permission_request');
    expect(session?.waitingDetail).toBe('Approve Bash: rm -rf dist');
  });

  it('rides the session snapshot every new client is handed', () => {
    const id = newSession();
    hook(id, 'PermissionRequest', BASH);
    expect(getAllSessions()[id].pendingRequest?.id).toBe('toolu_bash');
  });

  it('by a Codex PermissionRequest, marked as Codex', () => {
    const id = newSession({ cli_source: 'codex' });
    hook(id, 'PermissionRequest', { cli_source: 'codex', tool_name: 'shell', tool_input: { command: ['git', 'push'] } });
    expect(pendingOf(id)).toMatchObject({ cli: 'codex', kind: 'permission', tool: 'shell' });
  });

  it('by PreToolUse of AskUserQuestion, with its choices', () => {
    const id = newSession();
    hook(id, 'PreToolUse', QUESTION);
    expect(pendingOf(id)).toMatchObject({ id: 'toolu_ask', kind: 'question', source: 'pre_tool_use', options: [{ label: 'Postgres' }, { label: 'SQLite' }] });
  });

  it('by PreToolUse of ExitPlanMode, as a plan approval', () => {
    const id = newSession();
    hook(id, 'PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: 'Step 1' }, tool_use_id: 'toolu_plan' });
    expect(pendingOf(id)).toMatchObject({ id: 'toolu_plan', kind: 'plan', input: { plan: 'Step 1' } });
  });

  it('not by an ordinary PreToolUse', () => {
    const id = newSession();
    hook(id, 'PreToolUse', BASH);
    expect(pendingOf(id)).toBeNull();
  });

  it('by the approval timer only as a guess: the tool, no input', async () => {
    const id = newSession({ permission_mode: 'default' });
    hook(id, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, permission_mode: 'default' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getSession(id)?.status).toBe('approval');
    const req = pendingOf(id);
    expect(req).toMatchObject({ kind: 'permission', tool: 'Read', source: 'timer' });
    expect(req?.input).toBeUndefined();
  });

  it('by a permission_prompt Notification only as a guess, and never over a raised request', () => {
    const id = newSession();
    hook(id, 'PreToolUse', BASH);
    hook(id, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    expect(pendingOf(id)).toMatchObject({ tool: 'Bash', source: 'notification' });
    expect(pendingOf(id)?.input).toBeUndefined();
    hook(id, 'PermissionRequest', BASH);
    expect(pendingOf(id)?.source).toBe('permission_request');
    hook(id, 'Notification', { notification_type: 'permission_prompt', message: 'again' });
    expect(pendingOf(id)?.source).toBe('permission_request');
  });

  it('survives a PreToolUse that lands after its PermissionRequest', () => {
    const id = newSession();
    hook(id, 'PermissionRequest', BASH);
    hook(id, 'PreToolUse', BASH);
    expect(pendingOf(id)?.id).toBe('toolu_bash');
  });
});

describe('pendingRequest is cleared', () => {
  function waiting(): string {
    const id = newSession();
    hook(id, 'PreToolUse', BASH);
    hook(id, 'PermissionRequest', BASH);
    expect(pendingOf(id)).not.toBeNull();
    return id;
  }

  it.each([
    ['PostToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_bash' }],
    ['PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'toolu_bash', error: 'denied' }],
    ['UserPromptSubmit', { prompt: 'do something else' }],
    ['Stop', {}],
    ['SessionEnd', { reason: 'exit' }],
  ])('by %s', (event, extra) => {
    const id = waiting();
    const result = hook(id, event, extra);
    expect(result?.session.pendingRequest).toBeNull();
    expect(pendingOf(id)).toBeNull();
  });

  it('not by the PostToolUse of another call', () => {
    const id = waiting();
    hook(id, 'PostToolUse', { tool_name: 'Read', tool_use_id: 'toolu_read' });
    expect(pendingOf(id)?.id).toBe('toolu_bash');
  });

  it('by a newer request', () => {
    const id = waiting();
    hook(id, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'toolu_push' });
    expect(pendingOf(id)).toMatchObject({ id: 'toolu_push', ambiguous: true });
  });

  it('by an answer the server wrote, only for the request it names', () => {
    const id = waiting();
    expect(clearPendingRequest(id, 'toolu_other')).toBeNull();
    expect(pendingOf(id)?.id).toBe('toolu_bash');
    const updated = clearPendingRequest(id, 'toolu_bash');
    expect(updated?.pendingRequest).toBeNull();
    expect(pendingOf(id)).toBeNull();
    expect(getAllSessions()[id].pendingRequest).toBeNull();
  });
});

// Oct 21, replayed: a background subagent asked at 01:55, the main agent kept working,
// stopped, took a prompt and stopped again. The session read "waiting" all night and the
// phone had nothing to answer, though the dialog was up until 08:58.
describe('a background subagent’s dialog outlives the main agent’s turn', () => {
  const SUB = { claude_agent_id: 'agent-ae88', claude_agent_type: 'general-purpose' };
  const MAIN = { claude_agent_id: null };
  const RM = { tool_name: 'Bash', tool_input: { command: 'rm -f "$d"/*.class' }, tool_use_id: 'toolu_rm' };

  function asked(): string {
    const id = newSession();
    hook(id, 'SubagentStart', SUB);
    hook(id, 'PreToolUse', { ...RM, ...SUB });
    hook(id, 'PermissionRequest', { ...RM, ...SUB });
    return id;
  }

  it('stays approval, with its card, through the main agent’s work, Stop and next prompt', () => {
    const id = asked();
    hook(id, 'PreToolUse', { tool_name: 'Read', tool_use_id: 'toolu_main1', ...MAIN });
    expect(getSession(id)?.status).toBe('approval');
    hook(id, 'PostToolUse', { tool_name: 'Read', tool_use_id: 'toolu_main1', ...MAIN });
    hook(id, 'Stop', MAIN);
    hook(id, 'UserPromptSubmit', { prompt: 'continue', ...MAIN });
    hook(id, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_main2', ...MAIN });
    hook(id, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_main2', ...MAIN });
    const result = hook(id, 'Stop', MAIN);
    expect(result?.session.status).toBe('approval');
    expect(result?.session.approvalSource).toBe('permission_request');
    expect(result?.session.pendingRequest).toMatchObject({ id: 'toolu_rm', tool: 'Bash', agentId: 'agent-ae88' });
    expect(result?.session.waitingDetail).toContain('Approve Bash');
  });

  it('lets go when its own call finishes', () => {
    const id = asked();
    hook(id, 'Stop', MAIN);
    const result = hook(id, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_rm', ...SUB });
    expect(result?.session.pendingRequest).toBeNull();
    expect(result?.session.status).toBe('working');
  });

  it('lets go when its subagent stops', () => {
    const id = asked();
    hook(id, 'Stop', MAIN);
    const result = hook(id, 'SubagentStop', SUB);
    expect(result?.session.pendingRequest).toBeNull();
    expect(result?.session.status).toBe('waiting'); // the main agent had stopped meanwhile
    expect(result?.session.waitingDetail).toBeNull();
  });

  it('a main-agent dialog still ends with the main Stop, as before', () => {
    const id = newSession();
    hook(id, 'PermissionRequest', { ...BASH, ...MAIN });
    const result = hook(id, 'Stop', MAIN);
    expect(result?.session.pendingRequest).toBeNull();
    expect(result?.session.status).toBe('waiting');
  });
});

describe('pendingRequest stays live-only', () => {
  it('is never archived', () => {
    const id = newSession();
    hook(id, 'PermissionRequest', BASH);
    const session = getSession(id);
    expect(session?.pendingRequest).not.toBeNull();
    expect('pendingRequest' in toArchivedSession(session!)).toBe(false);
  });

  it('is never written to the restart snapshot (a PTY never survives a restart; inputs stay off disk)', () => {
    const id = newSession();
    hook(id, 'PermissionRequest', BASH);
    saveSnapshot();
    const raw = readFileSync(join(dataDir.dir, 'data', 'sessions-snapshot.json'), 'utf8');
    const snap = JSON.parse(raw) as { sessions: Record<string, Record<string, unknown>> };
    expect(snap.sessions[id]).toBeDefined();
    expect('pendingRequest' in snap.sessions[id]).toBe(false);
    // The live session keeps it.
    expect(pendingOf(id)?.id).toBe('toolu_bash');
  });
});

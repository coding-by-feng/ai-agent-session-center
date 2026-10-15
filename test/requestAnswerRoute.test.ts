// test/requestAnswerRoute.test.ts — AASC-43: POST /api/sessions/:id/requests/:requestId/answer.
//
// A card answers a waiting request with an intent (allow once, always, deny, an option); the Mac
// checks the session is visible, still waiting on THAT request, and that the caller may drive it,
// then types the keys its own map gives. Wired like server/index.ts wires it: the real visibility
// gate and device-id binding from apiRouter, the real presence baton and session store.
//
// No PTY is ever written: the terminal write path is mocked, and process.kill is guarded.
import express from 'express';
import { createServer, type Server } from 'http';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), default: {},
}));

const pty = vi.hoisted(() => ({
  terminals: new Set<string>(),
  write: vi.fn(),
}));
vi.mock('../server/sshManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/sshManager.js')>();
  return {
    ...actual,
    createTerminal: vi.fn(async () => 'term-never'),
    writeWhenReady: vi.fn(),
    maybeInjectUltracode: vi.fn(),
    getTerminals: () => [...pty.terminals].map((terminalId) => ({ terminalId })),
    writeToTerminal: pty.write,
    getTerminalSessionId: () => null,
    isOpsTerminal: () => false,
    getForegroundProcess: () => 'claude',
  };
});

// No signal but the liveness probe may leave this file (see known-issues.md, "Testing Gaps").
const realProcessKill = process.kill.bind(process);
const killGuard = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`requestAnswerRoute.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

const { createRequestAnswerRouter, ANSWERS_PER_MINUTE } = await import('../server/requestAnswer.js');
const store = await import('../server/sessionStore.js');
const presence = await import('../server/presenceManager.js');
const auth = await import('../server/authManager.js');
const { requireVisibleSession, clientIdFromRequest } = await import('../server/apiRouter.js');
const { isLocalRequest } = await import('../server/requestLocality.js');
const { default: log } = await import('../server/logger.js');

const broadcastSession = vi.fn();
let clock = 1_000_000;

let server: Server;
let base = '';
const PHONE: Record<string, string> = { 'X-Forwarded-For': '192.168.1.70', 'X-AASC-Client-Id': 'phone-ans' };
const OTHER_PHONE: Record<string, string> = { 'X-Forwarded-For': '192.168.1.71', 'X-AASC-Client-Id': 'phone-other' };
const ANON_REMOTE: Record<string, string> = { 'X-Forwarded-For': '192.168.1.72' };
const LOCAL: Record<string, string> = {};

beforeAll(async () => {
  PHONE.Authorization = `Bearer ${auth.createToken('dev-phone-ans')}`;
  OTHER_PHONE.Authorization = `Bearer ${auth.createToken('dev-phone-other')}`;
  ANON_REMOTE.Authorization = `Bearer ${auth.createToken('dev-phone-anon')}`;
  const app = express();
  app.use(express.json());
  app.use('/api', createRequestAnswerRouter({
    requireVisibleSession,
    getSession: store.getSession,
    clientIdOf: clientIdFromRequest,
    isLocal: isLocalRequest,
    canControl: presence.canControl,
    noteControlActivity: presence.noteControlActivity,
    getController: presence.getController,
    terminalExists: (id) => pty.terminals.has(id),
    writeToTerminal: pty.write,
    clearPendingRequest: store.clearPendingRequest,
    broadcastSession,
    env: {},
    now: () => clock,
  }));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  killGuard.mockRestore();
});

beforeEach(() => {
  pty.write.mockClear();
  broadcastSession.mockClear();
  clock += 61_000; // a fresh answer budget for every case
});

let n = 0;

/** A shared (or hidden) session in a live terminal, waiting on one request. */
async function waitingSession(opts: {
  shared?: boolean;
  command?: string;
  /** The hooks after SessionStart; by default one Bash PermissionRequest. */
  events?: Array<[string, Record<string, unknown>]>;
  liveTerminal?: boolean;
} = {}): Promise<{ id: string; requestId: string }> {
  n += 1;
  const id = `term-ans-${n}`;
  await store.createTerminalSession(id, { host: 'localhost', workingDir: `/tmp/answer-${n}`, command: opts.command ?? 'claude' });
  if (opts.shared !== false) store.setSessionRemoteVisible(id, true);
  if (opts.liveTerminal !== false) pty.terminals.add(id);
  const base = { session_id: id, cwd: `/tmp/answer-${n}`, tty_path: `/dev/ttys6${String(n).padStart(2, '0')}` };
  store.handleEvent({ ...base, hook_event_name: 'SessionStart' } as never);
  const events = opts.events
    ?? [['PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist && npm run build' }, tool_use_id: `toolu_${n}` }]];
  for (const [event, hook] of events) store.handleEvent({ ...base, hook_event_name: event, ...hook } as never);
  const requestId = store.getSession(id)?.pendingRequest?.id;
  if (!requestId) throw new Error('no pending request raised');
  return { id, requestId };
}

async function answer(sessionId: string, requestId: string, body: unknown, headers: Record<string, string> = PHONE) {
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

describe('answering a waiting request', () => {
  it('allow once types 1 into the session’s terminal, clears the request and says so to every device', async () => {
    const { id, requestId } = await waitingSession();
    const res = await answer(id, requestId, { choice: 'allow_once' });
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ success: true, data: { accepted: true } });
    expect(pty.write).toHaveBeenCalledTimes(1);
    expect(pty.write).toHaveBeenCalledWith(id, '1');
    expect(store.getSession(id)?.pendingRequest).toBeNull();
    expect(broadcastSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, pendingRequest: null }));
  });

  it('always allow types 2, deny types Esc', async () => {
    const a = await waitingSession();
    expect((await answer(a.id, a.requestId, { choice: 'allow_always' })).status).toBe(202);
    expect(pty.write).toHaveBeenLastCalledWith(a.id, '2');
    const d = await waitingSession();
    expect((await answer(d.id, d.requestId, { choice: 'deny' })).status).toBe(202);
    expect(pty.write).toHaveBeenLastCalledWith(d.id, '\x1b');
  });

  it('a question’s option types its digit', async () => {
    const { id, requestId } = await waitingSession({
      events: [['PreToolUse', {
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_q',
        tool_input: { questions: [{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] },
      }]],
    });
    expect((await answer(id, requestId, { choice: 'option', optionIndex: 1 })).status).toBe(202);
    expect(pty.write).toHaveBeenCalledWith(id, '2');
  });

  it('writes an audit line with session, request, choice and device, never the input', async () => {
    const info = vi.spyOn(log, 'info');
    try {
      const { id, requestId } = await waitingSession();
      await answer(id, requestId, { choice: 'allow_once' });
      const lines = info.mock.calls.filter(([context]) => context === 'answer').map(([, line]) => String(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(requestId);
      expect(lines[0]).toContain('allow_once');
      expect(lines[0]).toContain('phone-ans');
      expect(lines[0]).not.toContain('rm -rf');
    } finally {
      info.mockRestore();
    }
  });

  it('an unidentified caller on the Mac itself is not arbitrated, like terminal_input', async () => {
    const { id, requestId } = await waitingSession({ shared: false });
    expect((await answer(id, requestId, { choice: 'allow_once' }, LOCAL)).status).toBe(202);
    expect(pty.write).toHaveBeenCalledWith(id, '1');
  });
});

describe('refusals (nothing is typed)', () => {
  it('a second answer to the same request is stale: 409, already answered', async () => {
    const { id, requestId } = await waitingSession();
    expect((await answer(id, requestId, { choice: 'allow_once' })).status).toBe(202);
    const again = await answer(id, requestId, { choice: 'allow_once' });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ success: false, code: 'stale' });
    expect(pty.write).toHaveBeenCalledTimes(1);
  });

  it('an answer to another request than the one waiting is stale', async () => {
    const { id } = await waitingSession();
    const res = await answer(id, 'toolu_not_this_one', { choice: 'allow_once' });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('stale');
    expect(store.getSession(id)?.pendingRequest).not.toBeNull();
  });

  it('a session that waits on nothing is stale too', async () => {
    const { id, requestId } = await waitingSession();
    store.handleEvent({ session_id: id, hook_event_name: 'Stop', cwd: '/tmp', tty_path: '/dev/ttys699' } as never);
    expect((await answer(id, requestId, { choice: 'allow_once' })).json.code).toBe('stale');
  });

  it('a hidden session is 404 for a remote device, the same as an unknown one', async () => {
    const { id, requestId } = await waitingSession({ shared: false });
    const hidden = await answer(id, requestId, { choice: 'allow_once' });
    expect(hidden.status).toBe(404);
    const unknown = await answer('term-no-such-session', requestId, { choice: 'allow_once' });
    expect(unknown.status).toBe(404);
    expect(hidden.json).toEqual(unknown.json);
    expect((await answer('term-no-such-session', requestId, { choice: 'allow_once' }, LOCAL)).status).toBe(404);
  });

  it('423 while another connected device drives the session, naming it', async () => {
    const { id, requestId } = await waitingSession();
    presence.registerClient({ clientId: 'phone-other', label: 'Other phone', address: '192.168.1.71', isLocal: false });
    try {
      expect(presence.claimControl(id, 'phone-other', { label: 'Other phone' }).ok).toBe(true);
      const res = await answer(id, requestId, { choice: 'allow_once' });
      expect(res.status).toBe(423);
      expect(res.json).toMatchObject({ success: false, code: 'control_held', driver: { clientId: 'phone-other', label: 'Other phone' } });
      expect(store.getSession(id)?.pendingRequest?.id).toBe(requestId);
      // The driver itself answers.
      expect((await answer(id, requestId, { choice: 'allow_once' }, OTHER_PHONE)).status).toBe(202);
      expect(pty.write).toHaveBeenCalledTimes(1);
    } finally {
      presence.unregisterClient('phone-other');
    }
  });

  it('the answer takes the free baton, like typing does', async () => {
    const { id, requestId } = await waitingSession();
    expect((await answer(id, requestId, { choice: 'allow_once' })).status).toBe(202);
    expect(presence.getController(id)?.clientId).toBe('phone-ans');
  });

  it('a remote caller with no device id never drives', async () => {
    const { id, requestId } = await waitingSession();
    const res = await answer(id, requestId, { choice: 'allow_once' }, ANON_REMOTE);
    expect(res.status).toBe(423);
    expect(res.json.code).toBe('control_held');
  });

  it('422 unknown_prompt for a plan approval, a guessed wait, Codex and an option a permission lacks', async () => {
    const plan = await waitingSession({ events: [['PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: 'x' }, tool_use_id: 'toolu_plan' }]] });
    const planRes = await answer(plan.id, plan.requestId, { choice: 'allow_once' });
    expect(planRes.status).toBe(422);
    expect(planRes.json).toMatchObject({ success: false, code: 'unknown_prompt' });

    const codex = await waitingSession({ command: 'codex', events: [['PermissionRequest', { cli_source: 'codex', tool_name: 'shell', tool_input: { command: ['ls'] } }]] });
    expect(store.getSession(codex.id)?.pendingRequest?.cli).toBe('codex');
    expect((await answer(codex.id, codex.requestId, { choice: 'allow_once' })).json.code).toBe('unknown_prompt');

    const bash = await waitingSession();
    expect((await answer(bash.id, bash.requestId, { choice: 'option', optionIndex: 0 })).json.code).toBe('unknown_prompt');

    const guess = await waitingSession({
      events: [
        ['UserPromptSubmit', { prompt: 'go' }],
        ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
        ['Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }],
      ],
    });
    expect(store.getSession(guess.id)?.pendingRequest?.source).toBe('notification');
    expect((await answer(guess.id, guess.requestId, { choice: 'allow_once' })).json.code).toBe('unknown_prompt');
    expect(pty.write).not.toHaveBeenCalled();
    expect(store.getSession(plan.id)?.pendingRequest?.id).toBe(plan.requestId);
  });

  it('409 no_terminal when the session’s terminal is gone', async () => {
    const { id, requestId } = await waitingSession({ liveTerminal: false });
    const res = await answer(id, requestId, { choice: 'allow_once' });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('no_terminal');
  });

  it.each([
    [{ choice: 'yes' }],
    [{ choice: 'option' }],
    [{ choice: 'option', optionIndex: -1 }],
    [{ choice: 'option', optionIndex: 1.5 }],
    [{ choice: 'deny', text: 'do this instead' }],
    [{ choice: 'allow_once', keys: '\x1b[A' }],
  ])('400 for a malformed body %j', async (body) => {
    const { id, requestId } = await waitingSession();
    const res = await answer(id, requestId, body);
    expect(res.status).toBe(400);
    expect(res.json.success).toBe(false);
    expect(pty.write).not.toHaveBeenCalled();
  });

  it(`answers at most ${ANSWERS_PER_MINUTE} a minute per device, then 429 until the minute is over`, async () => {
    const { id } = await waitingSession();
    for (let i = 0; i < ANSWERS_PER_MINUTE; i++) {
      expect((await answer(id, 'stale-id', { choice: 'allow_once' })).status).toBe(409);
    }
    const limited = await answer(id, 'stale-id', { choice: 'allow_once' });
    expect(limited.status).toBe(429);
    expect(limited.json).toMatchObject({ success: false, code: 'rate_limited' });
    expect(limited.json.retryAfter).toBeGreaterThan(0);
    // Another device has its own budget.
    expect((await answer(id, 'stale-id', { choice: 'allow_once' }, OTHER_PHONE)).status).toBe(409);
    clock += 60_000;
    expect((await answer(id, 'stale-id', { choice: 'allow_once' })).status).toBe(409);
  });
});

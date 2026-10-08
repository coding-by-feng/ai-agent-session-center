// test/restartTerminal.test.ts — POST /api/sessions/:id/restart-terminal, the terminal toolbar's "Restart session".
//
// A restart is "quit and reconnect with the same session": the agent in this card's terminal is stopped, a fresh
// PTY is opened in the same place and `claude --resume <id>` (same title, model, effort, permission mode) is
// typed into it. The card is never ended, never re-created, never unpinned — so no client may respawn it, and the
// old process's dying hooks must not drag the card back to `ended` after the new terminal took over.
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';

// db.ts opens better-sqlite3 at module scope; stub it so this suite runs under any Node ABI.
vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
  getRecentSessions: vi.fn(() => []),
  getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(),
  default: {},
}));

const mocks = vi.hoisted(() => ({
  findClaudeProcess: vi.fn(),
  terminateProcessTree: vi.fn(),
  closeTerminal: vi.fn(),
  closeTerminalAndWait: vi.fn(),
  createTerminal: vi.fn(),
  writeWhenReady: vi.fn(),
  maybeInjectUltracode: vi.fn(),
  consumePendingLink: vi.fn(),
  getTerminals: vi.fn(),
  getTerminalRelaunchSettings: vi.fn(),
  injectClaudeCommandsWhenReady: vi.fn(),
  isTmuxBackedTerminal: vi.fn(),
  broadcast: vi.fn(),
}));

// NEVER let this file reach a real process. `findClaudeProcess` falls back to "the first unclaimed
// `claude` process that has a terminal", i.e. one of the developer's live sessions, and the kill route
// then SIGTERMs/SIGKILLs it. An earlier version of the lock test below sent a real POST /kill and
// killed live Claude Code sessions. Both lookups are mocked, and process.kill is guarded further down.
vi.mock('../server/sessionStore.js', async () => {
  const actual = await vi.importActual<typeof import('../server/sessionStore.js')>('../server/sessionStore.js');
  return { ...actual, findClaudeProcess: mocks.findClaudeProcess };
});
vi.mock('../server/processMonitor.js', async () => {
  const actual = await vi.importActual<typeof import('../server/processMonitor.js')>('../server/processMonitor.js');
  return { ...actual, terminateProcessTree: mocks.terminateProcessTree };
});
vi.mock('../server/sshManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/sshManager.js')>('../server/sshManager.js');
  return {
    ...actual,
    closeTerminal: mocks.closeTerminal,
    closeTerminalAndWait: mocks.closeTerminalAndWait,
    createTerminal: mocks.createTerminal,
    writeWhenReady: mocks.writeWhenReady,
    maybeInjectUltracode: mocks.maybeInjectUltracode,
    consumePendingLink: mocks.consumePendingLink,
    getTerminals: mocks.getTerminals,
    getTerminalRelaunchSettings: mocks.getTerminalRelaunchSettings,
    injectClaudeCommandsWhenReady: mocks.injectClaudeCommandsWhenReady,
    isTmuxBackedTerminal: mocks.isTmuxBackedTerminal,
  };
});
vi.mock('../server/wsManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/wsManager.js')>('../server/wsManager.js');
  return { ...actual, broadcast: mocks.broadcast };
});

import express from 'express';
import { createServer, type Server } from 'http';
import { EVENT_TYPES } from '../server/constants.js';

// Second line of defence: any real signal other than the liveness probe (signal 0) fails the test loudly
// instead of reaching a process. Restored in afterAll.
const realProcessKill = process.kill.bind(process);
const killGuard = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`restartTerminal.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

// One fresh set of ids per test: the store is module state, and a restarted card must not leak into the next case.
let n = 0;
let UUID = '';
let OLD_TERMINAL = '';
let NEW_TERMINAL = '';
// A pending resume left by an earlier case would otherwise claim this case's SessionStart by directory.
let DIR = '';

let server: Server | null = null;
let baseUrl = '';
let store: typeof import('../server/sessionStore.js');

beforeAll(async () => {
  store = await import('../server/sessionStore.js');
  const app = express();
  app.set('trust proxy', true); // lets a test present as a remote device with X-Forwarded-For
  app.use(express.json());
  const { default: apiRouter } = await import('../server/apiRouter.js');
  app.use('/api', apiRouter);
  server = createServer(app);
  await new Promise<void>((resolveStart) => server!.listen(0, '127.0.0.1', resolveStart));
  const addr = server!.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  killGuard.mockRestore();
  if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
});

beforeEach(() => {
  n += 1;
  UUID = `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`;
  OLD_TERMINAL = `term-restart-old-${n}`;
  NEW_TERMINAL = `term-restart-new-${n}`;
  DIR = `/tmp/restart-test-${n}`;
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.findClaudeProcess.mockReturnValue(null);          // no process is ever "found": nothing real can be signalled
  mocks.terminateProcessTree.mockResolvedValue(true);
  mocks.closeTerminalAndWait.mockResolvedValue(true);
  mocks.createTerminal.mockResolvedValue(NEW_TERMINAL);
  mocks.getTerminals.mockReturnValue([{ terminalId: OLD_TERMINAL, isOps: false }]);
  mocks.isTmuxBackedTerminal.mockReturnValue(false);
  mocks.getTerminalRelaunchSettings.mockReturnValue({});
});

/** A running Claude session the way the app builds one: a term-* placeholder re-keyed onto the CLI's UUID. */
async function liveSession(overrides: { pinned?: boolean; effort?: string; launchDir?: string; isFork?: boolean; remote?: { workingDir: string; authMethod?: 'key' | 'password' } } = {}): Promise<void> {
  await store.createTerminalSession(OLD_TERMINAL, {
    host: overrides.remote ? 'build.example.com' : 'localhost',
    ...(overrides.remote ? { username: 'dev', authMethod: overrides.remote.authMethod ?? 'key' } : {}),
    workingDir: overrides.remote?.workingDir ?? overrides.launchDir ?? DIR,
    command: 'claude',
    ...(overrides.isFork ? { isFork: true, originSessionId: 'origin-session' } : {}),
    sessionTitle: 'Release notes',
    effortLevel: overrides.effort ?? 'high',
    model: 'opus',
    pinned: overrides.pinned,
  });
  store.handleEvent({
    session_id: UUID,
    hook_event_name: EVENT_TYPES.SESSION_START,
    agent_terminal_id: OLD_TERMINAL,
    cwd: DIR,
    claude_pid: 777001,
    startup_command: 'claude',
  } as never);
  store.handleEvent({
    session_id: UUID,
    hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT,
    agent_terminal_id: OLD_TERMINAL,
    prompt: 'write them',
    prompt_id: 'p1',
  } as never);
  expect(store.getSession(UUID)?.terminalId).toBe(OLD_TERMINAL);
}

/** `body === null` sends no body at all (an `undefined` argument would take the default). */
async function restart(id: string, body: unknown = { confirm: true }, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/sessions/${id}/restart-terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === null ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** Another route, same JSON conventions as the app's own calls. */
async function call(method: string, path: string, body: unknown = { confirm: true }): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const sessionUpdates = () => mocks.broadcast.mock.calls
  .map(([msg]) => msg)
  .filter((msg) => msg?.type === 'session_update' && msg.session?.sessionId === UUID);

describe('safety of this test file', () => {
  it('cannot signal a real process: the guard throws before anything is sent', () => {
    expect(() => process.kill(process.pid, 'SIGTERM')).toThrow(/never signal a real process/);
    expect(() => process.kill(process.pid)).toThrow(/never signal a real process/);
    expect(() => process.kill(process.pid, 0)).not.toThrow(); // the liveness probe stays allowed
  });
});

describe('POST /api/sessions/:id/restart-terminal — refusals', () => {
  it('404s an unknown session without touching any terminal', async () => {
    const { status } = await restart('no-such-session');
    expect(status).toBe(404);
    expect(mocks.closeTerminalAndWait).not.toHaveBeenCalled();
  });

  it('400s an id that is not shell-safe', async () => {
    const { status } = await restart('%24%28whoami%29');
    expect(status).toBe(400);
    expect(mocks.closeTerminalAndWait).not.toHaveBeenCalled();
  });

  it('409s when the card has no live dashboard terminal (that is what RECONNECT is for)', async () => {
    await liveSession();
    mocks.getTerminals.mockReturnValue([]);
    const { status, json } = await restart(UUID);
    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/terminal/i);
    expect(mocks.closeTerminalAndWait).not.toHaveBeenCalled();
    expect(store.getSession(UUID)?.terminalId).toBe(OLD_TERMINAL);
  });

  it('409s a tmux-backed terminal, whose agent would outlive the PTY it is attached through', async () => {
    await liveSession();
    mocks.isTmuxBackedTerminal.mockReturnValue(true);
    const { status, json } = await restart(UUID);
    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/tmux/i);
    expect(mocks.closeTerminalAndWait).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/:id/restart-terminal — hardening', () => {
  it('needs the explicit JSON confirm, like /kill: a body-less POST is a no-preflight cross-site request', async () => {
    await liveSession();
    expect((await restart(UUID, null)).status).toBe(400);
    expect((await restart(UUID, {})).status).toBe(400);
    expect((await restart(UUID, { confirm: false })).status).toBe(400);
    expect(mocks.closeTerminalAndWait).not.toHaveBeenCalled();
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });

  it('404s a remote device that cannot see the session, and touches nothing', async () => {
    await liveSession(); // not shared with remote devices
    const { status } = await restart(UUID, { confirm: true }, { 'X-Forwarded-For': '203.0.113.9' });
    expect(status).toBe(404);
    expect(mocks.closeTerminalAndWait).not.toHaveBeenCalled();
    expect(store.getSession(UUID)?.terminalId).toBe(OLD_TERMINAL);
  });

  it('refuses a terminal another live card is also using, because closing it stops that card too', async () => {
    await liveSession();
    const otherTerminal = `${OLD_TERMINAL}-other`;
    await store.createTerminalSession(otherTerminal, { host: 'localhost', workingDir: `${DIR}-b`, command: 'claude' });
    store.linkTerminalToSession(otherTerminal, OLD_TERMINAL); // a second live card pointing at the same PTY
    expect(store.getSession(otherTerminal)?.terminalId).toBe(OLD_TERMINAL);

    const { status, json } = await restart(UUID);

    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/shared with another live session/i);
    expect(mocks.closeTerminalAndWait).not.toHaveBeenCalled();
  });

  it('opens the replacement terminal BEFORE stopping anything, so a spawn failure leaves the agent running', async () => {
    await liveSession({ pinned: true });
    mocks.createTerminal.mockRejectedValue(new Error('Invalid working directory'));

    const { status, json } = await restart(UUID);

    expect(status).toBe(500);
    expect(String(json.error)).toMatch(/left untouched/i);
    expect(mocks.closeTerminalAndWait).not.toHaveBeenCalled();
    expect(mocks.writeWhenReady).not.toHaveBeenCalled();
    const after = store.getSession(UUID);
    expect(after).toMatchObject({ terminalId: OLD_TERMINAL, pinned: true });
    expect(after?.status).not.toBe('ended');
    // and the old agent's hooks still reach the card
    expect(store.handleEvent({ session_id: UUID, hook_event_name: EVENT_TYPES.PRE_TOOL_USE, agent_terminal_id: OLD_TERMINAL, tool_name: 'Bash' } as never)).not.toBeNull();
  });

  it('does not touch another terminal\'s pending link: it names its own terminal when consuming', async () => {
    await liveSession();
    await restart(UUID);
    expect(mocks.consumePendingLink).toHaveBeenCalledWith(DIR, NEW_TERMINAL);
  });

  it('closes the replacement terminal when the old agent cannot be stopped, instead of leaking it', async () => {
    await liveSession();
    mocks.closeTerminalAndWait.mockResolvedValue(false);
    await restart(UUID);
    expect(mocks.closeTerminal).toHaveBeenCalledWith(NEW_TERMINAL);
  });

  it('turns kill, resume, reconnect and delete away with 409 while a restart is running', async () => {
    await liveSession();
    let confirmDead: (dead: boolean) => void = () => {};
    mocks.closeTerminalAndWait.mockReturnValue(new Promise<boolean>((r) => { confirmDead = r; }));

    const running = restart(UUID);
    await new Promise((r) => setTimeout(r, 30));

    for (const [method, path] of [
      ['POST', `/sessions/${UUID}/kill`],
      ['POST', `/sessions/${UUID}/resume`],
      ['POST', `/sessions/${UUID}/reconnect-terminal`],
      ['DELETE', `/sessions/${UUID}`],
    ] as const) {
      const r = await call(method, path);
      expect([method, path, r.status]).toEqual([method, path, 409]);
      expect(String(r.json.error)).toMatch(/restarting/i);
    }
    expect(store.getSession(UUID)).toBeTruthy(); // the delete did not remove it

    confirmDead(true);
    expect((await running).status).toBe(200);
    // once it is over the card is an ordinary card again (through the mocked process lookup: nothing real is signalled)
    expect((await call('POST', `/sessions/${UUID}/kill`)).status).not.toBe(409);
    expect(mocks.findClaudeProcess).toHaveBeenCalled();
    expect(mocks.terminateProcessTree).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/:id/restart-terminal — what a restart must not get wrong', () => {
  it('refuses a fork card: its agent reports under the ORIGIN\'s session id, so a restart could neither silence it nor resume it', async () => {
    await liveSession({ isFork: true });
    const { status, json } = await restart(UUID);
    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/fork/i);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(mocks.closeTerminalAndWait).not.toHaveBeenCalled();
  });

  it('refuses a Claude card that has not reported a real session id: "same session" would silently start a blank one', async () => {
    await store.createTerminalSession(OLD_TERMINAL, { host: 'localhost', workingDir: DIR, command: 'claude' }); // never got its first hook
    const { status, json } = await restart(OLD_TERMINAL);
    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/session id/i);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(mocks.closeTerminalAndWait).not.toHaveBeenCalled();
  });

  it('relaunches where the agent REALLY runs: the hook-corrected project path, not the launch directory', async () => {
    await liveSession({ launchDir: `${DIR}-launch` });
    expect(store.getSession(UUID)?.projectPath).toBe(DIR); // the card's cwd, corrected by the first hook
    await restart(UUID);
    expect(mocks.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ workingDir: DIR, command: '' }), null);
  });

  it('carries the launch-only settings over: the API-key override and the Remote Control link', async () => {
    await liveSession({ effort: 'ultracode' });
    mocks.getTerminalRelaunchSettings.mockReturnValue({ apiKey: 'test-api-key-override', remoteControlName: 'my-link' });

    await restart(UUID);

    expect(mocks.getTerminalRelaunchSettings).toHaveBeenCalledWith(OLD_TERMINAL);
    expect(mocks.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-api-key-override' }), null);
    // ONE injector for both slash commands, so they cannot interleave
    expect(mocks.injectClaudeCommandsWhenReady).toHaveBeenCalledTimes(1);
    expect(mocks.injectClaudeCommandsWhenReady).toHaveBeenCalledWith(NEW_TERMINAL, ['/effort ultracode', '/remote-control my-link']);
    expect(mocks.maybeInjectUltracode).not.toHaveBeenCalled();
  });

  it('does not archive the run into "previous sessions": --resume keeps the same session and its prompts', async () => {
    await liveSession();
    await restart(UUID);
    await restart(UUID).catch(() => undefined);
    expect(store.getSession(UUID)?.previousSessions ?? []).toHaveLength(0);
  });

  it('a hook update still waiting out its throttle does not go out after the restart and undo it', async () => {
    const { processHookEvent } = await import('../server/hookProcessor.js');
    await liveSession();
    processHookEvent({ session_id: UUID, hook_event_name: EVENT_TYPES.POST_TOOL_USE, agent_terminal_id: OLD_TERMINAL, tool_name: 'Bash' } as never, 'http');
    expect(store.getSession(UUID)?.status).toBe('working'); // its broadcast is now held for 250 ms

    await restart(UUID);
    await new Promise((r) => setTimeout(r, 400));

    const last = sessionUpdates().at(-1);
    expect(last?.session.terminalId).toBe(NEW_TERMINAL);
    expect(last?.session.status).toBe('connecting');
  });
});

describe('POST /api/sessions/:id/restart-terminal — a kill racing the restart', () => {
  it('does not resurrect a card whose kill finished while the restart was waiting for the old agent', async () => {
    await liveSession();
    mocks.closeTerminalAndWait.mockImplementation(async () => { store.killSession(UUID); return true; });

    const { status, json } = await restart(UUID);

    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/closed while it was restarting/i);
    expect(mocks.writeWhenReady).not.toHaveBeenCalled();
    expect(mocks.closeTerminal).toHaveBeenCalledWith(NEW_TERMINAL); // the replacement is not left open
    expect(store.getSession(UUID)?.status).toBe('ended');
  });

  it('refuses to start while a kill of the same card is still in flight', async () => {
    await liveSession();
    let finishKill: (dead: boolean) => void = () => {};
    mocks.findClaudeProcess.mockReturnValue(4242); // a mocked pid: nothing real is signalled
    mocks.terminateProcessTree.mockReturnValue(new Promise<boolean>((r) => { finishKill = r; }));

    const kill = call('POST', `/sessions/${UUID}/kill`);
    await new Promise((r) => setTimeout(r, 30));
    const refused = await restart(UUID);
    expect(refused.status).toBe(409);
    expect(String(refused.json.error)).toMatch(/being closed/i);
    expect(mocks.createTerminal).not.toHaveBeenCalled();

    finishKill(true);
    expect((await kill).status).toBe(200);
  });
});

describe('POST /api/sessions/:id/restart-terminal — remote (SSH) cards', () => {
  const typedLine = () => (mocks.writeWhenReady.mock.calls[0] as [string, string])[1];

  it('re-exports the terminal id and changes directory first, with `~` left outside the quotes', async () => {
    await liveSession({ remote: { workingDir: '~/my proj' } });
    expect((await restart(UUID)).status).toBe(200);
    expect(mocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'build.example.com', username: 'dev', workingDir: '~/my proj', command: '' }),
      null,
    );
    expect(typedLine().startsWith(`export AGENT_MANAGER_TERMINAL_ID='${NEW_TERMINAL}' && cd ~/'my proj' && claude`)).toBe(true);
  });

  it.each([
    ['~', 'cd ~ && '],
    ['/srv/app', "cd '/srv/app' && "],
    ["/srv/it's", "cd '/srv/it'\\''s' && "],
  ])('types `cd` for %s so the shell can actually enter it', async (workingDir, expected) => {
    await liveSession({ remote: { workingDir } });
    expect((await restart(UUID)).status).toBe(200);
    expect(typedLine()).toContain(expected);
  });

  it('refuses a password-authenticated SSH card BEFORE stopping anything: the password is not stored', async () => {
    await liveSession({ remote: { workingDir: '~/proj', authMethod: 'password' } });
    const { status, json } = await restart(UUID);
    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/password/i);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(mocks.closeTerminalAndWait).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/:id/restart-terminal — a restart', () => {
  it('stops the agent, opens a fresh terminal in the same place and resumes the same session', async () => {
    await liveSession();
    const { status, json } = await restart(UUID);

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, terminalId: NEW_TERMINAL });

    // The replacement opens first (a failure costs nothing); the old agent is confirmed dead
    // BEFORE the resume line is typed, so two agents never share a transcript.
    expect(mocks.closeTerminalAndWait).toHaveBeenCalledWith(OLD_TERMINAL);
    expect(mocks.createTerminal.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.closeTerminalAndWait.mock.invocationCallOrder[0]);
    expect(mocks.closeTerminalAndWait.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.writeWhenReady.mock.invocationCallOrder[0]);

    // Fresh PTY in the same directory; the launch command is typed later, once the shell is ready.
    expect(mocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'localhost', workingDir: DIR, command: '' }),
      null,
    );
    expect(mocks.consumePendingLink).toHaveBeenCalledWith(DIR, NEW_TERMINAL);

    const [typedInto, typed] = mocks.writeWhenReady.mock.calls[0] as [string, string];
    expect(typedInto).toBe(NEW_TERMINAL);
    expect(typed).toContain(`--resume '${UUID}'`);
    expect(typed).toContain('--effort high');
    expect(typed).toContain('--model opus');
    expect(typed).toContain('Release notes');
    expect(typed.endsWith('\r')).toBe(true);
    expect(mocks.maybeInjectUltracode).toHaveBeenCalledWith(NEW_TERMINAL, 'high', typed.replace(/\r$/, ''));
  });

  it('does not type into the new terminal or re-link the card until the old agent is confirmed dead', async () => {
    await liveSession();
    let confirmDead: (dead: boolean) => void = () => {};
    mocks.closeTerminalAndWait.mockReturnValue(new Promise<boolean>((r) => { confirmDead = r; }));

    const pending = restart(UUID);
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.closeTerminalAndWait).toHaveBeenCalledTimes(1);
    expect(mocks.writeWhenReady).not.toHaveBeenCalled();
    expect(store.getSession(UUID)?.terminalId).toBe(OLD_TERMINAL);

    confirmDead(true);
    expect((await pending).status).toBe(200);
    expect(mocks.writeWhenReady).toHaveBeenCalledTimes(1);
    expect(store.getSession(UUID)?.terminalId).toBe(NEW_TERMINAL);
  });

  it('refuses a second restart of the same card while one is still running', async () => {
    await liveSession();
    let confirmDead: (dead: boolean) => void = () => {};
    mocks.closeTerminalAndWait.mockReturnValue(new Promise<boolean>((r) => { confirmDead = r; }));

    const first = restart(UUID);
    await new Promise((r) => setTimeout(r, 30));
    const second = await restart(UUID);
    expect(second.status).toBe(409);
    expect(String(second.json.error)).toMatch(/already restarting/i);

    confirmDead(true);
    expect((await first).status).toBe(200);
    expect(mocks.closeTerminalAndWait).toHaveBeenCalledTimes(1);
  });

  it('keeps the same card: same id, title and pin, linked to the new terminal and connecting', async () => {
    await liveSession({ pinned: true });
    await restart(UUID);

    const after = store.getSession(UUID);
    expect(after).toMatchObject({
      sessionId: UUID,
      terminalId: NEW_TERMINAL,
      lastTerminalId: NEW_TERMINAL,
      status: 'connecting',
      title: 'Release notes',
      pinned: true,
    });
    expect(after?.cachedPid).toBeNull(); // the old process's pid must not stay mapped to the card
  });

  it('never broadcasts the card as ended, so no client\'s pinnedRespawn has anything to relaunch', async () => {
    await liveSession({ pinned: true });
    await restart(UUID);

    const updates = sessionUpdates();
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((u) => u.session.status !== 'ended')).toBe(true);
    expect(updates.every((u) => u.session.pinned === true)).toBe(true);
    expect(updates.at(-1)?.session.terminalId).toBe(NEW_TERMINAL);
  });

  it('re-applies ultracode the way every other relaunch path does', async () => {
    await liveSession({ effort: 'ultracode' });
    await restart(UUID);
    expect(mocks.maybeInjectUltracode.mock.calls[0]?.[1]).toBe('ultracode');
  });

});

describe('POST /api/sessions/:id/restart-terminal — the old process\'s dying hooks', () => {
  it('ignores a SessionEnd that carries the closed terminal\'s id, in any order relative to the new terminal', async () => {
    await liveSession();
    await restart(UUID);

    const ended = store.handleEvent({
      session_id: UUID,
      hook_event_name: EVENT_TYPES.SESSION_END,
      agent_terminal_id: OLD_TERMINAL,
      reason: 'other',
    } as never);

    expect(ended).toBeNull();
    expect(store.getSession(UUID)?.status).toBe('connecting');
    expect(store.getSession(UUID)?.terminalId).toBe(NEW_TERMINAL);
  });

  it('does not let a late event from the old process re-cache its pid on the card', async () => {
    await liveSession();
    await restart(UUID);
    store.handleEvent({
      session_id: UUID,
      hook_event_name: EVENT_TYPES.POST_TOOL_USE,
      agent_terminal_id: OLD_TERMINAL,
      claude_pid: 777001,
      tool_name: 'Bash',
    } as never);
    expect(store.getSession(UUID)?.cachedPid).toBeNull();
  });

  it('keeps delivering events from OTHER sessions that report under the old terminal id (a teammate outside the PTY)', async () => {
    await liveSession();
    // a teammate card of its own, which inherited the restarted terminal's id in its environment
    const mateTerminal = `${OLD_TERMINAL}-mate`;
    const mateId = `${UUID}-mate`;
    await store.createTerminalSession(mateTerminal, { host: 'localhost', workingDir: `${DIR}-mate`, command: 'claude' });
    store.handleEvent({ session_id: mateId, hook_event_name: EVENT_TYPES.SESSION_START, agent_terminal_id: mateTerminal, cwd: `${DIR}-mate` } as never);
    expect(store.getSession(mateId)).toBeTruthy();

    await restart(UUID);

    const delivered = store.handleEvent({
      session_id: mateId,
      hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
      agent_terminal_id: OLD_TERMINAL,
      tool_name: 'Bash',
    } as never);
    expect(delivered).not.toBeNull();
    expect(store.getSession(mateId)?.status).toBe('working');
    expect(store.getSession(UUID)?.status).toBe('connecting'); // the restarted card is untouched
  });

  it('stops muting the old terminal after two minutes (a terminal id is never reused, so nothing else can be hidden by it)', async () => {
    await liveSession();
    await restart(UUID);
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(realNow + 119_000);
      expect(store.handleEvent({ session_id: UUID, hook_event_name: EVENT_TYPES.NOTIFICATION, agent_terminal_id: OLD_TERMINAL } as never)).toBeNull();
      clock.mockReturnValue(realNow + 121_000);
      expect(store.handleEvent({ session_id: UUID, hook_event_name: EVENT_TYPES.NOTIFICATION, agent_terminal_id: OLD_TERMINAL } as never)).not.toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it('still lets the NEW terminal\'s process drive the card', async () => {
    await liveSession();
    await restart(UUID);

    store.handleEvent({
      session_id: UUID,
      hook_event_name: EVENT_TYPES.SESSION_START,
      agent_terminal_id: NEW_TERMINAL,
      cwd: DIR,
    } as never);
    expect(store.getSession(UUID)?.status).toBe('idle');

    store.handleEvent({
      session_id: UUID,
      hook_event_name: EVENT_TYPES.SESSION_END,
      agent_terminal_id: NEW_TERMINAL,
      reason: 'other',
    } as never);
    expect(store.getSession(UUID)?.status).toBe('ended');
  });
});

describe('POST /api/sessions/:id/restart-terminal — failures leave a card the user can act on', () => {
  it('leaves a card that was DELETED while the old agent was stopping deleted: 409, replacement closed, nothing typed', async () => {
    await liveSession({ pinned: true });
    mocks.closeTerminalAndWait.mockImplementation(async () => { store.deleteSessionFromMemory(UUID); return true; });

    const { status } = await restart(UUID);

    expect(status).toBe(409);
    expect(mocks.writeWhenReady).not.toHaveBeenCalled();
    expect(mocks.closeTerminal).toHaveBeenCalledWith(NEW_TERMINAL);
    expect(store.getSession(UUID)).toBeFalsy();
  });

  it('500s and never types a second agent when the old one survived SIGKILL', async () => {
    await liveSession();
    mocks.closeTerminalAndWait.mockResolvedValue(false);

    const { status, json } = await restart(UUID);

    expect(status).toBe(500);
    expect(String(json.error)).toMatch(/could not be stopped|still running/i);
    expect(mocks.writeWhenReady).not.toHaveBeenCalled();
    expect(mocks.closeTerminal).toHaveBeenCalledWith(NEW_TERMINAL); // the replacement is not left open
    expect(store.getSession(UUID)?.status).toBe('ended');
  });

  it('unpins a pinned card whose agent outlived SIGKILL, so no client relaunches a second agent beside the survivor', async () => {
    await liveSession({ pinned: true });
    mocks.closeTerminalAndWait.mockResolvedValue(false);

    await restart(UUID);

    expect(store.getSession(UUID)).toMatchObject({ status: 'ended', pinned: false });
    expect(sessionUpdates().at(-1)?.session.pinned).toBe(false);
  });

  it('a failed restart does not leave the old terminal\'s hooks muted forever', async () => {
    await liveSession();
    mocks.closeTerminalAndWait.mockResolvedValue(false);
    await restart(UUID);

    // The process that survived is still the card's agent: its hooks must reach the card again.
    const handled = store.handleEvent({
      session_id: UUID,
      hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
      agent_terminal_id: OLD_TERMINAL,
      tool_name: 'Bash',
    } as never);
    expect(handled).not.toBeNull();
  });
});

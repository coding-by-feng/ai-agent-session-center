// test/killRouteCentral.test.ts — POST /api/sessions/:id/kill from a central (an `mcp:` caller, Ruling P5-33): a central's
// kill NEVER signals a pid. It ends the session only by closing the card's own managed terminal and waiting for what ran
// in it (`closeTerminalAndWait`: the login shell's direct children, an AASC-owned tree). With no terminal, one AASC no
// longer runs, a tmux-backed one (closing it would only detach) or one another live card shares, it answers 409
// `no_safe_target` before anything changes; when the terminal is not the one the central was allowed to end
// (`expectTerminalId`) it answers 409 `changed`. A survivor is 500 and the card stays as it was. `findClaudeProcess`
// (pgrep's "first unclaimed claude process", which killed eight live sessions on Oct 8) and `terminateProcessTree` are
// never called for a central, whatever `cachedPid` the card carries. A person's kill is unchanged, and a central's kill
// of a pinned card unpins it before anything is closed, as a person's does (killPinnedSession.test.ts).
//
// NOTHING here may reach a real process: `findClaudeProcess`, `terminateProcessTree`, `closeTerminal` and
// `closeTerminalAndWait` are mocks, and `process.kill` throws on any signal but 0 (the liveness probe).
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';
import type { Session } from '../src/types/session.js';

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
  isTmuxBackedTerminal: vi.fn(),
  broadcast: vi.fn(),
  /** What the route's `getSession` reads on top of the store's card, per session id (a cached pid, no terminal). */
  overrides: new Map<string, Record<string, unknown>>(),
  /** Cards the route's `getAllSessions` lists besides the store's (one sharing another's terminal). */
  extraSessions: new Map<string, Record<string, unknown>>(),
  /** Terminals the fake sshManager says it runs, on top of the real (empty) list. */
  liveTerminals: new Set<string>(),
}));

vi.mock('../server/sessionStore.js', async () => {
  const actual = await vi.importActual<typeof import('../server/sessionStore.js')>('../server/sessionStore.js');
  return {
    ...actual,
    findClaudeProcess: mocks.findClaudeProcess,
    getSession: (id: string) => {
      const s = actual.getSession(id);
      const over = s === null ? undefined : mocks.overrides.get(s.sessionId);
      return s === null || over === undefined ? s : { ...s, ...over };
    },
    getAllSessions: () => ({ ...actual.getAllSessions(), ...Object.fromEntries(mocks.extraSessions) }),
  };
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
    isTmuxBackedTerminal: mocks.isTmuxBackedTerminal,
    getTerminals: () => [
      ...actual.getTerminals(),
      ...[...mocks.liveTerminals].map((terminalId) => ({ terminalId }) as ReturnType<typeof actual.getTerminals>[number]),
    ],
  };
});
vi.mock('../server/wsManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/wsManager.js')>('../server/wsManager.js');
  return { ...actual, broadcast: mocks.broadcast };
});

import express from 'express';
import { createServer, type Server } from 'http';

// Second line of defence: any real signal other than the liveness probe (signal 0) fails the test loudly instead of
// reaching a process. Restored in afterAll.
const realProcessKill = process.kill.bind(process);
const killGuard = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`killRouteCentral.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

const CENTRAL = 'mcp:central-1';
/** A pid no test machine hands out (above the macOS and Linux pid limits), so even a probe reaches nothing. */
const CACHED_PID = 99_999_901;

let server: Server | null = null;
let baseUrl = '';
let store: typeof import('../server/sessionStore.js');

beforeAll(async () => {
  store = await import('../server/sessionStore.js');
  const app = express();
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
  mocks.findClaudeProcess.mockReset();
  mocks.terminateProcessTree.mockReset();
  mocks.closeTerminal.mockReset();
  mocks.closeTerminalAndWait.mockReset();
  mocks.isTmuxBackedTerminal.mockReset();
  mocks.broadcast.mockReset();
  mocks.overrides.clear();
  mocks.extraSessions.clear();
  mocks.liveTerminals.clear();
  mocks.findClaudeProcess.mockReturnValue(null); // nothing is ever "found": nothing real can be signalled
  mocks.terminateProcessTree.mockResolvedValue(true);
  mocks.closeTerminalAndWait.mockResolvedValue(true);
  mocks.isTmuxBackedTerminal.mockReturnValue(false);
});

/** A card in its own live terminal (the terminal id is the card's id), with what the route reads on top of it. */
async function card(id: string, over: Record<string, unknown> = {}, pinned = false): Promise<void> {
  await store.createTerminalSession(id, { host: 'localhost', workingDir: `/tmp/kill-central-${id}`, command: 'claude' });
  mocks.liveTerminals.add(id);
  if (pinned) store.setSessionPinned(id, true);
  if (Object.keys(over).length > 0) mocks.overrides.set(id, over);
  mocks.broadcast.mockClear(); // only what the kill broadcasts is looked at
}

async function kill(
  id: string,
  clientId?: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/sessions/${id}/kill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(clientId ? { 'x-aasc-client-id': clientId } : {}) },
    body: JSON.stringify({ confirm: true, ...extra }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Nothing that signals a process was asked, no terminal was closed, and nothing was broadcast. */
function expectNothingEnded(): void {
  expect(mocks.findClaudeProcess).not.toHaveBeenCalled();
  expect(mocks.terminateProcessTree).not.toHaveBeenCalled();
  expect(mocks.closeTerminal).not.toHaveBeenCalled();
  expect(mocks.closeTerminalAndWait).not.toHaveBeenCalled();
  expect(mocks.broadcast).not.toHaveBeenCalled();
}

describe('POST /api/sessions/:id/kill from a central (P5-33)', () => {
  it('the guard throws on any real signal but the liveness probe', () => {
    expect(() => process.kill(CACHED_PID, 'SIGTERM')).toThrow(/must never signal a real process/);
    expect(() => process.kill(CACHED_PID, 'SIGKILL')).toThrow(/must never signal a real process/);
  });

  it('a central’s kill signals no pid, even a cached one: it only closes the card’s own terminal and waits', async () => {
    await card('kc-cached', { cachedPid: CACHED_PID });
    mocks.findClaudeProcess.mockReturnValue(4242);

    const { status, json } = await kill('kc-cached', CENTRAL);

    expect(status).toBe(200);
    expect(mocks.findClaudeProcess).not.toHaveBeenCalled();
    expect(mocks.terminateProcessTree).not.toHaveBeenCalled();
    expect(mocks.closeTerminalAndWait).toHaveBeenCalledTimes(1);
    expect(mocks.closeTerminalAndWait).toHaveBeenCalledWith('kc-cached');
    // killSession closes it again (a no-op on a closed terminal): that one terminal only.
    expect(new Set(mocks.closeTerminal.mock.calls.map(([id]) => id))).toEqual(new Set(['kc-cached']));
    expect(json.killedPid).toBeNull();
    expect(json.pid).toBeNull();
    expect(json.terminalId).toBe('kc-cached');
    expect(store.getSession('kc-cached')?.status).toBe('ended');
  });

  it('a card with a cached pid and no terminal is 409 no_safe_target, unchanged and still pinned', async () => {
    await card('kc-pid-only', { cachedPid: CACHED_PID, terminalId: null }, true);

    const { status, json } = await kill('kc-pid-only', CENTRAL);

    expect(status).toBe(409);
    expect(json.error).toBe('no_safe_target');
    expectNothingEnded();
    const after = store.getSession('kc-pid-only');
    expect(after?.status).not.toBe('ended');
    expect(after?.pinned).toBe(true);
  });

  it('no cached pid and no terminal is 409 no_safe_target, and nothing changes', async () => {
    await card('kc-none', { terminalId: null }, true);
    mocks.findClaudeProcess.mockReturnValue(4242);

    const { status, json } = await kill('kc-none', CENTRAL);

    expect(status).toBe(409);
    expect(json.error).toBe('no_safe_target');
    expectNothingEnded();
    const after = store.getSession('kc-none');
    expect(after?.status).not.toBe('ended');
    expect(after?.pinned).toBe(true);
  });

  it('a terminal AASC no longer runs, a tmux-backed one, or one another live card shares is 409 no_safe_target', async () => {
    await card('kc-gone', { cachedPid: CACHED_PID }, true);
    mocks.liveTerminals.delete('kc-gone');
    await card('kc-tmux', {}, true);
    mocks.isTmuxBackedTerminal.mockImplementation((id: string) => id === 'kc-tmux');
    await card('kc-shared', {}, true);
    mocks.extraSessions.set('kc-sharer', { sessionId: 'kc-sharer', status: 'idle', terminalId: 'kc-shared' } as Partial<Session>);

    for (const id of ['kc-gone', 'kc-tmux', 'kc-shared']) {
      const { status, json } = await kill(id, CENTRAL);
      expect(status, id).toBe(409);
      expect(json.error, id).toBe('no_safe_target');
      expect(store.getSession(id)?.status, id).not.toBe('ended');
      expect(store.getSession(id)?.pinned, id).toBe(true);
    }
    expectNothingEnded();
  });

  it('a sharer that has ended does not stop the kill', async () => {
    await card('kc-shared-ended');
    mocks.extraSessions.set('kc-old', { sessionId: 'kc-old', status: 'ended', terminalId: 'kc-shared-ended' } as Partial<Session>);

    expect((await kill('kc-shared-ended', CENTRAL)).status).toBe(200);
    expect(mocks.closeTerminalAndWait).toHaveBeenCalledWith('kc-shared-ended');
  });

  it('a terminal other than the one the central was allowed to end is 409 changed, and nothing changes', async () => {
    await card('kc-moved', {}, true);

    const { status, json } = await kill('kc-moved', CENTRAL, { expectTerminalId: 'term-before' });

    expect(status).toBe(409);
    expect(json.error).toBe('changed');
    expectNothingEnded();
    expect(store.getSession('kc-moved')?.pinned).toBe(true);

    expect((await kill('kc-moved', CENTRAL, { expectTerminalId: 'kc-moved' })).status).toBe(200);
  });

  it('a central’s kill of a pinned card unpins it before the terminal closes', async () => {
    await card('kc-pinned', { cachedPid: CACHED_PID }, true);
    let pinnedWhenCloseStarted: boolean | undefined;
    mocks.closeTerminalAndWait.mockImplementation(async () => {
      pinnedWhenCloseStarted = store.getSession('kc-pinned')?.pinned;
      return true;
    });

    const { status } = await kill('kc-pinned', CENTRAL);

    expect(status).toBe(200);
    expect(pinnedWhenCloseStarted).toBe(false);
    expect(store.getSession('kc-pinned')?.pinned).toBe(false);
  });

  it('a central’s kill whose terminal’s process survives is 500, names no pid, and leaves the card', async () => {
    await card('kc-survivor', { cachedPid: CACHED_PID });
    mocks.closeTerminalAndWait.mockResolvedValue(false);

    const { status, json } = await kill('kc-survivor', CENTRAL);

    expect(status).toBe(500);
    expect(json.ok).toBe(false);
    expect(JSON.stringify(json)).not.toContain(String(CACHED_PID));
    expect(mocks.findClaudeProcess).not.toHaveBeenCalled();
    expect(mocks.terminateProcessTree).not.toHaveBeenCalled();
    expect(store.getSession('kc-survivor')?.status).not.toBe('ended');
  });

  it('a person’s kill is unchanged: it still asks findClaudeProcess and closes without waiting', async () => {
    await card('kc-person');
    mocks.findClaudeProcess.mockReturnValue(CACHED_PID);

    const { status, json } = await kill('kc-person', 'mac-window-1', { expectTerminalId: 'not-this-one' });

    expect(status).toBe(200);
    expect(mocks.findClaudeProcess).toHaveBeenCalledTimes(1);
    expect(mocks.terminateProcessTree).toHaveBeenCalledWith(CACHED_PID);
    expect(mocks.closeTerminal).toHaveBeenCalledWith('kc-person');
    expect(mocks.closeTerminalAndWait).not.toHaveBeenCalled();
    expect(json.killedPid).toBe(CACHED_PID);
  });

  it('a person’s kill of a card with no terminal and no pid is not refused no_safe_target', async () => {
    await card('kc-person-none', { terminalId: null });

    const { status, json } = await kill('kc-person-none');

    expect(json.error).not.toBe('no_safe_target');
    expect(status).not.toBe(409);
    expect(mocks.findClaudeProcess).toHaveBeenCalledTimes(1);
  });
});

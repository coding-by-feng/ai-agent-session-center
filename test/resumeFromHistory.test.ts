// test/resumeFromHistory.test.ts — POST /api/sessions/:id/resume for a HISTORY row.
//
// The HISTORY tab lists every session in the database, but the route read only the live store, so all but
// the few sessions still on screen answered "Session not found". A row that is only in the history now
// comes back as a new card: a new terminal in its project folder running the CLI's own resume command.
// And a session that is still running is never "resumed" again: the route used to type
// `codex resume '<id>' || codex` + Enter into the running agent, as a prompt.
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  getSessionRow: vi.fn(),
  planHistoryResume: vi.fn(),
  createTerminal: vi.fn(),
  writeWhenReady: vi.fn(),
  writeToTerminal: vi.fn(),
  maybeInjectUltracode: vi.fn(),
  consumePendingLink: vi.fn(),
  getTerminals: vi.fn(),
  findClaudeProcess: vi.fn(),
  terminateProcessTree: vi.fn(),
  broadcast: vi.fn(),
}));

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
  getSessionRow: mocks.getSessionRow,
  deleteSession: vi.fn(),
  default: {},
}));
vi.mock('../server/historyResume.js', () => ({ planHistoryResume: mocks.planHistoryResume }));
// Never reach a real process (see known-issues.md): nothing here kills, but the store's lookups stay mocked.
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
    createTerminal: mocks.createTerminal,
    writeWhenReady: mocks.writeWhenReady,
    writeToTerminal: mocks.writeToTerminal,
    maybeInjectUltracode: mocks.maybeInjectUltracode,
    consumePendingLink: mocks.consumePendingLink,
    getTerminals: mocks.getTerminals,
  };
});
vi.mock('../server/wsManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/wsManager.js')>('../server/wsManager.js');
  return { ...actual, broadcast: mocks.broadcast };
});

import express from 'express';
import { createServer, type Server } from 'http';
import { EVENT_TYPES } from '../server/constants.js';

const realProcessKill = process.kill.bind(process);
const killGuard = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`resumeFromHistory.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

let server: Server | null = null;
let baseUrl = '';
let store: typeof import('../server/sessionStore.js');
let projectDir = '';
let n = 0;
let ID = '';
let NEW_TERMINAL = '';

beforeAll(async () => {
  store = await import('../server/sessionStore.js');
  projectDir = mkdtempSync(join(tmpdir(), 'resume-history-'));
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  const { default: apiRouter } = await import('../server/apiRouter.js');
  app.use('/api', apiRouter);
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server!.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  killGuard.mockRestore();
  rmSync(projectDir, { recursive: true, force: true });
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

beforeEach(() => {
  n += 1;
  ID = `0a0b0c0d-1111-4222-8333-${String(n).padStart(12, '0')}`;
  NEW_TERMINAL = `term-history-${n}`;
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.findClaudeProcess.mockReturnValue(null);
  mocks.terminateProcessTree.mockResolvedValue(true);
  mocks.createTerminal.mockResolvedValue(NEW_TERMINAL);
  mocks.getTerminals.mockReturnValue([]);
});

async function resume(id: string, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/sessions/${id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const historyRow = (over: Record<string, unknown> = {}) => ({
  id: ID, project_path: projectDir, project_name: 'exmouth', title: 'Exmouth KRT Codex', model: 'gpt-6-astra', status: 'waiting', ...over,
});

describe('resume a session that is only in the history', () => {
  it('opens a new terminal in its folder and types the CLI resume command, launched as it last ran', async () => {
    mocks.getSessionRow.mockReturnValue(historyRow());
    mocks.planHistoryResume.mockResolvedValue({ cli: 'codex', command: 'codex --dangerously-bypass-approvals-and-sandbox', model: 'gpt-6-astra', effortLevel: 'high' });

    const { status, json } = await resume(ID);

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, terminalId: NEW_TERMINAL, cli: 'codex', newTerminal: true });
    expect(mocks.planHistoryResume).toHaveBeenCalledWith(ID, projectDir);
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
    const config = mocks.createTerminal.mock.calls[0][0];
    // Blank spawn + deferred launch: the `||` in the resume line can't pass the launch validation, and the
    // pending link keeps another session's hooks in this folder off the new card (as workspace restore does).
    expect(config).toMatchObject({ host: 'localhost', workingDir: projectDir, command: '', deferredLaunch: true });
    expect(mocks.consumePendingLink).not.toHaveBeenCalled();
    const [terminalId, line] = mocks.writeWhenReady.mock.calls[0];
    expect(terminalId).toBe(NEW_TERMINAL);
    expect(line).toBe(
      `codex --model gpt-6-astra -c 'model_reasoning_effort="high"' --dangerously-bypass-approvals-and-sandbox resume '${ID}'`
      + ` || codex --model gpt-6-astra -c 'model_reasoning_effort="high"' --dangerously-bypass-approvals-and-sandbox\r`,
    );
    // The new card is on LIVE, named as the row was, until the CLI's SessionStart re-keys it to the id.
    const card = store.getSession(NEW_TERMINAL);
    expect(card?.title).toBe('Exmouth KRT Codex');
    expect(card?.projectPath).toBe(projectDir);
    expect(mocks.writeToTerminal).not.toHaveBeenCalled();
  });

  it('a Claude row comes back with its permission mode and title', async () => {
    mocks.getSessionRow.mockReturnValue(historyRow({ title: 'Exmouth KRT', model: 'claude-opus-5-5' }));
    mocks.planHistoryResume.mockResolvedValue({ cli: 'claude', command: 'claude', permissionMode: 'bypassPermissions' });

    const { status, json } = await resume(ID);

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, cli: 'claude' });
    const line: string = mocks.writeWhenReady.mock.calls[0][1];
    expect(line).toBe(`claude --dangerously-skip-permissions -n "Exmouth KRT" --resume '${ID}' || claude --dangerously-skip-permissions -n "Exmouth KRT"\r`);
  });

  it('resumes in the folder the conversation was launched in, not the one its agent last worked in', async () => {
    const launchDir = mkdtempSync(join(tmpdir(), 'resume-history-launch-'));
    try {
      mocks.getSessionRow.mockReturnValue(historyRow({ project_path: join(projectDir, 'crm', 'src') }));
      mocks.planHistoryResume.mockResolvedValue({ cli: 'claude', command: 'claude', workingDir: launchDir });

      const { status } = await resume(ID);

      expect(status).toBe(200);
      expect(mocks.createTerminal.mock.calls[0][0]).toMatchObject({ workingDir: launchDir });
      expect(store.getSession(NEW_TERMINAL)?.projectPath).toBe(launchDir);
    } finally {
      rmSync(launchDir, { recursive: true, force: true });
    }
  });

  it('a second click while the first card is still starting does not open a second copy of the conversation', async () => {
    mocks.getSessionRow.mockReturnValue(historyRow());
    mocks.planHistoryResume.mockResolvedValue({ cli: 'claude', command: 'claude' });
    expect((await resume(ID)).status).toBe(200);
    mocks.getTerminals.mockReturnValue([{ terminalId: NEW_TERMINAL, isOps: false }]);

    const second = await resume(ID);

    expect(second.json).toMatchObject({ ok: true, alreadyRunning: true });
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.writeWhenReady).toHaveBeenCalledTimes(1);
  });

  it('no saved conversation: says so and opens nothing', async () => {
    mocks.getSessionRow.mockReturnValue(historyRow());
    mocks.planHistoryResume.mockResolvedValue(null);

    const { status, json } = await resume(ID);

    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/no saved Claude or Codex conversation/i);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(mocks.writeWhenReady).not.toHaveBeenCalled();
  });

  it('a project folder that no longer exists: says so and opens nothing', async () => {
    mocks.getSessionRow.mockReturnValue(historyRow({ project_path: join(projectDir, 'gone') }));
    mocks.planHistoryResume.mockResolvedValue({ cli: 'claude', command: 'claude' });

    const { status, json } = await resume(ID);

    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/no longer exists/i);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });

  it('an id in neither the live store nor the history is still 404', async () => {
    mocks.getSessionRow.mockReturnValue(null);
    const { status } = await resume(ID);
    expect(status).toBe(404);
    expect(mocks.planHistoryResume).not.toHaveBeenCalled();
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });

  it('another device cannot resume a history-only session (unknown fails closed)', async () => {
    mocks.getSessionRow.mockReturnValue(historyRow());
    mocks.planHistoryResume.mockResolvedValue({ cli: 'claude', command: 'claude' });
    const { status } = await resume(ID, { 'X-Forwarded-For': '192.168.1.80' });
    expect(status).toBe(404);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });

  it('the terminal budget still applies', async () => {
    mocks.getSessionRow.mockReturnValue(historyRow());
    mocks.planHistoryResume.mockResolvedValue({ cli: 'claude', command: 'claude' });
    mocks.getTerminals.mockReturnValue(Array.from({ length: 130 }, (_, i) => ({ terminalId: `term-full-${i}`, isOps: false })));
    const { status } = await resume(ID);
    expect(status).toBe(429);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });
});

describe('resume a session that is still running', () => {
  it('types nothing into the running agent and says it is already running', async () => {
    const terminal = `term-live-${n}`;
    // Its own folder: the cards the history cases opened are still "connecting" in projectDir, and a
    // SessionStart there could be matched to one of them by directory.
    const liveDir = join(projectDir, 'live');
    await store.createTerminalSession(terminal, { host: 'localhost', workingDir: liveDir, command: 'codex', sessionTitle: 'Exmouth KRT Codex' });
    store.handleEvent({ session_id: ID, hook_event_name: EVENT_TYPES.SESSION_START, agent_terminal_id: terminal, cwd: liveDir, startup_command: 'codex' } as never);
    store.handleEvent({ session_id: ID, hook_event_name: EVENT_TYPES.STOP, agent_terminal_id: terminal } as never);
    expect(store.getSession(ID)).toMatchObject({ status: 'waiting', terminalId: terminal });
    mocks.getTerminals.mockReturnValue([{ terminalId: terminal, isOps: false }]);

    const { status, json } = await resume(ID);

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, alreadyRunning: true });
    expect(mocks.writeToTerminal).not.toHaveBeenCalled();
    expect(mocks.writeWhenReady).not.toHaveBeenCalled();
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(store.getSession(ID)?.status).not.toBe('connecting');
  });
});

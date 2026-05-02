// test/apiRouter.workspaceFixes.test.ts — RC-2 + RC-4 + RC-14 server-side fix verification.
// Covers:
//   RC-4: POST /api/sessions/clear-all honours { suppressBroadcast: true } body
//         flag and skips the CLEAR_BROWSER_DB websocket broadcast.
//   RC-2: POST /api/workspace/save dedup key includes originalSessionId so two
//         sessions with identical SSH config but distinct originalSessionIds are
//         retained (not collapsed to a single entry).
//   RC-14: POST /api/terminals preserves command='' and writes startupCommand
//          after shell readiness for raw commands with shell metacharacters.
import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'fs';

const __apiDirnameForFixture = dirname(fileURLToPath(import.meta.url));
const readFileSyncForFixture = readFileSync;

let server: Server | null = null;
let baseUrl = '';
let workspaceDir = '';
let broadcastSpy: ReturnType<typeof vi.fn>;

const sshManagerMocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  writeWhenReady: vi.fn(),
  closeTerminal: vi.fn(),
  getTerminalOutputBuffer: vi.fn(),
}));

vi.mock('../server/wsManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/wsManager.js')>('../server/wsManager.js');
  return {
    ...actual,
    broadcast: vi.fn(),
  };
});

vi.mock('../server/sshManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/sshManager.js')>('../server/sshManager.js');
  return {
    ...actual,
    createTerminal: sshManagerMocks.createTerminal,
    writeWhenReady: sshManagerMocks.writeWhenReady,
    closeTerminal: sshManagerMocks.closeTerminal,
    getTerminalOutputBuffer: sshManagerMocks.getTerminalOutputBuffer,
  };
});

beforeAll(async () => {
  // Point the snapshot file at a fresh tmp dir BEFORE the apiRouter is loaded.
  workspaceDir = join(tmpdir(), `aasc-workspace-fixes-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(workspaceDir, { recursive: true });
  process.env.APP_USER_DATA = workspaceDir;

  const app = express();
  app.use(express.json());
  const { default: apiRouter } = await import('../server/apiRouter.js');
  app.use('/api', apiRouter);

  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const { broadcast } = await import('../server/wsManager.js');
  broadcastSpy = broadcast as unknown as ReturnType<typeof vi.fn>;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  if (workspaceDir && existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  broadcastSpy.mockClear();
  let terminalSeq = 0;
  sshManagerMocks.createTerminal.mockReset();
  sshManagerMocks.createTerminal.mockImplementation(async () => `term-rc14-${++terminalSeq}`);
  sshManagerMocks.writeWhenReady.mockReset();
  sshManagerMocks.writeWhenReady.mockResolvedValue(true);
  sshManagerMocks.closeTerminal.mockReset();
  sshManagerMocks.getTerminalOutputBuffer.mockReset();
  sshManagerMocks.getTerminalOutputBuffer.mockReturnValue(null);
});

afterEach(() => {
  // Clean snapshot file between tests
  const snapPath = join(workspaceDir, 'workspace-snapshot.json');
  if (existsSync(snapPath)) rmSync(snapPath);
});

describe('RC-4 — POST /api/sessions/clear-all suppressBroadcast', () => {
  it('skips the CLEAR_BROWSER_DB broadcast when suppressBroadcast=true', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/clear-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suppressBroadcast: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Wait a tick for any deferred broadcast to flush
    await new Promise(r => setTimeout(r, 20));
    const broadcastTypes = broadcastSpy.mock.calls.map(c => (c[0] as { type: string }).type);
    expect(broadcastTypes).not.toContain('clearBrowserDb');
  });

  it('still broadcasts CLEAR_BROWSER_DB when suppressBroadcast is absent', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/clear-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 20));
    const broadcastTypes = broadcastSpy.mock.calls.map(c => (c[0] as { type: string }).type);
    expect(broadcastTypes).toContain('clearBrowserDb');
  });

  it('still broadcasts CLEAR_BROWSER_DB when suppressBroadcast=false', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/clear-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suppressBroadcast: false }),
    });
    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 20));
    const broadcastTypes = broadcastSpy.mock.calls.map(c => (c[0] as { type: string }).type);
    expect(broadcastTypes).toContain('clearBrowserDb');
  });
});

describe('RC-14 — POST /api/terminals raw startupCommand launch', () => {
  it('preserves command="" and writes startupCommand after shell readiness', async () => {
    const res = await fetch(`${baseUrl}/api/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'localhost',
        port: 22,
        username: 'tester',
        workingDir: '/tmp',
        command: '',
        startupCommand: 'npm run dev && claude',
        originalSessionId: 'term-raw-command',
        sessionTitle: 'Raw Command',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; terminalId: string };
    expect(body.ok).toBe(true);
    expect(body.terminalId).toBe('term-rc14-1');

    expect(sshManagerMocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '',
        startupCommand: 'npm run dev && claude',
        deferredLaunch: true,
      }),
      null,
    );
    expect(sshManagerMocks.writeWhenReady).toHaveBeenCalledWith(
      'term-rc14-1',
      'npm run dev && claude\r',
    );

    await fetch(`${baseUrl}/api/sessions/clear-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suppressBroadcast: true }),
    });
  });
});

describe('RC-2 — POST /api/workspace/save dedup includes originalSessionId', () => {
  function makeSnapshot(sessions: Array<Record<string, unknown>>): Record<string, unknown> {
    return { version: 1, exportedAt: Date.now(), sessions, rooms: [] };
  }

  it('keeps sessions with identical 7-field config but distinct originalSessionId', async () => {
    const sshConfig = {
      host: 'localhost',
      port: 22,
      username: 'tester',
      workingDir: '/Users/tester',
      command: 'claude',
    };
    const sessions = [
      {
        originalSessionId: 'sess-uuid-A',
        title: 'Same Title',
        startupCommand: 'claude',
        sshConfig,
      },
      {
        originalSessionId: 'sess-uuid-B',
        title: 'Same Title',
        startupCommand: 'claude',
        sshConfig,
      },
    ];

    const saveRes = await fetch(`${baseUrl}/api/workspace/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeSnapshot(sessions)),
    });
    expect(saveRes.status).toBe(200);
    const saveBody = await saveRes.json();
    expect(saveBody.ok).toBe(true);

    const loadRes = await fetch(`${baseUrl}/api/workspace/load`);
    expect(loadRes.status).toBe(200);
    const snap = await loadRes.json() as { sessions: Array<{ originalSessionId: string }> };
    expect(snap.sessions.map(s => s.originalSessionId).sort()).toEqual(['sess-uuid-A', 'sess-uuid-B']);
  });

  it('still dedups true duplicates (same 8 fields)', async () => {
    const sshConfig = {
      host: 'localhost',
      port: 22,
      username: 'tester',
      workingDir: '/Users/tester',
      command: 'claude',
    };
    const sessions = [
      {
        originalSessionId: 'sess-uuid-X',
        title: 'Dup Title',
        startupCommand: 'claude',
        sshConfig,
      },
      {
        originalSessionId: 'sess-uuid-X',
        title: 'Dup Title',
        startupCommand: 'claude',
        sshConfig,
      },
    ];

    const saveRes = await fetch(`${baseUrl}/api/workspace/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeSnapshot(sessions)),
    });
    expect(saveRes.status).toBe(200);

    const loadRes = await fetch(`${baseUrl}/api/workspace/load`);
    const snap = await loadRes.json() as { sessions: Array<{ originalSessionId: string }> };
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0].originalSessionId).toBe('sess-uuid-X');
  });

  it('preserves all 16 sessions from the real user fixture (regression for RC-2)', async () => {
    // The user-provided real-world snapshot has multiple sessions in shared
    // workDirs (5 in /Users/kasonzhan/Documents/thesis, 2 in shared command projs,
    // etc.).  Without originalSessionId in the dedup key, the server collapses
    // these into a much smaller set on save.
    const fixturePath = join(__apiDirnameForFixture, 'fixtures', 'user-workspace-snapshot.json');
    const raw = readFileSyncForFixture(fixturePath, 'utf8');
    const fixture = JSON.parse(raw) as { sessions: Array<{ originalSessionId: string }> };
    const expectedCount = fixture.sessions.length;

    const saveRes = await fetch(`${baseUrl}/api/workspace/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture),
    });
    expect(saveRes.status).toBe(200);
    const loadRes = await fetch(`${baseUrl}/api/workspace/load`);
    const snap = await loadRes.json() as { sessions: Array<{ originalSessionId: string }> };
    expect(snap.sessions).toHaveLength(expectedCount);
    expect(new Set(snap.sessions.map(s => s.originalSessionId)).size).toBe(expectedCount);
  });

  it('preserves multiple sessions sharing the same workDir+command but with distinct ids', async () => {
    const baseSsh = {
      host: 'localhost',
      port: 22,
      username: 'tester',
      workingDir: '/Users/tester/projects/shared',
      command: 'claude',
    };
    const sessions = [
      { originalSessionId: 'a', title: 'Tab 1', startupCommand: 'claude', sshConfig: baseSsh },
      { originalSessionId: 'b', title: 'Tab 1', startupCommand: 'claude', sshConfig: baseSsh },
      { originalSessionId: 'c', title: 'Tab 1', startupCommand: 'claude', sshConfig: baseSsh },
      { originalSessionId: 'd', title: 'Tab 1', startupCommand: 'claude', sshConfig: baseSsh },
      { originalSessionId: 'e', title: 'Tab 1', startupCommand: 'claude', sshConfig: baseSsh },
      { originalSessionId: 'f', title: 'Tab 1', startupCommand: 'claude', sshConfig: baseSsh },
    ];

    const saveRes = await fetch(`${baseUrl}/api/workspace/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeSnapshot(sessions)),
    });
    expect(saveRes.status).toBe(200);

    const loadRes = await fetch(`${baseUrl}/api/workspace/load`);
    const snap = await loadRes.json() as { sessions: Array<{ originalSessionId: string }> };
    expect(snap.sessions.map(s => s.originalSessionId).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

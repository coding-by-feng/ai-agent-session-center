// test/workspaceRestoreClaim.test.ts — the HTTP layer of the destructive-restore guard.
//
// `POST /api/sessions/clear-all` kills every PTY and deletes every session. Its
// only production caller is `importSnapshot`, the opening move of a workspace
// restore — but `useWorkspaceAutoLoad` is mounted in App.tsx, so EVERY client
// ran it on connect. Opening the dashboard on a phone therefore wiped and
// rebuilt the workspace the desktop app was actively using.
//
// presenceManager owns the rules and is unit-tested separately; this suite
// proves the wiring — that the guard is actually reachable through Express,
// that it keys off the restore claim rather than merely "is this a known
// device", and that a cold server is still clearable.
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';

// sessionStore/apiRouter open better-sqlite3 at module scope via db.ts. Stub it
// so this suite stays runnable when the native module's ABI doesn't match the
// local Node — otherwise the file fails at import and silently covers nothing.
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

vi.mock('../server/wsManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/wsManager.js')>('../server/wsManager.js');
  return { ...actual, broadcast: vi.fn() };
});

const sshManagerMocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  writeWhenReady: vi.fn(),
  closeTerminal: vi.fn(),
  getTerminalOutputBuffer: vi.fn(),
}));

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

import express from 'express';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import * as presence from '../server/presenceManager.js';
import { clearAllSessions, createTerminalSession } from '../server/sessionStore.js';

let server: Server | null = null;
let baseUrl = '';
let workspaceDir = '';

const DESKTOP = { id: 'desk-1', label: 'Mac · Desktop App' };
const PHONE = { id: 'phone-1', label: 'iPhone · Safari' };

/** A fetch that identifies itself the way the patched client fetch does. */
function asDevice(
  device: { id: string; label: string } | null,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (device) {
    headers['x-aasc-client-id'] = device.id;
    headers['x-aasc-client-label'] = device.label;
  }
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

let liveSeq = 0;

/** Put a real session into the store so the guard has something to protect. */
async function createLiveSession(title: string): Promise<void> {
  await createTerminalSession(`term-live-${++liveSeq}`, {
    host: 'localhost',
    port: 22,
    username: 'test',
    authMethod: 'agent',
    workingDir: '/tmp',
    command: 'claude',
    sessionTitle: title,
  } as Parameters<typeof createTerminalSession>[1]);
}

beforeAll(async () => {
  workspaceDir = join(tmpdir(), `aasc-restore-claim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
  presence._resetForTests();
  clearAllSessions();
  let seq = 0;
  sshManagerMocks.createTerminal.mockReset();
  sshManagerMocks.createTerminal.mockImplementation(async () => `term-claim-${++seq}`);
  sshManagerMocks.writeWhenReady.mockReset();
  sshManagerMocks.writeWhenReady.mockResolvedValue(true);
  sshManagerMocks.closeTerminal.mockReset();
  sshManagerMocks.getTerminalOutputBuffer.mockReset();
  sshManagerMocks.getTerminalOutputBuffer.mockReturnValue(null);
});

describe('POST /api/workspace/restore-claim', () => {
  it('grants the first device and denies the second', async () => {
    const first = await (await asDevice(DESKTOP, '/api/workspace/restore-claim', { method: 'POST' })).json();
    expect(first.granted).toBe(true);

    const second = await (await asDevice(PHONE, '/api/workspace/restore-claim', { method: 'POST' })).json();
    expect(second.granted).toBe(false);
    expect(second.reason).toBe('already-restored');
    expect(second.by).toBe('Mac · Desktop App');
  });

  it('refuses to grant a destructive, once-per-boot operation to an unidentified caller', async () => {
    const res = await asDevice(null, '/api/workspace/restore-claim', { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await res.json()).granted).toBe(false);
  });

  it('lets the holder release so a failed import can retry', async () => {
    await asDevice(DESKTOP, '/api/workspace/restore-claim', { method: 'POST' });
    await asDevice(DESKTOP, '/api/workspace/restore-claim/release', { method: 'POST' });

    const retry = await (await asDevice(PHONE, '/api/workspace/restore-claim', { method: 'POST' })).json();
    expect(retry.granted).toBe(true);
  });
});

describe('POST /api/sessions/clear-all — destructive-call guard', () => {
  it('blocks a non-owner with 409 while sessions are live, and destroys nothing', async () => {
    await createLiveSession('Live work');
    await asDevice(DESKTOP, '/api/workspace/restore-claim', { method: 'POST' });

    const res = await asDevice(PHONE, '/api/sessions/clear-all', {
      method: 'POST',
      body: JSON.stringify({ suppressBroadcast: true }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('workspace-in-use');
    expect(body.liveSessions).toBe(1);
    expect(body.by).toBe('Mac · Desktop App');

    // The session must still be there — a 409 that had already killed the PTY
    // would be worse than no guard at all.
    const sessions = await (await asDevice(PHONE, '/api/sessions')).json();
    expect(Object.keys(sessions)).toHaveLength(1);
  });

  it('blocks an ANONYMOUS caller while sessions are live', async () => {
    await createLiveSession('Live work');

    const res = await asDevice(null, '/api/sessions/clear-all', {
      method: 'POST',
      body: JSON.stringify({ suppressBroadcast: true }),
    });
    expect(res.status).toBe(409);
  });

  // The guard keys off the CLAIM, not off "is this device known" — a stale or
  // hostile client that merely sends a client-id must not pass.
  it('blocks a device that is known but does not hold the claim', async () => {
    await createLiveSession('Live work');
    await asDevice(DESKTOP, '/api/workspace/restore-claim', { method: 'POST' });

    const res = await asDevice(PHONE, '/api/sessions/clear-all', {
      method: 'POST',
      body: JSON.stringify({ suppressBroadcast: true }),
    });
    expect(res.status).toBe(409);
  });

  it('allows the restore owner through', async () => {
    await createLiveSession('Live work');
    await asDevice(DESKTOP, '/api/workspace/restore-claim', { method: 'POST' });

    const res = await asDevice(DESKTOP, '/api/sessions/clear-all', {
      method: 'POST',
      body: JSON.stringify({ suppressBroadcast: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(1);
  });

  // A cold server has nothing to lose, so the guard must not stand in the way
  // of the very first restore — which is the case it is meant to enable.
  it('allows any caller when zero sessions are live (cold start)', async () => {
    const res = await asDevice(null, '/api/sessions/clear-all', {
      method: 'POST',
      body: JSON.stringify({ suppressBroadcast: true }),
    });
    expect(res.status).toBe(200);
  });
});

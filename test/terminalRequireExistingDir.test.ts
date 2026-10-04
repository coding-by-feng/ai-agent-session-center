// test/terminalRequireExistingDir.test.ts — POST /api/terminals with `requireExistingDir`.
//
// `createTerminal` quietly starts a shell in the HOME directory when the requested one is gone (RC-6: a workspace
// restore must not lose a card over a deleted folder). For "start a new session in THIS project" that is a trap: the
// agent comes up in ~ with write tools, under a "Launched" toast, and its card then moves to another frame. A caller
// that expects the directory to exist opts in with `requireExistingDir` and gets a 400 instead. Everyone else — the
// restore, DIRS, + NEW — keeps the fallback, and this file pins that too.
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

const mocks = vi.hoisted(() => ({ createTerminal: vi.fn() }));

vi.mock('../server/sshManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/sshManager.js')>('../server/sshManager.js');
  return { ...actual, createTerminal: mocks.createTerminal };
});

import express from 'express';
import { createServer, type Server } from 'http';

let server: Server | null = null;
let baseUrl = '';
let scratch = '';

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'require-existing-dir-'));
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
  if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.createTerminal.mockReset();
  // Stop the handler right after the call: what these tests ask is whether it GOT to creating a terminal.
  mocks.createTerminal.mockRejectedValue(new Error('stop here'));
});

async function postTerminal(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'claude', forceNew: true, ...body }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/terminals — requireExistingDir', () => {
  it('refuses a directory that is gone, and starts nothing', async () => {
    const missing = join(scratch, 'was-here-once');
    const { status, json } = await postTerminal({ workingDir: missing, requireExistingDir: true });

    expect(status).toBe(400);
    expect(json.success).toBe(false);
    expect(String(json.error)).toContain('Directory not found');
    expect(String(json.error)).toContain(missing);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });

  it('refuses a path that is a file, not a directory', async () => {
    const file = join(scratch, 'a-file.txt');
    writeFileSync(file, 'x');
    const { status } = await postTerminal({ workingDir: file, requireExistingDir: true });

    expect(status).toBe(400);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });

  it('lets a directory that exists through to terminal creation', async () => {
    await postTerminal({ workingDir: scratch, requireExistingDir: true });
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
  });

  it('expands ~ the way the terminal itself does', async () => {
    const gone = await postTerminal({ workingDir: '~/definitely-not-a-real-folder-3f9a2c', requireExistingDir: true });
    expect(gone.status).toBe(400);
    expect(mocks.createTerminal).not.toHaveBeenCalled();

    await postTerminal({ workingDir: '~', requireExistingDir: true });
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
  });

  it('does nothing without the flag: a missing directory still reaches terminal creation (the restore / DIRS / + NEW fallback)', async () => {
    await postTerminal({ workingDir: join(scratch, 'was-here-once') });
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
  });

  it('does not check a directory on another machine — this disk says nothing about it', async () => {
    await postTerminal({ workingDir: '/srv/somewhere/else', host: 'build-box', username: 'deploy', requireExistingDir: true });
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
  });

  it('says nothing about a request that names no directory (the server defaults to home)', async () => {
    await postTerminal({ requireExistingDir: true });
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
  });

  it('still validates the rest of the request first', async () => {
    const { status } = await postTerminal({ workingDir: '/w/app;rm -rf', requireExistingDir: true });
    expect(status).toBe(400);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });
});

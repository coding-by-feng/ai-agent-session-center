// test/terminalAutoConfirmTrust.test.ts — POST /api/terminals carries `autoConfirmTrust: false` (AASC-54).
// A workspace restore re-creates a phone's new-folder session through this route; the flag keeps the
// dashboard from answering Claude's "trust this folder" prompt for it. Only `false` is accepted: a caller
// may make a launch stricter, never turn the prompt-answering back on for someone else's session.
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), default: {},
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
  scratch = mkdtempSync(join(tmpdir(), 'auto-confirm-trust-'));
  const app = express();
  app.use(express.json());
  const { default: apiRouter } = await import('../server/apiRouter.js');
  app.use('/api', apiRouter);
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server!.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.createTerminal.mockReset();
  mocks.createTerminal.mockRejectedValue(new Error('stop here'));
});

async function post(extra: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${baseUrl}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'claude', forceNew: true, workingDir: scratch, ...extra }),
  });
  return res.status;
}

describe('POST /api/terminals — autoConfirmTrust', () => {
  it('passes autoConfirmTrust: false through to the terminal', async () => {
    await post({ autoConfirmTrust: false });
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.createTerminal.mock.calls[0][0].autoConfirmTrust).toBe(false);
  });

  it('leaves it unset when the caller says nothing', async () => {
    await post({});
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.createTerminal.mock.calls[0][0].autoConfirmTrust).toBeUndefined();
  });

  it('refuses autoConfirmTrust: true', async () => {
    expect(await post({ autoConfirmTrust: true })).toBe(400);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });
});

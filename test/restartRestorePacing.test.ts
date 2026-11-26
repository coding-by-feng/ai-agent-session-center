/**
 * A desktop restart shows each card's old screen at once and starts the CLIs a few at a time
 * (Nov 25 2026).
 *
 * Reported: after an AASC restart every terminal stayed blank for a long time. In the Nov 25 05:01
 * restart, `clear-all` logged "0 output buffers saved" (the rings live in memory and the new server
 * had no terminals), and 61 `claude --resume` were typed within a second, so the CLIs took 12 s to
 * 6 min to report. Now the server saves each ring at quit and hands it back through `clear-all`; a
 * restore's create call carries the saved screen; and restored launches wait for one of four
 * slots, freed by the CLI's first hook. These go through the real store and router.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const env = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('os') as typeof import('os');
  const root = mkdtempSync(join(tmpdir(), 'aasc-restart-restore-'));
  process.env.AASC_SCROLLBACK_DIR = join(root, 'scrollback');
  process.env.APP_USER_DATA = root;
  return { root, dir: process.env.AASC_SCROLLBACK_DIR };
});

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

const ssh = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  writeWhenReady: vi.fn(async () => true),
  closeTerminal: vi.fn(),
  getTerminalOutputBuffer: vi.fn((): string | null => null),
  prefillTerminalOutput: vi.fn(() => true),
}));

vi.mock('../server/sshManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/sshManager.js')>('../server/sshManager.js');
  return { ...actual, ...ssh };
});

import express from 'express';
import { createServer, type Server } from 'http';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { clearAllSessions, handleEvent, getSession } from '../server/sessionStore.js';

let server: Server | null = null;
let baseUrl = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  const { default: apiRouter } = await import('../server/apiRouter.js');
  app.use('/api', apiRouter);
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  rmSync(env.root, { recursive: true, force: true });
});

let seq = 0;
beforeEach(() => {
  clearAllSessions();
  ssh.createTerminal.mockReset();
  ssh.createTerminal.mockImplementation(async () => `term-rr-${++seq}`);
  ssh.writeWhenReady.mockClear();
  ssh.prefillTerminalOutput.mockClear();
});

function restore(id: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; terminalId: string }> {
  return fetch(`${baseUrl}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      host: 'localhost',
      workingDir: '/tmp',
      command: 'claude',
      sessionTitle: `Restored ${id}`,
      resumeSessionId: id,
      originalSessionId: id,
      ...extra,
    }),
  }).then((r) => r.json() as Promise<{ ok: boolean; terminalId: string }>);
}

/** The CLI in that terminal reports: its first hook. */
function cliReports(terminalId: string): void {
  handleEvent({
    session_id: terminalId,
    hook_event_name: 'SessionStart',
    cwd: '/tmp',
    cli_source: 'claude',
    agent_terminal_id: terminalId,
  } as never);
}

describe('restart restore', () => {
  it('hands back the screen saved at the last quit for a card that has no terminal yet', () => {
    handleEvent({ session_id: 'restored-1', hook_event_name: 'SessionStart', cwd: '/tmp/rr', tty_path: '/dev/ttys990', cli_source: 'claude' } as never);
    expect(getSession('restored-1')?.terminalId ?? null).toBeNull();
    mkdirSync(env.dir, { recursive: true });
    writeFileSync(join(env.dir, 'restored-1.bin'), 'the old screen');

    const { savedOutputs } = clearAllSessions();

    const mine = savedOutputs.find((o) => o.sessionId === 'restored-1');
    expect(mine && Buffer.from(mine.data, 'base64').toString()).toBe('the old screen');
    expect(existsSync(join(env.dir, 'restored-1.bin'))).toBe(false);
  });

  it('puts the saved screen in the ring before answering, so the first subscribe replays it', async () => {
    const res = await restore('aaaa-1111', { restoreBatch: true, prefillOutput: Buffer.from('old').toString('base64') });
    expect(res.ok).toBe(true);
    expect(ssh.prefillTerminalOutput).toHaveBeenCalledWith(res.terminalId, Buffer.from('old').toString('base64'));
    cliReports(res.terminalId); // closeTerminal is mocked here, so nothing else frees its slot
  });

  it('starts at most four restored CLIs, and the next when one reports', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await restore(`bbbb-${i}`, { restoreBatch: true })).terminalId);
    await vi.waitFor(() => expect(ssh.writeWhenReady).toHaveBeenCalledTimes(4));
    expect(ssh.writeWhenReady.mock.calls.map((c) => c[0])).toEqual(ids.slice(0, 4));

    cliReports(ids[1]);
    expect(ssh.writeWhenReady).toHaveBeenCalledTimes(5);
    expect(ssh.writeWhenReady.mock.calls[4][0]).toBe(ids[4]);

    // Free every slot so the next test starts from an empty line.
    for (const id of ids) cliReports(id);
    expect(ssh.writeWhenReady).toHaveBeenCalledTimes(6);
  });

  it('types a launch that is not part of a restore at once, whatever the restore is doing', async () => {
    const restoring: string[] = [];
    for (let i = 0; i < 5; i++) restoring.push((await restore(`cccc-${i}`, { restoreBatch: true })).terminalId);
    expect(ssh.writeWhenReady).toHaveBeenCalledTimes(4);

    const respawn = await restore('dddd-1'); // a pinned respawn: no restoreBatch
    expect(ssh.writeWhenReady.mock.calls.map((c) => c[0])).toContain(respawn.terminalId);

    for (const id of restoring) cliReports(id);
  });
});

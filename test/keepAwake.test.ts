// test/keepAwake.test.ts — AASC-16 (optional): keep the Mac awake while an agent is busy, only when turned on;
// since Nov 27 2026 also `always`, saved in server-config.json, with a holder for a server with no window.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { anySessionBusy, createKeepAwake, parseKeepAwakeMode } from '../server/keepAwake.js';
import { createSleepHolder, holderCommand } from '../server/keepAwakeHolder.js';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), default: {},
}));

describe('anySessionBusy', () => {
  it.each(['working', 'prompting', 'approval', 'input'])('%s keeps the Mac awake', (status) => {
    expect(anySessionBusy([{ status: 'idle' }, { status }])).toBe(true);
  });
  it('idle, waiting, ended and unknown statuses don’t', () => {
    expect(anySessionBusy([{ status: 'idle' }, { status: 'waiting' }, { status: 'ended' }, { status: null }, {}])).toBe(false);
  });
});

describe('createKeepAwake', () => {
  it('stays off until turned on, then follows the sessions, and releases when turned off', () => {
    let sessions: Array<{ status: string }> = [{ status: 'working' }];
    const k = createKeepAwake(() => sessions);
    const seen: boolean[] = [];
    k.onChange((awake) => seen.push(awake));
    k.evaluate();
    expect(seen).toEqual([]); // off by default
    k.setEnabled(true);
    sessions = [{ status: 'waiting' }];
    k.evaluate();
    sessions = [{ status: 'approval' }];
    k.evaluate();
    k.evaluate(); // no repeat for the same state
    k.setEnabled(false);
    expect(seen).toEqual([true, false, true, false]);
    expect(k.isAwake()).toBe(false);
  });

  it('a throwing listener doesn’t stop the others, and unsubscribing works', () => {
    const k = createKeepAwake(() => [{ status: 'working' }]);
    const good = vi.fn();
    k.onChange(() => { throw new Error('bad listener'); });
    const off = k.onChange(good);
    k.setEnabled(true);
    off();
    k.setEnabled(false);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('keep-awake modes', () => {
  it('always holds with no session busy, busy follows the sessions, off lets go', () => {
    let sessions: Array<{ status: string }> = [{ status: 'idle' }];
    const k = createKeepAwake(() => sessions);
    const seen: boolean[] = [];
    k.onChange((awake) => seen.push(awake));
    expect(k.hasListener()).toBe(true);
    k.setMode('always');
    expect(k.isAwake()).toBe(true);
    k.setMode('busy');
    expect(k.isAwake()).toBe(false);
    sessions = [{ status: 'working' }];
    k.evaluate();
    k.setMode('off');
    expect(seen).toEqual([true, false, true, false]);
    expect(k.getMode()).toBe('off');
  });

  it('the older switch maps to busy and off', () => {
    const k = createKeepAwake(() => []);
    k.setEnabled(true);
    expect(k.getMode()).toBe('busy');
    k.setEnabled(false);
    expect(k.getMode()).toBe('off');
  });

  it('reads only the three modes', () => {
    expect(parseKeepAwakeMode('always')).toBe('always');
    expect(parseKeepAwakeMode('ALWAYS')).toBeNull();
    expect(parseKeepAwakeMode(true)).toBeNull();
    expect(parseKeepAwakeMode(undefined)).toBeNull();
  });
});

describe('whether anything really holds it (review, Nov 27 2026)', () => {
  it('holding follows awake, and a hold check that fails says so', () => {
    const k = createKeepAwake(() => []);
    expect(k.isHolding()).toBe(false);
    k.setMode('always');
    expect(k.isHolding()).toBe(true);
    let alive = true;
    k.setHoldCheck(() => alive);
    expect(k.isHolding()).toBe(true);
    alive = false;
    expect(k.isHolding()).toBe(false);
    k.setMode('off');
    expect(k.isHolding()).toBe(false);
  });
});

describe('the holder for a server with no window', () => {
  it('uses each platform’s own tool, watching this server’s pid', () => {
    expect(holderCommand('darwin', 42)).toEqual({ command: 'caffeinate', args: ['-i', '-s', '-w', '42'] });
    const linux = holderCommand('linux', 42)!;
    expect(linux.command).toBe('systemd-inhibit');
    expect(linux.args).toEqual(expect.arrayContaining(['--what=idle:sleep', 'tail', '--pid=42']));
    const win = holderCommand('win32', 42)!;
    expect(win.command).toBe('powershell.exe');
    expect(win.args.at(-1)).toMatch(/SetThreadExecutionState\(0x80000001\).*Wait-Process -Id 42/);
    expect(holderCommand('aix', 42)).toBeNull();
  });

  function fakeSpawn() {
    const children: Array<EventEmitter & { killed: boolean }> = [];
    const spawn = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        killed: false,
        unref: vi.fn(),
        kill: vi.fn(() => { child.killed = true; child.emit('exit', null, 'SIGTERM'); return true; }),
      });
      children.push(child);
      return child as unknown as ChildProcess;
    });
    return { spawn, children };
  }

  it('starts one child per hold and stops it on release', () => {
    const { spawn, children } = fakeSpawn();
    const h = createSleepHolder({ platform: 'darwin', pid: 7, spawn });
    h.set(true);
    h.set(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('caffeinate', ['-i', '-s', '-w', '7'], expect.objectContaining({ stdio: 'ignore' }));
    expect(h.isHolding()).toBe(true);
    h.set(false);
    expect(children[0].killed).toBe(true);
    expect(h.isHolding()).toBe(false);
    h.set(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('warns when the holder stops on its own, so a refused hold is not silent (review, Nov 27 2026)', () => {
    const { spawn, children } = fakeSpawn();
    const log = { info: vi.fn(), warn: vi.fn() };
    const h = createSleepHolder({ platform: 'linux', pid: 7, spawn, log });
    h.set(true);
    children[0].emit('exit', 1, null);
    expect(h.isHolding()).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][1]).toMatch(/systemd-inhibit stopped \(exit 1\)/);
    h.set(true);
    h.set(false); // our own stop is not a warning
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('a missing tool is warned about once and the server runs on', () => {
    const { spawn, children } = fakeSpawn();
    const log = { info: vi.fn(), warn: vi.fn() };
    const h = createSleepHolder({ platform: 'linux', pid: 7, spawn, log });
    h.set(true);
    children[0].emit('error', new Error('spawn systemd-inhibit ENOENT'));
    expect(h.isHolding()).toBe(false);
    h.set(false);
    h.set(true);
    children[1].emit('error', new Error('spawn systemd-inhibit ENOENT'));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][1]).toMatch(/systemd-inhibit/);
  });

  it('holds nothing where the platform has no tool', () => {
    const { spawn } = fakeSpawn();
    const h = createSleepHolder({ platform: 'aix', spawn, log: { info: vi.fn(), warn: vi.fn() } });
    h.set(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(h.isHolding()).toBe(false);
  });
});

describe('POST /api/config/keep-awake', () => {
  let server: import('http').Server;
  let base = '';
  beforeAll(async () => {
    const express = (await import('express')).default;
    const { createServer } = await import('http');
    const { default: apiRouter } = await import('../server/apiRouter.js');
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/config/keep-awake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  it('the Mac turns it on and off', async () => {
    const { keepAwake } = await import('../server/keepAwakeService.js');
    expect((await post({ enabled: true })).status).toBe(200);
    expect(keepAwake.isEnabled()).toBe(true);
    expect((await post({ enabled: false })).status).toBe(200);
    expect(keepAwake.isEnabled()).toBe(false);
    expect((await post({ enabled: 'yes' })).status).toBe(400);
  });

  it('saves a mode, which GET reads back, and the older switch still works', async () => {
    const { keepAwake } = await import('../server/keepAwakeService.js');
    const { CONFIG_PATH } = await import('../server/serverConfig.js');
    const res = await post({ mode: 'always' });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ mode: 'always', awake: true, saved: true });
    expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).keepAwake).toBe('always');
    const got = await (await fetch(`${base}/api/config/keep-awake`)).json();
    expect(got.data).toMatchObject({ mode: 'always', saved: true });
    expect((await post({ mode: 'sometimes' })).status).toBe(400);
    expect((await post({ mode: 'busy', enabled: true })).status).toBe(400);
    expect((await post({ enabled: false })).status).toBe(200);
    expect(keepAwake.getMode()).toBe('off');
    expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).keepAwake).toBe('off');
  });

  it('a remote device can’t change how the Mac sleeps', async () => {
    const { keepAwake } = await import('../server/keepAwakeService.js');
    const res = await post({ enabled: true }, { 'X-Forwarded-For': '192.168.1.80' });
    expect(res.status).toBe(404);
    expect(keepAwake.isEnabled()).toBe(false);
    expect((await fetch(`${base}/api/config/keep-awake`, { headers: { 'X-Forwarded-For': '192.168.1.80' } })).status).toBe(404);
  });
});

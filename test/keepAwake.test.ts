// test/keepAwake.test.ts — AASC-16 (optional): keep the Mac awake while an agent is busy, only when turned on.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { anySessionBusy, createKeepAwake } from '../server/keepAwake.js';

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

  it('a remote device can’t change how the Mac sleeps', async () => {
    const { keepAwake } = await import('../server/keepAwakeService.js');
    const res = await post({ enabled: true }, { 'X-Forwarded-For': '192.168.1.80' });
    expect(res.status).toBe(404);
    expect(keepAwake.isEnabled()).toBe(false);
  });
});

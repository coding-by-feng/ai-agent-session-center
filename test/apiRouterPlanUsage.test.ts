// test/apiRouterPlanUsage.test.ts — POST /api/plan-usage/sync
// The user-asked re-read of a CLI's plan limits: body validation, the result shape
// (timing and a changed flag, never the percentages), the per-IP rate limit, and a
// failing service reported without leaking its message.
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';

// sessionStore/apiRouter open better-sqlite3 at module scope via db.ts. Stub it so this
// suite stays runnable when the native module's ABI doesn't match the local Node.
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

const syncPlanUsage = vi.hoisted(() => vi.fn());

// Only the plan-usage call is replaced: the real store would read this machine's usage files.
vi.mock('../server/sessionStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/sessionStore.js')>();
  return { ...actual, syncPlanUsage };
});

import express from 'express';
import { createServer, type Server } from 'http';

let server: Server | null = null;
let baseUrl = '';

// The limiter keys its window on Date.now(): move the clock on between tests so one
// test's requests never count against the next.
const realNow = Date.now.bind(Date);
let clockOffset = 0;

beforeAll(async () => {
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
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
  vi.restoreAllMocks();
  await new Promise<void>((resolveClose) => (server ? server.close(() => resolveClose()) : resolveClose()));
});

beforeEach(() => {
  clockOffset += 5_000;
  syncPlanUsage.mockReset();
  syncPlanUsage.mockResolvedValue({ checkedAt: 1_791_500_000_000, asOf: 1_791_499_000_000, changed: true });
});

const post = (body: unknown) =>
  fetch(`${baseUrl}/api/plan-usage/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/plan-usage/sync', () => {
  it('syncs the CLI asked for and returns when, the newest reading time, and whether it moved', async () => {
    const res = await post({ cli: 'claude' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { cli: 'claude', checkedAt: 1_791_500_000_000, asOf: 1_791_499_000_000, changed: true },
    });
    expect(syncPlanUsage).toHaveBeenCalledWith('claude');
  });

  it('accepts codex too', async () => {
    const res = await post({ cli: 'codex' });
    expect(res.status).toBe(200);
    expect(syncPlanUsage).toHaveBeenCalledWith('codex');
  });

  it('carries no percentages: those travel only on a session update, behind its visibility gate', async () => {
    const body = await (await post({ cli: 'claude' })).json();
    expect(Object.keys(body.data).sort()).toEqual(['asOf', 'changed', 'checkedAt', 'cli']);
  });

  it.each([
    ['an unknown CLI', { cli: 'gemini' }],
    ['no CLI', {}],
    ['a non-string CLI', { cli: 7 }],
  ])('refuses %s with 400 and reads nothing', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
    expect(syncPlanUsage).not.toHaveBeenCalled();
  });

  it('reports a failing service as 500 without its message', async () => {
    syncPlanUsage.mockRejectedValue(new Error('EACCES: /tmp/claude-session-center/usage'));
    const res = await post({ cli: 'claude' });
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('Could not sync plan usage');
    expect(text).not.toContain('EACCES');
  });

  it('rate-limits a burst from one address', async () => {
    const statuses = (await Promise.all(Array.from({ length: 6 }, () => post({ cli: 'claude' })))).map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(2);
    expect(statuses).toContain(429);
  });
});

// test/commandUsageRoute.test.ts — GET /api/commands carries usage counts (Oct 21 2026), and a
// remote device's counts come only from the sessions it can see: a count is derived from the
// prompt history, and history across sessions is host-only. The database, the command index and
// the session list are fakes; nothing reads the real history or ~/.claude.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';

const reads = vi.hoisted(() => ({
  calls: [] as Array<string[] | null>,
}));

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), default: {},
  getPromptTextsSince: vi.fn((_since: number, ids: string[] | null) => {
    reads.calls.push(ids);
    // The shared session used /raab once; the hidden one used /secret-skill twice.
    if (!ids) return ['/raab go', 'run /secret-skill', '/secret-skill again'];
    return ids.includes('usage-shared') ? ['/raab go'] : [];
  }),
}));

vi.mock('../server/commandIndex.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/commandIndex.js')>()),
  getCommandIndex: () => [
    { name: 'raab', description: '', cli: 'claude', kind: 'skill', source: 'global' },
    { name: 'secret-skill', description: '', cli: 'claude', kind: 'skill', source: 'global' },
  ],
}));

vi.mock('../server/sessionStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/sessionStore.js')>()),
  getAllSessions: () => ({
    'usage-shared': { sessionId: 'usage-shared', remoteVisible: true },
    'usage-hidden': { sessionId: 'usage-hidden', remoteVisible: false },
  }),
}));

let server: Server;
let base = '';

beforeAll(async () => {
  const express = (await import('express')).default;
  const { createServer } = await import('node:http');
  const { default: apiRouter } = await import('../server/apiRouter.js');
  const app = express();
  app.use('/api', apiRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('GET /api/commands — usage counts', () => {
  it('the Mac gets counts from every session', async () => {
    const body = await (await fetch(`${base}/commands?cli=claude`)).json() as { entries: unknown[]; usage: Record<string, number> };
    expect(body.entries).toHaveLength(2);
    expect(body.usage).toEqual({ '/raab': 1, '/secret-skill': 2 });
    expect(reads.calls.at(-1)).toBeNull();
  });

  it('another device gets counts from the sessions shared with it, never a hidden one', async () => {
    const res = await fetch(`${base}/commands?cli=claude`, { headers: { 'X-Forwarded-For': '192.168.1.50' } });
    const body = await res.json() as { usage: Record<string, number> };
    expect(body.usage).toEqual({ '/raab': 1 });
    expect(reads.calls.at(-1)).toEqual(['usage-shared']);
  });
});

// test/sessionHookLevelRoute.test.ts — PUT /api/sessions/:id/hook-level (the Automation mark) and the card's mark
// from its launch config. Cards only: no terminal is started and no process is touched.
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';

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

const mocks = vi.hoisted(() => ({ findClaudeProcess: vi.fn(), terminateProcessTree: vi.fn(), broadcast: vi.fn() }));
vi.mock('../server/sessionStore.js', async () => {
  const actual = await vi.importActual<typeof import('../server/sessionStore.js')>('../server/sessionStore.js');
  return { ...actual, findClaudeProcess: mocks.findClaudeProcess };
});
vi.mock('../server/processMonitor.js', async () => {
  const actual = await vi.importActual<typeof import('../server/processMonitor.js')>('../server/processMonitor.js');
  return { ...actual, terminateProcessTree: mocks.terminateProcessTree };
});
vi.mock('../server/wsManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/wsManager.js')>('../server/wsManager.js');
  return { ...actual, broadcast: mocks.broadcast };
});

import express from 'express';
import { createServer, type Server } from 'http';

let server: Server | null = null;
let baseUrl = '';
let store: typeof import('../server/sessionStore.js');

beforeAll(async () => {
  store = await import('../server/sessionStore.js');
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
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

async function put(id: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/sessions/${id}/hook-level`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('the Automation mark on a session card', () => {
  it('comes from the launch config, so a restored card is marked from its first broadcast', async () => {
    await store.createTerminalSession('term-hl-restored', { host: 'localhost', workingDir: '/tmp/hl-a', command: 'claude', hookLevel: 'lite' });
    expect(store.getSession('term-hl-restored')?.hookLevel).toBe('lite');
    await store.createTerminalSession('term-hl-plain', { host: 'localhost', workingDir: '/tmp/hl-b', command: 'claude' });
    expect(store.getSession('term-hl-plain')).not.toHaveProperty('hookLevel');
  });

  it('is set and cleared by PUT, told to every window, and applies on restart while a terminal runs', async () => {
    await store.createTerminalSession('term-hl-toggle', { host: 'localhost', workingDir: '/tmp/hl-c', command: 'claude' });

    const on = await put('term-hl-toggle', { hookLevel: 'lite' });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ success: true, hookLevel: 'lite', appliesOnRestart: true });
    expect(store.getSession('term-hl-toggle')?.hookLevel).toBe('lite');

    const off = await put('term-hl-toggle', { hookLevel: null });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ success: true, hookLevel: null });
    expect(store.getSession('term-hl-toggle')).not.toHaveProperty('hookLevel');

    // Session updates go out through the session store's own broadcast; give its async send a turn.
    await new Promise((r) => setTimeout(r, 0));
    const sent = mocks.broadcast.mock.calls.map(([msg]) => msg as { type: string; session?: { sessionId: string; hookLevel?: string } });
    const updates = sent.filter((m) => m.type === 'session_update' && m.session?.sessionId === 'term-hl-toggle');
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });

  it('says the mark waits for the next launch while any agent runs, and not for an ended card', async () => {
    await store.createTerminalSession('term-hl-ended', { host: 'localhost', workingDir: '/tmp/hl-e', command: 'claude' });
    store.handleEvent({ session_id: 'term-hl-ended', hook_event_name: 'SessionEnd', reason: 'other' } as never);
    expect(store.getSession('term-hl-ended')?.status).toBe('ended');
    expect((await put('term-hl-ended', { hookLevel: 'lite' })).json).toMatchObject({ success: true, appliesOnRestart: false });
  });

  it('refuses a session on another host: the variable lives in this computer\'s PTY', async () => {
    await store.createTerminalSession('term-hl-remote', { host: 'build.example.com', username: 'u', workingDir: '/srv', command: 'claude' });
    const res = await put('term-hl-remote', { hookLevel: 'lite' });
    expect(res.status).toBe(409);
    expect(store.getSession('term-hl-remote')).not.toHaveProperty('hookLevel');
    // Clearing is always allowed.
    expect((await put('term-hl-remote', { hookLevel: null })).status).toBe(200);
  });

  it('answers 400 for anything but lite or null, and 404 for an unknown session', async () => {
    await store.createTerminalSession('term-hl-bad', { host: 'localhost', workingDir: '/tmp/hl-d', command: 'claude' });
    expect((await put('term-hl-bad', { hookLevel: 'high' })).status).toBe(400);
    expect((await put('term-hl-bad', {})).status).toBe(400);
    expect((await put('no-such-session', { hookLevel: 'lite' })).status).toBe(404);
  });
});

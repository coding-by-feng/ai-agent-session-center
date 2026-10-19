// test/terminalBufferConfig.test.ts — who may set the Mac's terminal replay buffer.
//
// Found on an Android phone (e2e run 5): every client pushed its own Settings ▸ Terminal value to
// POST /api/config/terminal-buffer on start-up, so any second device (an iPad signed in with the
// password) silently reset the buffer of every terminal on the Mac to its own local value. The paired
// phone was only stopped by its allow-list (a WARN on each launch). Like keep-awake, it is the Mac's
// setting: the route answers this machine only.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), default: {},
}));

const setReplayBufferBytes = vi.fn((bytes: number) => bytes);
vi.mock('../server/sshManager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/sshManager.js')>()),
  setReplayBufferBytes: (bytes: number) => setReplayBufferBytes(bytes),
}));

describe('POST /api/config/terminal-buffer', () => {
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
  beforeEach(() => setReplayBufferBytes.mockClear());

  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/config/terminal-buffer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  it('the Mac sets it', async () => {
    const res = await post({ bytes: 4 * 1024 * 1024 });
    expect(res.status).toBe(200);
    expect(setReplayBufferBytes).toHaveBeenCalledWith(4 * 1024 * 1024);
  });

  it('another device can’t reset every terminal on the Mac to its own value', async () => {
    const res = await post({ bytes: 1024 * 1024 }, { 'X-Forwarded-For': '192.168.1.80' });
    expect(res.status).toBe(404);
    expect(setReplayBufferBytes).not.toHaveBeenCalled();
  });
});

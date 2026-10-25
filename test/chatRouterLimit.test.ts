// test/chatRouterLimit.test.ts — the chat route's `limit` takes its upper bound, and says it in its refusal,
// from the page size the pager really has (PAGE_ENTRIES), not from a number written twice. The pager's constant is
// changed here, so a hard-coded 200 in the route's rule or in its message would show.
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createChatRouter } from '../server/chat/chatRouter.js';
import { resetTranscriptLocatorCache } from '../server/chat/transcriptLocator.js';
import { tempDir } from './chatFixtures.js';

vi.mock('../server/chat/transcriptPager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/chat/transcriptPager.js')>()),
  PAGE_ENTRIES: 150,
}));

let tmp = '';
let server: Server;
let base = '';
let savedHome: string | undefined;

beforeAll(async () => {
  savedHome = process.env.HOME;
  tmp = realpathSync(tempDir('aasc-chat-limit-'));
  mkdirSync(join(tmp, 'home'), { recursive: true });
  process.env.HOME = join(tmp, 'home');
  resetTranscriptLocatorCache();
  const app = express();
  app.use(
    '/api',
    createChatRouter({
      getSession: (id) => (id === 's' ? ({ sessionId: 's', cliSource: 'claude', projectPath: join(tmp, 'home', 'proj') } as never) : null),
    }),
  );
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

const get = async (query: string) => {
  const res = await fetch(`${base}/api/sessions/s/chat?${query}`);
  return { status: res.status, body: (await res.json()) as { success: boolean; error?: string } };
};

describe('GET /sessions/:id/chat?limit=', () => {
  it('accepts a limit up to the pager’s page size and refuses one above it', async () => {
    expect((await get('limit=150')).status).toBe(200);
    expect((await get('limit=151')).status).toBe(400);
  });

  it('names the pager’s page size in the refusal', async () => {
    const res = await get('limit=151');

    expect(res.body.error).toContain('from 1 to 150');
    expect(res.body.error).not.toContain('200');
  });
});

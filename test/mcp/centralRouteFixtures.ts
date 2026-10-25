// test/mcp/centralRouteFixtures.ts — what the central route tests share: a data folder whose saved
// workspace gives the rooms mirror one room, the real apiRouter behind a local HTTP server, and
// request helpers. Each test file keeps its own vi.mock block (mocks are hoisted per file): nothing
// here starts a process or a PTY.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

/** The one room the saved workspace has, so a room central for it starts. */
export const ROOM_ID = 'room-central-ops';

/** How a request presents as a remote device: a forwarding header (requestLocality.ts). */
export const REMOTE = { 'X-Forwarded-For': '203.0.113.9' };

/** An id a Claude session reports: the shape a restart and a resume need. */
export const uuidFor = (n: number): string =>
  `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`;

/**
 * A fresh data folder (APP_USER_DATA) whose saved workspace has ROOM_ID. The rooms mirror seeds from
 * that file the first time it is read, so it must be set before apiRouter is imported.
 */
export function makeDataDir(): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'aasc-central-routes-'));
  const snapshot = {
    version: 1,
    exportedAt: 0,
    sessions: [],
    rooms: [{ id: ROOM_ID, name: 'Ops', sessionIds: [], collapsed: false, createdAt: 0 }],
  };
  writeFileSync(join(dir, 'workspace-snapshot.json'), JSON.stringify(snapshot));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface ApiServer {
  call: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; json: Record<string, unknown> }>;
  close: () => Promise<void>;
}

/** The real apiRouter on a loopback port. Imported here, after the caller's mocks and data folder. */
export async function startApi(): Promise<ApiServer> {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  const { default: apiRouter } = await import('../../server/apiRouter.js');
  app.use('/api', apiRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    async call(method, path, body, headers = {}) {
      const res = await fetch(`${baseUrl}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: res.status,
        json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

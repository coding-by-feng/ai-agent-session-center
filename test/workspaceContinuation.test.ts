import { afterEach, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceContinuationRouter } from '../server/workspaceContinuation.js';

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function fixture(directory = mkdtempSync(join(tmpdir(), 'aasc-continuation-'))) {
  directories.push(directory);
  const visible = new Set(['session-a', 'session-b']);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/workspace/continuation',
    createWorkspaceContinuationRouter({
      directory,
      scope: (req) =>
        req.headers.authorization === 'Bearer a'
          ? 'owner-a'
          : req.headers.authorization === 'Bearer b'
            ? 'owner-b'
            : null,
      visible: (_req, id) => visible.has(id),
    }),
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/workspace/continuation`;
  const call = async (body?: unknown, owner = 'a') => {
    const r = await fetch(url, {
      method: body ? 'PUT' : 'GET',
      headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    return {
      status: r.status,
      data: r.headers.get('content-type')?.includes('application/json')
        ? JSON.parse(text)
        : { error: text },
    };
  };
  return { directory, visible, call };
}
const draft = (text: string) => ({
  text,
  images: [{ name: 'shot.png', dataUrl: 'data:image/png;base64,YQ==' }],
  type: 'once',
  intervalValue: 1,
  intervalUnit: 'min',
  runAt: '',
});
const snapshot = (sourceId: string, text: string) => ({
  sourceId,
  selectedSessionId: 'session-a',
  drafts: [{ sessionId: 'session-a', draft: draft(text) }],
  revision: 0,
});

it('durably continues a visible session and image draft without touching runtime sessions', async () => {
  const f = await fixture();
  const result = await f.call(snapshot('window-a', 'unfinished'));
  expect(result.status).toBe(200);
  const restarted = await fixture(f.directory);
  const records = (await restarted.call()).data.records;
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    sourceId: 'window-a',
    selectedSessionId: 'session-a',
    drafts: snapshot('window-a', 'unfinished').drafts,
    revision: 1,
  });
  expect([...f.visible]).toEqual(['session-a', 'session-b']);
  expect((await f.call(undefined, 'b')).data.records).toEqual([]);
  expect((await f.call(undefined, 'anonymous')).status).toBe(401);
});
it('keeps conflicting windows and rejects stale revisions or hidden session writes', async () => {
  const f = await fixture();
  await f.call(snapshot('window-a', 'first'));
  await f.call(snapshot('window-b', 'second'));
  expect((await f.call(snapshot('window-a', 'stale'))).status).toBe(409);
  expect((await f.call()).data.records).toHaveLength(2);
  expect(
    (await f.call({ ...snapshot('foreign', 'hidden'), selectedSessionId: 'private' })).status,
  ).toBe(404);
  f.visible.delete('session-a');
  expect((await f.call()).data.records).toEqual([]);
});
it('adopts an unchanged predecessor atomically but preserves a newer draft', async () => {
  const f = await fixture();
  await f.call(snapshot('old', 'first'));
  const adopted = await f.call({
    ...snapshot('new', 'first'),
    adopt: [{ sourceId: 'old', revision: 1 }],
  });
  expect(adopted.status).toBe(200);
  expect((await f.call()).data.records.map((r: { sourceId: string }) => r.sourceId)).toEqual([
    'new',
  ]);
  await f.call({ ...snapshot('new', 'changed elsewhere'), revision: 1 });
  await f.call({ ...snapshot('third', 'first'), adopt: [{ sourceId: 'new', revision: 1 }] });
  expect((await f.call()).data.records).toHaveLength(2);
  expect(
    (
      await f.call({
        ...snapshot('bad', 'x'),
        drafts: [
          {
            sessionId: 'session-a',
            draft: { ...draft('x'), images: [{ name: 'x', dataUrl: 'https://foreign/secret' }] },
          },
        ],
      })
    ).status,
  ).toBe(400);
});

it('protects an edition handoff from another window adopting it before the destination reads it', async () => {
  const f = await fixture();
  expect((await f.call({ ...snapshot('switching', 'own draft'), handoff: true })).status).toBe(200);
  const adoption = {
    ...snapshot('other', 'own draft'),
    adopt: [{ sourceId: 'switching', revision: 1 }],
  };
  expect((await f.call(adoption)).status).toBe(200);
  expect(
    (await f.call()).data.records.some((r: { sourceId: string }) => r.sourceId === 'switching'),
  ).toBe(true);
  expect(
    (
      await f.call({
        ...snapshot('destination', 'own draft'),
        adopt: adoption.adopt,
        resumeSourceId: 'switching',
      })
    ).status,
  ).toBe(200);
  expect(
    (await f.call()).data.records.some((r: { sourceId: string }) => r.sourceId === 'switching'),
  ).toBe(false);
});

import express from 'express';
import { request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import { config } from '../server/serverConfig.js';
import { createToken, removeToken } from '../server/authManager.js';
import { createCloudTransport } from '../server/cloud/client.js';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createNotesRouter,
  notesJsonParser,
  notesErrorHandler,
} from '../server/cloud/notesRouter.js';
import { authMiddleware } from '../server/authManager.js';
import { createResourceRouter } from '../server/resourceRouter.js';
import type { CloudConnector } from '../server/cloud/types.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});
async function setup(remote = false) {
  const request = vi.fn().mockResolvedValue({ records: [], cursor: 'cursor', hasMore: false });
  const cloud = {
    client: { request },
    status: () => ({
      connection: {
        backendOrigin: 'https://cloud.example',
        accountId: 'owner',
        generation: 2,
        deviceId: 'private-device',
        deviceName: 'private-name',
      },
      state: 'offline',
      lastError: 'private-error',
    }),
  } as unknown as CloudConnector;
  const app = express();
  if (remote)
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: '192.0.2.1' });
      next();
    });
  app.use('/api/cloud/skill-notes', notesJsonParser());
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/cloud/skill-notes', authMiddleware, createNotesRouter(cloud));
  app.use('/api/cloud/skill-notes', notesErrorHandler);
  app.use(
    '/api/resources',
    authMiddleware,
    createResourceRouter({ sessionProjectPaths: () => [], cloud, isLocalRequest: () => false }),
  );
  const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, request, cloud };
}
it('notes bootstrap exposes only safe identity and availability', async () => {
  const f = await setup();
  const response = await fetch(f.url + '/api/cloud/skill-notes/status');
  expect(await response.json()).toEqual({
    success: true,
    data: {
      connection: { backendOrigin: 'https://cloud.example', accountId: 'owner', generation: 2 },
      state: 'offline',
    },
  });
});
it('remote_notes_user_cannot_install', async () => {
  const f = await setup();
  expect((await fetch(f.url + '/api/resources/cloud/status')).status).toBe(404);
  expect((await fetch(f.url + '/api/cloud/skill-notes/install', { method: 'POST' })).status).toBe(
    404,
  );
  expect(f.request).not.toHaveBeenCalled();
});
it('remote_without_password_denied', async () => {
  const f = await setup(true);
  expect((await fetch(f.url + '/api/cloud/skill-notes/status')).status).toBe(403);
  expect(f.request).not.toHaveBeenCalled();
});

const headers = {
  'content-type': 'application/json',
  'x-aasc-notes-backend': 'https://cloud.example',
  'x-aasc-notes-account': 'owner',
  'x-aasc-notes-generation': '2',
};
const op = {
  mutationId: '00000000-0000-4000-8000-000000000001',
  key: 'claude:x',
  baseVersion: null,
  set: { fav: true },
};
it('authenticated remote can read notes but cannot configure/install', async () => {
  const before = config.passwordHash;
  config.passwordHash = 'fixture-enabled';
  const token = createToken();
  try {
    const f = await setup(true);
    const auth = { authorization: 'Bearer ' + token };
    expect((await fetch(f.url + '/api/cloud/skill-notes/status', { headers: auth })).status).toBe(
      200,
    );
    expect(
      (await fetch(f.url + '/api/cloud/skill-notes', { headers: { ...headers, ...auth } })).status,
    ).toBe(200);
    expect((await fetch(f.url + '/api/resources/cloud/status', { headers: auth })).status).toBe(
      404,
    );
    expect(
      (
        await fetch(f.url + '/api/resources/install', {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
  } finally {
    config.passwordHash = before;
    removeToken(token);
  }
});
it('stale account, generation and forged identity cannot select backend credentials', async () => {
  const f = await setup();
  for (const patch of [
    { 'x-aasc-notes-account': 'other' },
    { 'x-aasc-notes-generation': '1' },
    { 'x-aasc-notes-generation': '02' },
    { 'x-aasc-notes-backend': 'https://evil.example' },
  ]) {
    const res = await fetch(f.url + '/api/cloud/skill-notes/batch', {
      method: 'POST',
      headers: { ...headers, ...patch },
      body: JSON.stringify({ ops: [op] }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('connection_changed');
  }
  expect(f.request).not.toHaveBeenCalled();
});
it('connection is rechecked immediately before forwarding', async () => {
  const f = await setup();
  let reads = 0;
  f.cloud.status = () => ({
    connection: {
      backendOrigin: 'https://cloud.example',
      accountId: ++reads === 1 ? 'owner' : 'different',
      generation: 2,
      deviceId: 'x',
      deviceName: 'x',
    },
    state: 'connected',
    lastError: null,
  });
  const response = await fetch(f.url + '/api/cloud/skill-notes', { headers });
  expect(response.status).toBe(409);
  expect(f.request).not.toHaveBeenCalled();
});
it('strict schemas and same-origin writes reject extra account/payload or cross-origin requests', async () => {
  const f = await setup();
  for (const body of [
    { ops: [{ ...op, path: '/private' }] },
    { ops: [op], accountId: 'other' },
    { ops: [] },
  ])
    expect(
      (
        await fetch(f.url + '/api/cloud/skill-notes/batch', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(400);
  expect(
    (
      await fetch(f.url + '/api/cloud/skill-notes/batch', {
        method: 'POST',
        headers: { ...headers, origin: 'https://evil.example' },
        body: JSON.stringify({ ops: [op] }),
      })
    ).status,
  ).toBe(403);
  expect(f.request).not.toHaveBeenCalled();
});
it('exact canonical paths and fixed per-op messages, malformed successes rejected', async () => {
  const f = await setup();
  await fetch(f.url + '/api/cloud/skill-notes/export?limit=20&since=opaque', { headers });
  expect(f.request.mock.calls[0][1]).toBe('/v1/skill-notes/export?limit=20&since=opaque');
  f.request.mockResolvedValue({
    results: [
      { mutationId: op.mutationId, error: { code: 'version_conflict', message: 'SECRET' } },
    ],
  });
  const result = await fetch(f.url + '/api/cloud/skill-notes/batch', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ops: [op] }),
  });
  expect(result.status).toBe(200);
  expect(JSON.stringify(await result.json())).not.toContain('SECRET');
  f.request.mockResolvedValue({
    results: [{ mutationId: op.mutationId, error: { code: 'made_up', message: 'SECRET' } }],
  });
  expect(
    (
      await fetch(f.url + '/api/cloud/skill-notes/batch', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ops: [op] }),
      })
    ).status,
  ).toBe(502);
});
async function chunked(url: string, body: string | Buffer, encoding?: string) {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'transfer-encoding': 'chunked',
          ...(encoding ? { 'content-encoding': encoding } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
it.each([
  ['whitespace', ' '.repeat(1048577) + '{}', undefined],
  ['duplicate keys', '{' + '"x":0,'.repeat(180000) + '"x":0}', undefined],
  ['gzip', gzipSync(' '.repeat(1048577) + '{}'), 'gzip'],
] as const)(
  'raw/decompressed prefix cap rejects %s before global parser and any operations',
  async (_name, body, encoding) => {
    const f = await setup();
    expect(await chunked(f.url + '/api/cloud/skill-notes/batch', body, encoding)).toBe(413);
    expect(f.request).not.toHaveBeenCalled();
  },
);
it('production notes cap precedes consuming global parser', async () => {
  const source = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8');
  expect(source.indexOf("app.use('/api/cloud/skill-notes', notesJsonParser())")).toBeLessThan(
    source.indexOf("app.use(express.json({ limit: '50mb' }))"),
  );
});
it('top-level transport codes are allowlisted and upstream messages discarded', async () => {
  for (const [status, code] of [
    [400, 'invalid_cursor'],
    [413, 'batch_too_large'],
    [409, 'version_conflict'],
    [429, 'rate_limited'],
  ] as const) {
    const transport = createCloudTransport({
      fetch: async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: { code, message: 'SECRET', details: '/private' },
          }),
          { status },
        ),
    });
    await expect(
      transport.send('https://cloud.example', 'POST', '/v1/skill-notes/batch'),
    ).rejects.toMatchObject({ code, status });
    try {
      await transport.send('https://cloud.example', 'POST', '/v1/skill-notes/batch');
    } catch (e) {
      expect(String(e)).not.toContain('SECRET');
    }
  }
  const bad = createCloudTransport({
    fetch: async () =>
      new Response(
        JSON.stringify({ success: false, error: { code: 'private', message: 'SECRET' } }),
        { status: 400 },
      ),
  });
  await expect(bad.send('https://cloud.example', 'GET', '/v1/skill-notes')).rejects.toMatchObject({
    code: 'backend_error',
  });
});

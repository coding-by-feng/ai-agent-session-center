import { beforeEach, afterEach, it, expect } from 'vitest';
import express from 'express';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCloudAliases } from '../server/cloud/aliases.js';
import { createCloudAliasesRouter } from '../server/cloud/aliasRouter.js';
import { isLocalResourceRequest, isSameOriginWrite } from '../server/resourceRouter.js';
import type { CloudConnector } from '../server/cloud/types.js';
let server: Server, base: string, home: string, sends: number;
const identity = {
  backendOrigin: 'https://example.test',
  accountId: '11111111-1111-4111-8111-111111111111',
  generation: 1,
};
const headers = {
  'content-type': 'application/json',
  'x-aasc-notes-backend': identity.backendOrigin,
  'x-aasc-notes-account': identity.accountId,
  'x-aasc-notes-generation': '1',
};
beforeEach(async () => {
  sends = 0;
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-alias-http-')));
  mkdirSync(join(home, '.claude'));
  const cloud = {
    status: () => ({ connection: identity, state: 'connected' }),
    onStop: () => () => {},
    client: {
      request: async () => {
        sends++;
        return { records: [], cursor: 'end', hasMore: false };
      },
    },
  } as unknown as CloudConnector;
  const service = await createCloudAliases({
    cloud,
    home,
    directory: join(home, 'private'),
    catalog: () => ({ state: 'ready', resources: [] }),
  });
  const app = express();
  app.use((req, res, next) => (isLocalResourceRequest(req) ? next() : res.status(404).end()));
  app.use(express.json({ limit: '50mb' }));
  app.use(
    '/api/resources/cloud/aliases',
    createCloudAliasesRouter(async () => service, isSameOriginWrite),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/resources/cloud/aliases`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});
const post = (path: string, body: unknown, h: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { ...headers, ...h }, body: JSON.stringify(body) });
it('only note keys can cross reconcile/preview boundary', async () => {
  expect(
    (await post('/preview', { keys: ['claude:x'], notes: {}, allowWrites: true })).status,
  ).toBe(400);
  expect(sends).toBe(0);
});
it('status and preview enforce same-origin boundary', async () => {
  expect(
    (await post('/status', { keys: ['claude:x'] }, { 'sec-fetch-site': 'same-site' })).status,
  ).toBe(403);
  expect(
    (await post('/preview', { keys: ['claude:x'] }, { origin: 'http://localhost:9999' })).status,
  ).toBe(403);
  expect(sends).toBe(0);
});
it('rebinding host and remote status cannot inspect local aliases', async () => {
  const status = await new Promise<number>((resolve) => {
    const r = httpRequest(
      base + '/status',
      { method: 'POST', headers: { ...headers, host: 'attacker.example' } },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    r.end(JSON.stringify({ keys: ['claude:x'] }));
  });
  expect(status).toBe(404);
  expect(sends).toBe(0);
});
it('stale account preconditions make zero backend calls', async () => {
  expect(
    (
      await post(
        '/preview',
        { keys: ['claude:x'] },
        { 'x-aasc-notes-account': '22222222-2222-4222-8222-222222222222' },
      )
    ).status,
  ).toBe(409);
  expect(sends).toBe(0);
});
it('reconcile requires the keys and review token', async () => {
  const p = await post('/preview', { keys: ['claude:x'] });
  expect(p.status).toBe(200);
  const json = await p.json();
  expect(
    (
      await post('/reconcile', {
        keys: ['claude:x'],
        reviewId: json.data.reviewId,
        allowWrites: true,
      })
    ).status,
  ).toBe(400);
  expect(
    (await post('/reconcile', { keys: ['claude:x'], reviewId: json.data.reviewId })).status,
  ).toBe(200);
});
it('Resources constructor exposes a typed lazy instance without storage or network work', async () => {
  const { createResourceRouter } = await import('../server/resourceRouter.js');
  let factory:
    | (() => Promise<import('../server/cloud/aliases.js').CloudAliasesService>)
    | undefined;
  const cloud = {
    status: () => ({ connection: identity, state: 'connected' }),
    onStop: () => () => {},
    client: {
      request: async () => {
        sends++;
        return { records: [], cursor: 'end', hasMore: false };
      },
    },
  } as unknown as CloudConnector;
  const directory = join(home, 'lazy-private');
  const { existsSync } = await import('node:fs');
  createResourceRouter({
    cloud,
    cloudAliasDirectory: directory,
    home,
    env: { HOME: home },
    sessionProjectPaths: () => [],
    onCloudAliasesReady: (get) => {
      factory = get;
    },
  });
  expect(typeof factory).toBe('function');
  expect(existsSync(directory)).toBe(false);
  expect(sends).toBe(0);
});

it('alias bodies are capped at 64 KB ahead of the 1 MB cloud and 50 MB global parsers', async () => {
  const { aliasJsonParser } = await import('../server/cloud/aliasRouter.js');
  const { cloudJsonParser } = await import('../server/cloud/router.js');
  const { createResourceRouter, resourceErrorHandler } = await import('../server/resourceRouter.js');
  const cloud = {
    status: () => ({ connection: identity, state: 'connected' }),
    onStop: () => () => {},
    client: { request: async () => { sends++; return { records: [], cursor: 'end', hasMore: false }; } },
  } as unknown as CloudConnector;
  const app = express();
  app.use('/api/resources/cloud/aliases', aliasJsonParser());
  app.use('/api/resources/cloud', cloudJsonParser());
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/resources', createResourceRouter({ cloud, cloudAliasDirectory: join(home, 'cap-private'), home, env: { HOME: home }, sessionProjectPaths: () => [] }));
  app.use('/api/resources', resourceErrorHandler);
  const capped = createServer(app);
  await new Promise<void>((resolve) => capped.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(capped.address() as { port: number }).port}/api/resources/cloud/aliases/status`;
    const big = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ keys: ['claude:review'], pad: 'x'.repeat(70 * 1024) }) });
    expect(big.status).toBe(413);
    expect(sends).toBe(0);
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8');
    const aliasCap = source.indexOf("app.use('/api/resources/cloud/aliases', aliasJsonParser())");
    const cloudCap = source.indexOf("app.use('/api/resources/cloud', cloudJsonParser())");
    expect(aliasCap).toBeGreaterThan(0);
    expect(aliasCap).toBeLessThan(cloudCap);
    expect(cloudCap).toBeLessThan(source.indexOf("app.use(express.json({ limit: '50mb' }))"));
  } finally {
    await new Promise<void>((resolve) => capped.close(() => resolve()));
  }
});

// test/mcp/cloudRoutesOnBranch.test.ts — how this branch's real cloud routers answer the eight routes that exist only in
// the main checkout (plan 2026-10-25 P6-11): each must read as a missing route, so a P6 tool says UNAVAILABLE instead of
// misreading it. The routers are mounted as server/resourceRouter.ts mounts them (aliases first, then projects, resource
// jobs and the connection router), behind an Express app whose last handler answers 404 with a page, as Express's own
// does. They are handed stub services that refuse to be built and a connector that only says its status: no job store,
// git, file system or backend exists here. The app listens on 127.0.0.1 only, and the one client is AASC's own loopback
// client pointed at it.
import express from 'express';
import { createServer, type Server } from 'http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCloudAliasesRouter } from '../../server/cloud/aliasRouter.js';
import { createProjectRouter } from '../../server/cloud/projectRouter.js';
import { createResourceJobsRouter } from '../../server/cloud/resourceRouter.js';
import { createCloudRouter } from '../../server/cloud/router.js';
import type { CloudConnector } from '../../server/cloud/types.js';
import { createInternalClient, type InternalClient, type InternalResponse } from '../../server/mcp/client.js';
import { bindingHeaders, cloudRouteMissing } from '../../server/mcp/tools/cloudCall.js';
import { routeMissing } from '../../server/mcp/tools/shape.js';
import { CONNECTION, PROJECT_ID, RESOURCE_ID } from './cloudFixtures.js';
import { MISSING } from './cloudMainShapes.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

let server: Server | null = null;
let port = 0;
let serviceAsks = 0;

/**
 * A service that does nothing: every method is counted and refused. It is handed out (not refused) because a route
 * such as `GET /projects/:id` awaits its service before it checks the id, as the real one would be built.
 */
const noService = async <T>(): Promise<T> =>
  new Proxy(
    {},
    {
      // Not a promise: `await` asks for `then`.
      get: (_target, name) =>
        name === 'then'
          ? undefined
          : () => {
              serviceAsks += 1;
              throw new Error('No cloud service exists in this probe');
            },
    },
  ) as T;

/** The connection router reads only `status()` before its write checks; nothing else is called on the paths below. */
const connector = {
  status: () => ({ state: 'connected', connection: CONNECTION, lastError: null }),
} as unknown as CloudConnector;

const sameOrigin = (): boolean => true;

beforeAll(async () => {
  const app = express();
  app.use('/api/resources/cloud/aliases', createCloudAliasesRouter(noService, sameOrigin));
  app.use('/api/resources/cloud', createProjectRouter(noService, sameOrigin));
  app.use('/api/resources/cloud', createResourceJobsRouter(noService, sameOrigin));
  app.use('/api/resources/cloud', createCloudRouter(connector, sameOrigin));
  // As Express's own last handler: a page, no JSON.
  app.use((req, res) => {
    res.status(404).type('html').send(`<!DOCTYPE html><html><body><pre>Cannot ${req.method} ${req.path}</pre></body></html>`);
  });
  server = createServer(app);
  await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('The probe app did not start');
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
});

const client = (): InternalClient => createInternalClient({ port: () => port, clientId: 'mcp:probe', authToken: () => null });
const options = () => ({ headers: bindingHeaders(CONNECTION) });

const MAIN_ONLY: Array<[string, () => Promise<InternalResponse<unknown>>]> = [
  ['POST sync-now', () => client().post('/resources/cloud/sync-now', {}, options())],
  ['POST sync-control', () => client().post('/resources/cloud/sync-control', { resourceId: RESOURCE_ID, action: 'stop' }, options())],
  ['GET sync-status', () => client().get('/resources/cloud/sync-status', undefined, options())],
  ['POST projects/<id>/remove', () => client().post(`/resources/cloud/projects/${PROJECT_ID}/remove`, {}, options())],
  ['POST projects/<id>/check', () => client().post(`/resources/cloud/projects/${PROJECT_ID}/check`, {}, options())],
  ['POST projects/<id>/push', () => client().post(`/resources/cloud/projects/${PROJECT_ID}/push`, {}, options())],
  ['PUT projects/<id>/account', () => client().put(`/resources/cloud/projects/${PROJECT_ID}/account`, { login: 'octo-cat' }, options())],
  ['POST remote-access/refresh', () => client().post('/resources/cloud/remote-access/refresh', {}, options())],
];

describe('each main-only path through the branch’s real routers is a missing route', () => {
  it.each(MAIN_ONLY)('%s', async (_name, call) => {
    const before = serviceAsks;

    const answer = await call();

    expect(routeMissing(answer)).toBe(true);
    expect(cloudRouteMissing(answer)).toBe(true);
    expect(serviceAsks).toBe(before);
  });

  it('GET projects/candidates is 400 invalid_request, which cloudRouteMissing reads as missing', async () => {
    const answer = await client().get('/resources/cloud/projects/candidates', undefined, options());

    expect(answer.status).toBe(400);
    expect(routeMissing(answer)).toBe(false);
    expect(cloudRouteMissing(answer)).toBe(true);
  });

  it('MISSING’s notFound, media and idClash are what the branch answers', async () => {
    expect(await client().post('/resources/cloud/sync-now', {}, options())).toEqual(MISSING.notFound);
    expect(await client().get('/resources/cloud/sync-status', undefined, options())).toEqual(MISSING.media);
    expect(await client().get('/resources/cloud/projects/candidates', undefined, options())).toEqual(MISSING.idClash);
  });

  it('nothing asked for a service', () => {
    expect(serviceAsks).toBe(0);
  });
});

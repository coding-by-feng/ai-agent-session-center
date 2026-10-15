import { afterEach, it, expect } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { projectFixture } from './cloudProjectsFixture.js';
import { createProjectRouter } from '../server/cloud/projectRouter.js';
import { CloudError } from '../server/cloud/types.js';
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
async function fixture() {
  const f = await projectFixture();
  const app = express();
  app.use(
    '/cloud',
    createProjectRouter(
      async () => f.service,
      () => true,
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return {
    ...f,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/cloud`,
    headers: {
      'content-type': 'application/json',
      'x-aasc-cloud-backend': f.binding.backendOrigin,
      'x-aasc-cloud-account': f.binding.accountId,
      'x-aasc-cloud-generation': String(f.binding.generation),
    },
  };
}
it('stale A browser/new B connector rejects before wrong-account outbound', async () => {
  const f = await fixture();
  f.switchProjectAccount();
  const r = await fetch(f.url + '/projects', { headers: f.headers });
  expect(r.status).toBe(409);
  expect((await r.json()).error.code).toBe('connection_changed');
  expect(f.calls).toHaveLength(0);
});
it('stale project edit remains an actionable safe conflict', async () => {
  const f = await fixture();
  f.cloud.client.request = async () => {
    throw new CloudError(
      'version_conflict',
      'Cloud version changed. Review the latest version.',
      409,
      { headVersion: 5 },
    );
  };
  const r = await fetch(f.url + '/projects/' + f.project.id, {
    method: 'PUT',
    headers: f.headers,
    body: JSON.stringify({ mutationId: randomUUID(), baseVersion: 1, value: f.project }),
  });
  expect(r.status).toBe(409);
  expect(await r.json()).toMatchObject({
    success: false,
    error: { code: 'version_conflict', details: { headVersion: 5 } },
  });
});
it('routes reject origin mismatch and arbitrary command fields', async () => {
  const f = await fixture();
  const r = await fetch(f.url + `/projects/${f.project.id}/get`, {
    method: 'POST',
    headers: { ...f.headers, origin: 'https://evil.example' },
    body: '{}',
  });
  expect(r.status).toBe(403);
  const bad = await fetch(f.url + `/projects/${f.project.id}/get`, {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({
      parentPath: f.home,
      directoryName: 'x',
      transport: 'https',
      resourceVersions: [],
      command: 'git evil',
    }),
  });
  expect(bad.status).toBe(400);
  expect(f.calls).toHaveLength(0);
});
it('real transport project conflict strips hostile upstream text and keeps exact revision', async () => {
  const f = await fixture();
  const { createCloudTransport } = await import('../server/cloud/client.js');
  const t = createCloudTransport({
    fetch: async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'version_conflict',
            message: 'token=secret https://credential@evil.example',
            details: { headVersion: 9 },
          },
        }),
        { status: 409 },
      ),
  });
  f.cloud.client.request = async (method, path, body) =>
    t.send('https://cloud.example', method, path, body);
  const r = await fetch(f.url + '/projects/' + f.project.id, {
    method: 'PUT',
    headers: f.headers,
    body: JSON.stringify({ mutationId: randomUUID(), baseVersion: 1, value: f.project }),
  });
  const body = await r.json();
  expect(r.status).toBe(409);
  expect(body.error).toMatchObject({ code: 'version_conflict', details: { headVersion: 9 } });
  expect(JSON.stringify(body)).not.toMatch(/secret|credential|evil/);
});

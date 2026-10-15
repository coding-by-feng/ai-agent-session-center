import { afterEach, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createResourceJobsRouter } from '../server/cloud/resourceRouter.js';
import { cloudFixture } from './cloudPackagesFixture.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
async function fixture() {
  const f = await cloudFixture();
  cleanups.push(() => f.cleanup());
  const app = express();
  app.use(
    '/cloud',
    createResourceJobsRouter(
      async () => f.jobs,
      () => true,
    ),
  );
  let server: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const url = `http://127.0.0.1:${(server!.address() as { port: number }).port}/cloud`;
  const headers = {
    'content-type': 'application/json',
    'x-aasc-cloud-backend': f.binding.backendOrigin,
    'x-aasc-cloud-account': f.binding.accountId,
    'x-aasc-cloud-generation': String(f.binding.generation),
  };
  return { ...f, url, headers };
}
it('strict stale binding and unknown request fields reject before outbound work', async () => {
  const f = await fixture();
  f.switchAccount();
  const response = await fetch(f.url + '/publish-plans', {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({ selection: [] }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    success: false,
    error: { code: 'connection_changed' },
  });
  expect(f.calls).toHaveLength(0);
});
it('rejects non-json and unreviewed local destination fields; exposes typed jobs and no private paths', async () => {
  const f = await fixture();
  const bad = await fetch(f.url + '/install-plans', {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({ resourceId: f.binding.accountId, version: 1, path: '/tmp/arbitrary' }),
  });
  expect(bad.status).toBe(400);
  const noJson = await fetch(f.url + '/downloads', { method: 'POST', body: '{}' });
  expect(noJson.status).toBe(415);
  const plan = await fetch(f.url + '/publish-plans', {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({ selection: [{ resourceId: f.resource.summary.id, include: true }] }),
  });
  expect(plan.status).toBe(200);
  const body = await plan.json();
  expect(JSON.stringify(body)).not.toContain(f.home);
  const run = await fetch(f.url + `/publish-plans/${body.data.id}/run`, {
    method: 'POST',
    headers: f.headers,
    body: '{}',
  });
  expect(run.status).toBe(200);
  const job = await run.json();
  await f.jobs.wait(job.data.id);
  const read = await fetch(f.url + `/jobs/${job.data.id}`);
  expect(read.status).toBe(200);
  expect(JSON.stringify(await read.json())).not.toContain(f.home);
});

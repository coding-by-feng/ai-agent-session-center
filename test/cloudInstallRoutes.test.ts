import { afterEach, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createResourceJobsRouter } from '../server/cloud/resourceRouter.js';
import { cloudFixture } from './cloudPackagesFixture.js';
import { sqliteIt } from './helpers/nativeSqlite.js';
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
sqliteIt('strict stale binding and unknown request fields reject before outbound work', async () => {
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
sqliteIt('rejects non-json and unreviewed local destination fields; exposes typed jobs and no private paths', async () => {
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
  const read = await fetch(f.url + `/jobs/${job.data.id}`, { headers: f.headers });
  expect(read.status).toBe(200);
  expect(JSON.stringify(await read.json())).not.toContain(f.home);
});
const bound = (b: { backendOrigin: string; accountId: string; generation: number }) => ({
  'content-type': 'application/json',
  'x-aasc-cloud-backend': b.backendOrigin,
  'x-aasc-cloud-account': b.accountId,
  'x-aasc-cloud-generation': String(b.generation),
});
sqliteIt('job read and cancel answer only the reviewed account; a missing binding or another account is a 404', async () => {
  const f = await fixture();
  const plan = await f.jobs.buildPublicationPlan(
    [{ resourceId: f.resource.summary.id, include: true }],
    f.binding,
  );
  const job = await f.jobs.publishPlan(plan.id, f.binding);
  await f.jobs.wait(job.id);
  const read = (headers: Record<string, string>) => fetch(f.url + `/jobs/${job.id}`, { headers });
  const cancel = (headers: Record<string, string>) =>
    fetch(f.url + `/jobs/${job.id}/cancel`, { method: 'POST', headers, body: '{}' });
  // No binding, or a malformed one: indistinguishable from an unknown job.
  for (const headers of [
    { 'content-type': 'application/json' },
    { ...f.headers, 'x-aasc-cloud-generation': 'one' },
  ]) {
    for (const response of [await read(headers), await cancel(headers)]) {
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe('not_found');
    }
  }
  const unknown = await fetch(f.url + `/jobs/${f.binding.accountId}`, { headers: f.headers });
  expect(unknown.status).toBe(404);
  expect((await read(f.headers)).status).toBe(200);
  // The same account paired again: its older job stays readable and cancellable.
  const again = f.reconnectSameAccount();
  expect((await read(f.headers)).status).toBe(409);
  expect((await read(bound(again))).status).toBe(200);
  expect((await cancel(bound(again))).status).toBe(200);
  // Another account, connected now: the job does not exist for it.
  const otherAccount = f.switchAccount();
  const other = await read(bound(otherAccount));
  expect(other.status).toBe(404);
  expect((await other.json()).error.code).toBe('not_found');
  expect((await cancel(bound(otherAccount))).status).toBe(404);
  const retry = await fetch(f.url + `/jobs/${job.id}/retry`, {
    method: 'POST',
    headers: bound(otherAccount),
    body: '{}',
  });
  expect(retry.status).toBe(404);
  expect((await retry.json()).error.code).toBe('not_found');
  // A stale review of the first account is a changed connection, never the job.
  const stale = await read(bound(again));
  expect(stale.status).toBe(409);
  expect(JSON.stringify(await stale.json())).not.toContain(job.id);
});

// AASC-62: the sync list and Sync now go through the same gate, binding and envelope.
sqliteIt('serves the sync status and Sync now, refusing a stale binding and unknown fields first', async () => {
  const f = await fixture();
  const plan = await f.jobs.buildPublicationPlan(
    [{ resourceId: f.resource.summary.id, include: true }],
    f.binding,
  );
  await f.jobs.wait((await f.jobs.publishPlan(plan.id, f.binding)).id);
  const status = await fetch(f.url + '/sync-status', { headers: f.headers });
  expect(status.status).toBe(200);
  const body = await status.json();
  expect(body).toMatchObject({
    success: true,
    data: { waiting: 0, items: [{ name: 'demo', state: 'synced', cloudVersion: 1 }] },
  });
  expect(JSON.stringify(body)).not.toContain(f.home);
  const unknown = await fetch(f.url + '/sync-now', {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({ choices: {}, everything: true }),
  });
  expect(unknown.status).toBe(400);
  const nothing = await fetch(f.url + '/sync-now', {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({}),
  });
  expect(await nothing.json()).toEqual({ success: true, data: { jobs: [], skipped: [] } });
  // Oct 23 2026: Stop syncing / Sync again / Remove from cloud, one resource at a time.
  const id = (body as { data: { items: { resourceId: string }[] } }).data.items[0].resourceId;
  const bad = await fetch(f.url + '/sync-control', {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({ resourceId: id, action: 'delete' }),
  });
  expect(bad.status).toBe(400);
  const stop = await fetch(f.url + '/sync-control', {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({ resourceId: id, action: 'stop' }),
  });
  expect(await stop.json()).toEqual({ success: true, data: { resourceId: id, action: 'stop' } });
  expect(
    await (await fetch(f.url + '/sync-status', { headers: f.headers })).json(),
  ).toMatchObject({ data: { waiting: 0, items: [{ name: 'demo', state: 'stopped' }] } });
  const calls = f.calls.length;
  f.switchAccount();
  for (const [path, init] of [
    ['/sync-status', {}],
    ['/sync-now', { method: 'POST', body: '{}' }],
    ['/sync-control', { method: 'POST', body: JSON.stringify({ resourceId: id, action: 'resume' }) }],
  ] as const) {
    const stale = await fetch(f.url + path, { ...init, headers: f.headers });
    expect(stale.status).toBe(409);
  }
  expect(f.calls.length).toBe(calls);
});
sqliteIt('saves the reviewed resources and leaves blocked ones only when asked to', async () => {
  const f = await fixture();
  const plan = await f.jobs.buildPublicationPlan(
    [
      { resourceId: f.resource.summary.id, include: true },
      { resourceId: 'missing-catalog-id', include: true },
    ],
    f.binding,
  );
  // A selected id that isn't in the catalog is simply not visited; make one blocked instead.
  const stored = f.jobs.store.get<{ public: { blocked: unknown[] } }>('publish-plan', plan.id)!;
  stored.public.blocked.push({ catalogId: 'x', reason: 'Blocked for the test.' });
  f.jobs.store.put('publish-plan', plan.id, stored);
  const strict = await fetch(f.url + `/publish-plans/${plan.id}/run`, {
    method: 'POST',
    headers: f.headers,
    body: '{}',
  });
  expect(strict.status).toBe(409);
  const skipping = await fetch(f.url + `/publish-plans/${plan.id}/run`, {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({ skipBlocked: true }),
  });
  expect(skipping.status).toBe(200);
  expect((await skipping.json()).data.kind).toBe('publish');
});

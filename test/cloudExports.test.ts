import { afterEach, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createResourceJobsRouter } from '../server/cloud/resourceRouter.js';
import { EXPORT_TTL_MS, sweepExports } from '../server/cloud/download.js';
import { cloudFixture } from './cloudPackagesFixture.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );
async function publishedDownload() {
  const f = await cloudFixture();
  cleanups.push(() => f.cleanup());
  const plan = await f.jobs.buildPublicationPlan(
    [{ resourceId: f.resource.summary.id, include: true }],
    f.binding,
  );
  await f.jobs.wait((await f.jobs.publishPlan(plan.id, f.binding)).id);
  const ref = { resourceId: plan.items[0].manifest.resourceId, version: 1 };
  const download = await f.jobs.download(ref, f.binding);
  expect((await f.jobs.wait(download.id)).state).toBe('complete');
  const exportsDir = join(f.home, 'private', 'exports');
  return { f, ref, download, exportsDir };
}
async function serve(f: Awaited<ReturnType<typeof cloudFixture>>) {
  const app = express();
  app.use(
    '/cloud',
    createResourceJobsRouter(
      async () => f.jobs,
      () => true,
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/cloud`;
}
const headersFor = (b: { backendOrigin: string; accountId: string; generation: number }) => ({
  'x-aasc-cloud-backend': b.backendOrigin,
  'x-aasc-cloud-account': b.accountId,
  'x-aasc-cloud-generation': String(b.generation),
});

it('a ZIP that streamed completely is deleted with its job folder; asking again is a 404', async () => {
  const { f, download, exportsDir } = await publishedDownload();
  expect(await readdir(exportsDir)).toEqual([download.id]);
  const url = await serve(f);
  // A HEAD request (link preview, download manager probe) never uses up the one save.
  await fetch(`${url}/downloads/${download.id}/file`, {
    method: 'HEAD',
    headers: headersFor(f.binding),
  });
  expect(await readdir(exportsDir)).toEqual([download.id]);
  const first = await fetch(`${url}/downloads/${download.id}/file`, {
    headers: headersFor(f.binding),
  });
  expect(first.status).toBe(200);
  expect(
    Buffer.from(await first.arrayBuffer())
      .subarray(0, 2)
      .toString(),
  ).toBe('PK');
  await expect.poll(() => readdir(exportsDir)).toEqual([]);
  const second = await fetch(`${url}/downloads/${download.id}/file`, {
    headers: headersFor(f.binding),
  });
  expect(second.status).toBe(404);
  expect((await second.json()).error.code).toBe('not_found');
});

it('an export older than the TTL is swept when the jobs reopen and is no longer offered', async () => {
  const { f, download, exportsDir } = await publishedDownload();
  const folder = join(exportsDir, download.id);
  const old = new Date(Date.now() - EXPORT_TTL_MS - 60_000);
  for (const name of await readdir(folder)) await utimes(join(folder, name), old, old);
  await utimes(folder, old, old);
  await f.restartJobs();
  expect(await exists(folder)).toBe(false);
  expect(() => f.jobs.downloadFile(download.id, f.binding)).toThrow(
    expect.objectContaining({ code: 'not_found' }),
  );
});

it('a new download sweeps stale exports first', async () => {
  const { f, ref, download, exportsDir } = await publishedDownload();
  const folder = join(exportsDir, download.id);
  const old = new Date(Date.now() - EXPORT_TTL_MS - 60_000);
  for (const name of await readdir(folder)) await utimes(join(folder, name), old, old);
  await utimes(folder, old, old);
  const next = await f.jobs.download(ref, f.binding);
  await f.jobs.wait(next.id);
  expect(await readdir(exportsDir)).toEqual([next.id]);
});

it('the sweep touches only stale UUID export folders and never follows a link', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aasc-export-sweep-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const exportsDir = join(root, 'exports'),
    outside = join(root, 'outside');
  await mkdir(exportsDir, { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'keep.zip'), 'outside');
  const now = Date.now(),
    old = new Date(now - EXPORT_TTL_MS - 60_000);
  const stale = randomUUID(),
    fresh = randomUUID(),
    linked = randomUUID(),
    odd = randomUUID();
  for (const id of [stale, fresh, odd]) await mkdir(join(exportsDir, id));
  await writeFile(join(exportsDir, stale, `${randomUUID()}.zip`), 'zip');
  await writeFile(join(exportsDir, fresh, `${randomUUID()}.zip`), 'zip');
  // An unexpected entry inside an export folder keeps the folder (nothing guessed away).
  await writeFile(join(exportsDir, odd, 'notes.txt'), 'unexpected');
  await mkdir(join(exportsDir, 'not-a-job'));
  await symlink(outside, join(exportsDir, linked));
  for (const id of [stale, odd, 'not-a-job']) await utimes(join(exportsDir, id), old, old);
  for (const name of await readdir(join(exportsDir, stale)))
    await utimes(join(exportsDir, stale, name), old, old);
  await sweepExports(exportsDir, { now, maxAgeMs: EXPORT_TTL_MS });
  expect(await exists(join(exportsDir, stale))).toBe(false);
  expect(await exists(join(exportsDir, fresh))).toBe(true);
  expect(await readFile(join(exportsDir, odd, 'notes.txt'), 'utf8')).toBe('unexpected');
  expect(await exists(join(exportsDir, 'not-a-job'))).toBe(true);
  expect(await readFile(join(outside, 'keep.zip'), 'utf8')).toBe('outside');
  // An exports folder that is itself a link is not followed at all.
  const linkedRoot = join(root, 'linked-exports');
  await symlink(outside, linkedRoot);
  await sweepExports(linkedRoot, { now: now + 10 * EXPORT_TTL_MS, maxAgeMs: EXPORT_TTL_MS });
  expect(await readFile(join(outside, 'keep.zip'), 'utf8')).toBe('outside');
  // One unreadable export folder does not stop the rest of the sweep.
  const locked = randomUUID(),
    after = randomUUID();
  for (const id of [locked, after]) {
    await mkdir(join(exportsDir, id));
    await writeFile(join(exportsDir, id, `${randomUUID()}.zip`), 'zip');
    for (const name of await readdir(join(exportsDir, id)))
      await utimes(join(exportsDir, id, name), old, old);
    await utimes(join(exportsDir, id), old, old);
  }
  await chmod(join(exportsDir, locked), 0o000);
  try {
    await expect(sweepExports(exportsDir, { now, maxAgeMs: EXPORT_TTL_MS })).resolves.toContain(
      after,
    );
    expect(await exists(join(exportsDir, after))).toBe(false);
  } finally {
    await chmod(join(exportsDir, locked), 0o700);
  }
  // A missing exports folder is simply nothing to sweep.
  await expect(
    sweepExports(join(root, 'missing'), { now, maxAgeMs: EXPORT_TTL_MS }),
  ).resolves.toEqual([]);
});

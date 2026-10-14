import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createResourceRouter } from '../server/resourceRouter.js';
import { memoryStore } from '../server/projectSync/store.js';
import { localLauncher } from '../server/projectSync/helperClient.js';
import { createTransferService } from '../server/resourceTransfers/service.js';
import type { TransferDevice } from '../src/types/resourceTransfers.js';

let base: string, home: string, deviceHome: string;
const servers: Server[] = [];
let device: TransferDevice;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'aasc-sync-router-')));
  home = join(base, 'home');
  deviceHome = join(base, 'device');
  await mkdir(join(home, 'proj'), { recursive: true });
  await mkdir(deviceHome, { recursive: true });
  await writeFile(join(home, 'proj', 'a.txt'), 'a\n');
  device = {
    id: randomUUID(),
    name: 'mini',
    host: 'mini.local',
    username: 'me',
    port: 22,
    fingerprint: 'SHA256:pinned',
    home: deviceHome,
    platform: process.platform,
    checkedAt: 0,
  };
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  await rm(base, { recursive: true, force: true });
});

async function start(local = true) {
  const app = express();
  app.use(
    '/api/resources',
    createResourceRouter({
      home,
      env: {},
      sessionProjectPaths: () => [join(home, 'proj')],
      ...(local ? {} : { isLocalRequest: () => false }),
      transfers: {
        store: { load: async () => null, save: async () => {} },
        fingerprint: async () => 'SHA256:pinned',
      },
      sync: {
        store: memoryStore(),
        devices: async () => [device],
        fingerprint: async () => 'SHA256:pinned',
        launchLocal: localLauncher({ ...process.env, HOME: home }),
        launchDevice: () => localLauncher({ ...process.env, HOME: deviceHome }),
        activeSessionPaths: () => [join(home, 'proj')],
      },
    }),
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api/resources`;
}
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
async function projectId(url: string) {
  for (let i = 0; i < 200; i++) {
    const cat = (await (await fetch(url)).json()).data;
    if (cat.state === 'ready')
      return cat.projects.find((p: { path: string }) => p.path === '~/proj').id as string;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('scan did not finish');
}

describe('project sync HTTP boundary', () => {
  it('is invisible to non-local requests', async () => {
    const url = await start(false);
    expect((await fetch(url + '/sync')).status).toBe(404);
  });
  it('requires JSON and same-origin writes, validates bodies, and answers with envelopes', async () => {
    const url = await start();
    expect((await fetch(url + '/sync/links', { method: 'POST', body: 'x=1' })).status).toBe(415);
    expect((await post(url + '/sync/links', {}, { 'Sec-Fetch-Site': 'same-site' })).status).toBe(
      403,
    );
    const bad = await post(url + '/sync/links', { name: 'x' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ success: false });
    expect(
      (
        await post(url + '/sync/links', {
          name: 'x',
          projectId: 'p',
          deviceId: device.id,
          remoteRoot: '/x',
          excludes: ['!negated'],
          credentialsAck: true,
        })
      ).status,
    ).toBe(400);
    expect((await fetch(url + '/sync/runs/not-a-uuid')).status).toBe(400);
    expect((await fetch(url + `/sync/runs/${randomUUID()}`)).status).toBe(404);
  });
  it('creates a link, compares, pages entries and asks about live sessions over HTTP', async () => {
    const url = await start();
    const pid = await projectId(url);
    const created = await post(url + '/sync/links', {
      name: 'proj',
      projectId: pid,
      deviceId: device.id,
      remoteRoot: join(deviceHome, 'proj'),
      excludes: [],
      credentialsAck: true,
    });
    const linkBody = await created.json();
    expect(linkBody).toMatchObject({ success: true, data: { name: 'proj', state: 'never' } });
    expect(JSON.stringify(linkBody)).not.toContain(join(home, 'proj'));
    const run = (await (await post(url + `/sync/links/${linkBody.data.id}/compare`, {})).json())
      .data;
    let state = run.state;
    for (let i = 0; i < 200 && state === 'comparing'; i++) {
      await new Promise((r) => setTimeout(r, 15));
      state = (await (await fetch(url + `/sync/runs/${run.id}`)).json()).data.state;
    }
    expect(state).toBe('review');
    const page = (
      await (await fetch(url + `/sync/runs/${run.id}/entries?filter=changes&limit=10`)).json()
    ).data;
    expect(page.entries.map((e: { path: string }) => e.path)).toEqual(['a.txt']);
    const live = await post(url + `/sync/runs/${run.id}/run`, {});
    expect(live.status).toBe(409);
    expect(await live.json()).toMatchObject({ code: 'live-sessions' });
  });
  it('never sends unexpected error details to the browser', async () => {
    const app = express();
    app.use(
      '/api/resources',
      createResourceRouter({
        home,
        env: {},
        sessionProjectPaths: () => [],
        sync: {
          store: {
            ...memoryStore(),
            loadLinks: async () => {
              throw new Error('SQLITE_CORRUPT at /Users/secret/path');
            },
          },
          devices: async () => [device],
        },
      }),
    );
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const res = await fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/api/resources/sync`,
    );
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/SQLITE|secret/);
  });
  it('Transfers refuses a project folder kept by a link, and a linked device cannot be removed', async () => {
    const transfers = createTransferService({
      catalog: { getCatalog: () => ({}) as never, transferInternals: () => [] } as never,
      store: {
        load: async () => ({ devices: [device], tasks: [], locations: {} }),
        save: async () => {},
      },
      linkedFolder: (deviceId, folder) =>
        deviceId === device.id && folder.startsWith(join(deviceHome, 'proj')) ? 'proj' : null,
      deviceInUse: (deviceId) => deviceId === device.id,
    });
    await expect(transfers.removeDevice(device.id)).rejects.toThrow(/project link/);
  });
});

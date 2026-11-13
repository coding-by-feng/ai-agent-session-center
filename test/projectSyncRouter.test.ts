import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import log from '../server/logger.js';
import { createResourceRouter } from '../server/resourceRouter.js';
import { memoryStore } from '../server/projectSync/store.js';
import { localLauncher } from '../server/projectSync/helperClient.js';
import type { SyncDevice } from '../src/types/projectSync.js';

let base: string, home: string, deviceHome: string;
const servers: Server[] = [];
let device: SyncDevice;
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
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  await rm(base, { recursive: true, force: true });
});

async function start(local = true, savedServers = true) {
  const app = express();
  app.use(
    '/api/resources',
    createResourceRouter({
      home,
      env: {},
      sessionProjectPaths: () => [join(home, 'proj')],
      ...(local ? {} : { isLocalRequest: () => false }),
      sync: {
        store: memoryStore(),
        // Without the override the store holds the servers, as in production.
        ...(savedServers ? { devices: async () => [device] } : {}),
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
  it('caps a decisions request at 500 entries and 500 groups', async () => {
    const url = await start();
    const many = (n: number, key: (i: number) => string, value: string) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [key(i), value]));
    const decide = `${url}/sync/runs/${randomUUID()}/decisions`;
    expect((await post(decide, { entries: many(501, () => randomUUID(), 'push') })).status).toBe(
      400,
    );
    expect((await post(decide, { groups: many(501, (i) => `g${i}/.git`, 'sync') })).status).toBe(
      400,
    );
    // Within the caps the request is valid, and the unknown run is the answer.
    expect((await post(decide, { entries: many(500, () => randomUUID(), 'push') })).status).toBe(
      404,
    );
    expect((await post(decide, { groups: many(500, (i) => `g${i}/.git`, 'sync') })).status).toBe(
      404,
    );
  });
  it('never sends unexpected error details to the browser, and masks secrets in the log', async () => {
    const logged = vi.spyOn(log, 'error').mockImplementation(() => {});
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
              throw new Error(
                'SQLITE_CORRUPT at /Users/secret/path near DB_PASSWORD=hunter2-not-real',
              );
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
    const line = logged.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(line).toMatch(/SQLITE_CORRUPT/);
    expect(line).not.toMatch(/hunter2/);
  });
  it('adds and removes servers; a server a link uses stays; retired Transfers answers 404', async () => {
    const url = await start(true, false);
    expect((await fetch(url + '/transfers')).status).toBe(404);
    const server = { name: 'mini', host: 'mini.local', username: 'me', port: 22 };
    expect((await post(url + '/sync/devices', { ...server, port: '22' })).status).toBe(400);
    expect(
      (await post(url + '/sync/devices', { ...server, host: '-oProxyCommand=x' })).status,
    ).toBe(400);
    const added = await post(url + '/sync/devices', server);
    expect(added.status).toBe(200);
    const saved = (await added.json()).data;
    expect(saved).toMatchObject({ name: 'mini', home: deviceHome, fingerprint: 'SHA256:pinned' });
    const overview = (await (await fetch(url + '/sync')).json()).data;
    expect(overview.devices.map((d: { id: string }) => d.id)).toEqual([saved.id]);
    const created = await post(url + '/sync/links', {
      name: 'proj',
      projectId: await projectId(url),
      deviceId: saved.id,
      remoteRoot: join(deviceHome, 'proj'),
      excludes: [],
      credentialsAck: true,
      direction: 'two-way',
    });
    expect((await created.json()).data).toMatchObject({ direction: 'two-way' });
    const refused = await post(url + `/sync/devices/${saved.id}/remove`, {});
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/Remove that link first/);
  });
});

describe('project sync HTTP: policy, browse and pulls (Nov 13 2026)', () => {
  it('takes a conflict policy on a link, and refuses an unknown one', async () => {
    const url = await start();
    const pid = await projectId(url);
    const body = {
      name: 'proj',
      projectId: pid,
      deviceId: device.id,
      remoteRoot: join(deviceHome, 'proj'),
      excludes: [],
      credentialsAck: true,
    };
    expect((await post(url + '/sync/links', { ...body, conflictPolicy: 'server' })).status).toBe(
      400,
    );
    const created = (await (await post(url + '/sync/links', { ...body, conflictPolicy: 'local' })).json())
      .data;
    expect(created.conflictPolicy).toBe('local');
    const updated = await post(url + `/sync/links/${created.id}/update`, { conflictPolicy: 'ask' });
    expect((await updated.json()).data.conflictPolicy).toBeUndefined();
  });

  it('browses a saved server folder; paths must be absolute', async () => {
    await mkdir(join(deviceHome, 'data'));
    const url = await start();
    const listed = await (await fetch(url + `/sync/devices/${device.id}/browse`)).json();
    expect(listed).toMatchObject({ success: true, data: { path: deviceHome, parent: null } });
    expect(listed.data.entries.map((e: { name: string }) => e.name)).toEqual(['data']);
    const inner = await fetch(
      url + `/sync/devices/${device.id}/browse?path=${encodeURIComponent(join(deviceHome, 'data'))}`,
    );
    expect((await inner.json()).data.parent).toBe(deviceHome);
    expect(
      (await fetch(url + `/sync/devices/${device.id}/browse?path=relative`)).status,
    ).toBe(400);
    expect((await fetch(url + `/sync/devices/not-a-uuid/browse`)).status).toBe(400);
  });

  it('plans, starts, reads and undoes a pull over HTTP', async () => {
    await mkdir(join(deviceHome, 'data'));
    await writeFile(join(deviceHome, 'data', 'x.txt'), 'x\n');
    const url = await start();
    const pid = await projectId(url);
    expect(
      (await post(url + `/sync/devices/${device.id}/pulls`, { projectId: pid, sources: [] }))
        .status,
    ).toBe(400);
    const planned = await post(url + `/sync/devices/${device.id}/pulls`, {
      projectId: pid,
      sources: [join(deviceHome, 'data')],
    });
    const plan = (await planned.json()).data;
    expect(plan).toMatchObject({ state: 'planned', counts: { new: 1 } });
    expect((await post(url + `/sync/pulls/${plan.id}/start`, {})).status).toBe(200);
    let state = 'running';
    for (let i = 0; i < 200 && state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 15));
      state = (await (await fetch(url + `/sync/pulls/${plan.id}`)).json()).data.state;
    }
    expect(state).toBe('complete');
    const undone = await post(url + `/sync/pulls/${plan.id}/undo`, {});
    expect((await undone.json()).data.state).toBe('undone');
    expect((await fetch(url + `/sync/pulls/${randomUUID()}`)).status).toBe(404);
  });
});

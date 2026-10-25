import { afterEach, it, expect } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { projectFixture } from './cloudProjectsFixture.js';
import { createProjectRouter } from '../server/cloud/projectRouter.js';
import { CloudError } from '../server/cloud/types.js';
import { sqliteIt } from './helpers/nativeSqlite.js';
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
sqliteIt('stale A browser/new B connector rejects before wrong-account outbound', async () => {
  const f = await fixture();
  f.switchProjectAccount();
  const r = await fetch(f.url + '/projects', { headers: f.headers });
  expect(r.status).toBe(409);
  expect((await r.json()).error.code).toBe('connection_changed');
  expect(f.calls).toHaveLength(0);
});
sqliteIt('stale project edit remains an actionable safe conflict', async () => {
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
sqliteIt('routes reject origin mismatch and arbitrary command fields', async () => {
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
sqliteIt(
  'real transport project conflict strips hostile upstream text and keeps exact revision',
  async () => {
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
  },
);
sqliteIt(
  'project paths are absolute, normalized, canonical and confined to home outside secret folders',
  async () => {
    const { mkdir, mkdtemp, realpath, rm, symlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = await fixture();
    const post = (path: string, body: unknown) =>
      fetch(f.url + path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) });
    const refused = async (response: Response) => {
      expect(response.status).toBe(400);
      expect(['invalid_request', 'path_not_allowed']).toContain((await response.json()).error.code);
    };
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'aasc-outside-home-')));
    try {
      await mkdir(join(f.home, 'real', 'checkout'), { recursive: true });
      await mkdir(join(f.home, '.ssh', 'proj'), { recursive: true });
      await mkdir(join(f.home, 'Library', 'proj'), { recursive: true });
      await mkdir(join(f.home, 'code', '.config', 'proj'), { recursive: true });
      await mkdir(join(f.home, '.gemini', 'extensions'), { recursive: true });
      await mkdir(join(f.home, 'code', '.vim', 'pack'), { recursive: true });
      await symlink(join(f.home, 'real'), join(f.home, 'link'));
      for (const path of [
        'relative/checkout',
        `${f.home}/real/checkout\0`,
        `${f.home}/real/../real/checkout`,
        `${f.home}/real//checkout`,
        `${f.home}/real/checkout/`,
        f.home,
        outside,
        join(f.home, '.ssh', 'proj'),
        join(f.home, 'Library', 'proj'),
        join(f.home, 'code', '.config', 'proj'),
        join(f.home, 'code', '.vim', 'pack'),
        join(f.home, 'link', 'checkout'),
      ])
        await refused(await post(`/projects/${f.project.id}/associate`, { path }));
      const get = (parentPath: string, directoryName = 'clone') =>
        post(`/projects/${f.project.id}/get`, {
          parentPath,
          directoryName,
          transport: 'https',
          resourceVersions: [],
        });
      for (const parentPath of [
        'relative',
        `${f.home}/real/../real`,
        outside,
        join(f.home, '.ssh'),
        join(f.home, 'Library'),
        join(f.home, '.gemini', 'extensions'),
        join(f.home, 'link'),
      ])
        await refused(await get(parentPath));
      await refused(await get(f.home, 'credentials'));
      await refused(await get(f.home, 'Library'));
      expect(f.git.clone).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(0);
      // The home folder itself may hold a clone; a checkout strictly inside it may be associated.
      expect((await get(f.home)).status).toBe(200);
      expect(
        (
          await post(`/projects/${f.project.id}/associate`, {
            path: join(f.home, 'real', 'checkout'),
          })
        ).status,
      ).not.toBe(400);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  },
);

// AASC-63: the new project routes keep the gate, the binding and the strict bodies.
sqliteIt(
  'serves accounts, candidates, check, push, account and remove; refuses loose bodies',
  async () => {
    const f = await fixture();
    const accounts = await fetch(f.url + '/projects/github-accounts', { headers: f.headers });
    expect(accounts.status).toBe(200);
    expect((await accounts.json()).data).toHaveProperty('installed');
    const candidates = await fetch(f.url + '/projects/candidates', { headers: f.headers });
    expect(await candidates.json()).toEqual({ success: true, data: { items: [] } });
    for (const [path, method, body] of [
      [`/projects/${f.project.id}/push`, 'POST', { force: true }],
      [`/projects/${f.project.id}/check`, 'POST', { path: '/tmp' }],
      [`/projects/${f.project.id}/remove`, 'POST', { deleteFolder: true }],
      [`/projects/${f.project.id}/account`, 'PUT', { login: 'bad;login' }],
      [`/projects/${f.project.id}/account`, 'PUT', { login: 'octo', token: 'x' }],
    ] as const) {
      const r = await fetch(f.url + path, {
        method,
        headers: f.headers,
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(400);
    }
    const removed = await fetch(f.url + `/projects/${f.project.id}/remove`, {
      method: 'POST',
      headers: f.headers,
      body: '{}',
    });
    expect((await removed.json()).data).toMatchObject({ id: f.project.id, deleted: true });
    // A local folder sent with a save must be a canonical absolute path; it is never forwarded.
    const save = await fetch(f.url + '/projects', {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({
        localPath: 'relative/folder',
        mutationId: randomUUID(),
        baseVersion: null,
        value: { ...f.project, id: randomUUID() },
      }),
    });
    expect(save.status).toBe(400);
  },
);

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
it('project paths are absolute, normalized, canonical and confined to home outside secret folders', async () => {
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
});

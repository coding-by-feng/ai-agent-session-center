import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { backendRoot, backendFixture } from './cloudBackendFixture.js';
import { createCloudTransport } from '../server/cloud/client.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
it.skipIf(!backendRoot)(
  'default HTTP resource and 100-item project pages fit actual client and advance without omissions',
  async () => {
    const f = await backendFixture();
    const transport = createCloudTransport({ timeoutMs: 10000 });
    try {
      const manifest = (n: number) =>
        f.schemas.PackageManifestSchema.parse({
          resourceId: id(n),
          agent: 'claude',
          kind: 'skill',
          name: 'Large valid manifest',
          scope: 'global',
          projectId: null,
          dependencies: [],
          files: Array.from({ length: 2000 }, (_, i) => ({
            path: `f${i}.md`,
            sha256: 'a'.repeat(64),
            bytes: 1,
            mode: 420,
          })),
        });
      f.store.db.transaction(() => {
        for (let n = 1; n <= 50; n++) {
          const m = manifest(n);
          expect(
            Buffer.byteLength(
              JSON.stringify({ manifest: m, baseVersion: null, mutationId: randomUUID() }),
            ),
          ).toBeLessThan(1048576);
          f.store.db
            .prepare('INSERT INTO cloud_resources VALUES (?,?,1,0)')
            .run(f.ownerId, m.resourceId);
          f.store.db
            .prepare('INSERT INTO resource_versions VALUES (?,?,1,?,?,?)')
            .run(
              f.ownerId,
              m.resourceId,
              JSON.stringify(m),
              'a'.repeat(64),
              '2026-10-10T00:00:00.000Z',
            );
        }
      })();
      const pins = Array.from({ length: 2000 }, (_, i) => ({
        resourceId: id(i + 1000),
        version: Number.MAX_SAFE_INTEGER,
      }));
      f.store.db.transaction(() => {
        for (let n = 1; n <= 100; n++) {
          const p = f.schemas.ProjectRecordSchema.parse({
            id: id(n),
            version: 1,
            name: 'Project',
            repository: {
              provider: 'github',
              owner: 'fixture',
              name: 'repo',
              url: 'https://github.com/fixture/repo',
              branch: 'main',
            },
            description: '界'.repeat(4096),
            resources: pins,
            deleted: false,
          });
          f.store.db
            .prepare('INSERT INTO cloud_projects VALUES (?,?,1,0,?)')
            .run(f.ownerId, p.id, JSON.stringify(p));
        }
      })();
      for (const kind of ['resources', 'projects']) {
        let cursor: string | null = null;
        const seen: string[] = [];
        let pages = 0;
        do {
          const page: { items: any[]; nextCursor: string | null } = await transport.send<{ items: any[]; nextCursor: string | null }>(
            f.origin,
            'GET',
            `/v1/${kind}?${kind === 'projects' ? 'limit=100&' : ''}${cursor ? 'cursor=' + cursor : ''}`,
            undefined,
            f.token,
          );
          expect(
            Buffer.byteLength(JSON.stringify({ success: true, data: page })),
          ).toBeLessThanOrEqual(8 * 1024 * 1024);
          expect(page.items.length).toBeGreaterThan(0);
          if (page.nextCursor) expect(page.nextCursor).not.toBe(cursor);
          seen.push(
            ...page.items.map((i) => (kind === 'resources' ? i.manifest.resourceId : i.id)),
          );
          cursor = page.nextCursor;
          pages++;
        } while (cursor && pages < 10);
        expect(cursor).toBeNull();
        expect(pages).toBeGreaterThan(1);
        expect(seen).toEqual(
          Array.from({ length: kind === 'resources' ? 50 : 100 }, (_, i) => id(i + 1)),
        );
      }
    } finally {
      transport.abort();
      await f.close();
    }
  },
  20000,
);
it.skipIf(!backendRoot)(
  'one maximum-width schema-valid resource fits the bounded HTTP envelope',
  async () => {
    const f = await backendFixture();
    const transport = createCloudTransport({});
    try {
      const m = f.schemas.PackageManifestSchema.parse({
        resourceId: id(1),
        agent: 'claude',
        kind: 'skill',
        name: '界'.repeat(256),
        scope: 'global',
        projectId: null,
        files: Array.from({ length: 2000 }, (_, i) => ({
          path: String(i).padStart(4, '0') + '界'.repeat(1020),
          sha256: 'a'.repeat(64),
          bytes: (16777216 / 2000) | 0,
          mode: 493,
        })),
        dependencies: Array.from({ length: 2000 }, (_, i) => ({
          resourceId: id(i + 2),
          version: Number.MAX_SAFE_INTEGER,
        })),
      });
      f.store.db
        .prepare('INSERT INTO cloud_resources VALUES (?,?,1,0)')
        .run(f.ownerId, m.resourceId);
      f.store.db
        .prepare('INSERT INTO resource_versions VALUES (?,?,1,?,?,?)')
        .run(
          f.ownerId,
          m.resourceId,
          JSON.stringify(m),
          'a'.repeat(64),
          '2026-10-10T00:00:00.000Z',
        );
      const page = await transport.send<any>(f.origin, 'GET', '/v1/resources', undefined, f.token);
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeNull();
      expect(Buffer.byteLength(JSON.stringify({ success: true, data: page }))).toBeLessThan(
        8 * 1024 * 1024,
      );
    } finally {
      transport.abort();
      await f.close();
    }
  },
  20000,
);

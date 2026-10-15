import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, realpath, rm, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanResources } from '../server/resourceScanner.js';
import { readPublicationPacket } from '../server/resourcePackages/packet.js';
import { cloudPublicationBlocker } from '../server/resourcePackages/policy.js';
import { PackageManifestSchema } from '../src/types/cloudResources.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
export async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'aasc-packet-')));
  dirs.push(home);
  await mkdir(join(home, '.claude', 'skills', 'demo'), { recursive: true });
  await writeFile(
    join(home, '.claude', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: test\n---\nHello',
  );
  const scan = await scanResources({ home, env: {}, sessionProjectPaths: [], extraRoots: [] });
  return { home, r: [...scan.internals.values()].find((r) => r.summary.name === 'demo')! };
}
it('reads a confined portable skill and rejects hardlinks, links, secrets and managed aliases', async () => {
  const { home, r } = await fixture();
  expect((await readPublicationPacket(r)).files[0].path).toBe('SKILL.md');
  const extra = join(home, '.claude', 'skills', 'demo', 'extra.md');
  await link(r.entry.absPath + '/SKILL.md', extra);
  await expect(readPublicationPacket(r)).rejects.toThrow(/hard.link/i);
  await rm(extra);
  await symlink('/tmp', extra);
  await expect(readPublicationPacket(r)).rejects.toThrow(/link/i);
  await rm(extra);
  await writeFile(extra, '<!-- aasc-alias:v1 -->');
  await expect(readPublicationPacket(r)).rejects.toThrow(/alias/i);
  expect(cloudPublicationBlocker({ ...r.summary, type: 'settings' })).toMatch(/adapter/i);
});
it('validates traversal, case collisions and file-directory collisions', () => {
  const m = {
    resourceId: 'd23c54de-1b99-4802-87bf-d84ddba2fdf1',
    agent: 'claude',
    kind: 'skill',
    name: 'demo',
    scope: 'global',
    projectId: null,
    dependencies: [],
    files: [{ path: 'SKILL.md', sha256: 'a'.repeat(64), bytes: 1, mode: 420 }],
  };
  expect(PackageManifestSchema.safeParse(m).success).toBe(true);
  for (const paths of [['../x'], ['X', 'x'], ['x', 'x/y'], ['C:/x'], ['/x']])
    expect(
      PackageManifestSchema.safeParse({
        ...m,
        files: paths.map((path) => ({ ...m.files[0], path })),
      }).success,
    ).toBe(false);
});
import { resourceDestination, publicationPaths } from '../server/resourcePackages/adapters.js';
import type { PackageManifest } from '../src/types/cloudResources.js';
it('round-trips nested same-name project resources using paths, independent of display name', () => {
  const base: PackageManifest = {
    resourceId: 'd23c54de-1b99-4802-87bf-d84ddba2fdf1',
    agent: 'claude',
    kind: 'skill',
    name: 'display does not choose destination',
    scope: 'project',
    projectId: 'ddf341c5-6747-4d12-a012-e29034536836',
    dependencies: [],
    files: [
      {
        path: 'services/api/.claude/skills/demo/SKILL.md',
        sha256: 'a'.repeat(64),
        bytes: 1,
        mode: 420,
      },
    ],
  };
  const roots = {
    claudeRoot: '/home/user/.claude',
    codexRoot: '/home/user/.codex',
    sharedRoot: '/home/user/.agents',
  };
  expect(resourceDestination(base, roots, '/work/project').path).toBe(
    '/work/project/services/api/.claude/skills/demo',
  );
  expect(
    resourceDestination(
      {
        ...base,
        kind: 'instruction',
        files: [{ ...base.files[0], path: 'services/api/CLAUDE.md' }],
      },
      roots,
      '/work/project',
    ).path,
  ).toBe('/work/project/services/api/CLAUDE.md');
  expect(
    resourceDestination(
      { ...base, kind: 'memory', files: [{ ...base.files[0], path: 'nested/topic.md' }] },
      roots,
      '/work/project',
    ).path,
  ).toBe('/home/user/.claude/projects/-work-project/memory/nested/topic.md');
  expect(() =>
    resourceDestination(
      { ...base, kind: 'rule', files: [{ ...base.files[0], path: 'services/api/config.json' }] },
      roots,
      '/work/project',
    ),
  ).toThrow();
});
it('supports global instruction, command, rule, agent, memory and skill adapter roots', () => {
  const roots = {
    claudeRoot: '/profiles/claude',
    codexRoot: '/profiles/codex',
    sharedRoot: '/profiles/shared',
  };
  for (const [agent, kind, path, want] of [
    ['claude', 'instruction', 'CLAUDE.md', '/profiles/claude/CLAUDE.md'],
    ['claude', 'command', 'ns/x.md', '/profiles/claude/commands/ns/x.md'],
    ['claude', 'agent', 'nested/x.md', '/profiles/claude/agents/nested/x.md'],
    ['codex', 'rule', 'default.rules', '/profiles/codex/rules/default.rules'],
    ['codex', 'memory', 'nested/x.md', '/profiles/codex/memories/nested/x.md'],
    ['shared', 'skill', 'demo/SKILL.md', '/profiles/shared/skills/demo'],
  ] as const) {
    const m: PackageManifest = {
      resourceId: 'd23c54de-1b99-4802-87bf-d84ddba2fdf1',
      agent,
      kind,
      name: 'arbitrary display',
      scope: 'global',
      projectId: null,
      dependencies: [],
      files: [{ path, sha256: 'a'.repeat(64), bytes: 1, mode: 420 }],
    };
    expect(resourceDestination(m, roots).path).toBe(want);
  }
});
it('managed destination trees are refused even when incoming metadata claims user content', () => {
  const roots = {
    claudeRoot: '/profile/claude',
    codexRoot: '/profile/codex',
    sharedRoot: '/profile/shared',
  };
  for (const [agent, path] of [
    ['codex', '.system/SKILL.md'],
    ['claude', 'synced/SKILL.md'],
  ] as const) {
    expect(() =>
      resourceDestination(
        {
          resourceId: 'd23c54de-1b99-4802-87bf-d84ddba2fdf1',
          agent,
          kind: 'skill',
          name: 'anything',
          scope: 'global',
          projectId: null,
          dependencies: [],
          files: [{ path, sha256: 'a'.repeat(64), bytes: 1, mode: 420 }],
        },
        roots,
      ),
    ).toThrow();
  }
});
it('matches the copied canonical BE v1 transport fixtures without sibling imports', async () => {
  const { readFile } = await import('node:fs/promises');
  const { BeginUploadSchema, BeginUploadResultSchema, ResourceVersionSchema, ResourceHeadSchema } =
    await import('../src/types/cloudResources.js');
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/cloud-resource-contracts.json', import.meta.url), 'utf8'),
  );
  expect(BeginUploadSchema.safeParse(fixture.beginUpload).success).toBe(true);
  expect(BeginUploadResultSchema.safeParse(fixture.beginUploadResponse.data).success).toBe(true);
  expect(ResourceVersionSchema.safeParse(fixture.commitResponse.data).success).toBe(true);
  expect(ResourceHeadSchema.safeParse(fixture.headResponse.data).success).toBe(true);
});
it('keeps binary bytes exact and rejects embedded detected secrets or credential files', async () => {
  const { r } = await fixture();
  const binary = Buffer.from([0, 1, 255, 128]);
  await writeFile(join(r.entry.absPath, 'texture.bin'), binary);
  const packet = await readPublicationPacket(r);
  expect(
    Buffer.from(packet.files.find((f) => f.path === 'texture.bin')!.content, 'base64'),
  ).toEqual(binary);
  await writeFile(join(r.entry.absPath, 'secret.md'), 'sk-ant-fixtureonly123456');
  await expect(readPublicationPacket(r)).rejects.toThrow(/secret/i);
  await rm(join(r.entry.absPath, 'secret.md'));
  await writeFile(join(r.entry.absPath, '.env'), 'example');
  await expect(readPublicationPacket(r)).rejects.toThrow(/credential|excluded/i);
});

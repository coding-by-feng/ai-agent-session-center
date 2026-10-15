import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobStore } from '../server/cloud/jobStore.js';
import { createInstaller } from '../server/cloud/install.js';
import { sha256 } from '../server/cloud/installFs.js';
import { INSTALL_WORKSPACE_PATTERN, excludeInstallWorkspaces } from '../server/cloud/gitExclude.js';
import { resourceDestination } from '../server/resourcePackages/adapters.js';
import type { PackageManifest } from '../src/types/cloudResources.js';
const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
  closers.splice(0).forEach((c) => c());
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const binding = {
  backendOrigin: 'https://cloud.example',
  accountId: 'd23c54de-1b99-4802-87bf-d84ddba2fdf1',
  generation: 1,
};
async function tempDir() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-install-exclude-')));
  dirs.push(dir);
  return dir;
}
/** Real git, isolated from the developer's own configuration. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(cwd, '.no-global-config'),
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}
async function checkout() {
  const root = join(await tempDir(), 'project');
  await mkdir(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Fixture']);
  return root;
}
const exclude = (root: string) => readFile(join(root, '.git', 'info', 'exclude'), 'utf8');

it('adds the install-workspace pattern to the checkout once and keeps what was there', async () => {
  const root = await checkout();
  await writeFile(join(root, '.git', 'info', 'exclude'), '# mine\n*.log');
  await excludeInstallWorkspaces(root);
  await excludeInstallWorkspaces(root);
  const text = await exclude(root);
  expect(text.startsWith('# mine\n*.log\n')).toBe(true);
  expect(text.split('\n').filter((l) => l === INSTALL_WORKSPACE_PATTERN)).toHaveLength(1);
  await mkdir(join(root, '.claude', 'skills', '.aasc-install-x', 'original'), { recursive: true });
  await writeFile(
    join(root, '.claude', 'skills', '.aasc-install-x', 'original', 'SKILL.md'),
    'old',
  );
  expect(git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
});

it('leaves a folder that is not a plain checkout, and every link, untouched', async () => {
  const plain = await tempDir();
  await excludeInstallWorkspaces(plain);
  expect(await readdir(plain)).toEqual([]);
  // A linked worktree or submodule: `.git` is a file pointing elsewhere.
  const worktree = await tempDir();
  await writeFile(join(worktree, '.git'), 'gitdir: /somewhere/else\n');
  await excludeInstallWorkspaces(worktree);
  expect(await readFile(join(worktree, '.git'), 'utf8')).toBe('gitdir: /somewhere/else\n');
  // `.git` as a link to another repository's metadata.
  const other = await checkout();
  const linked = await tempDir();
  await symlink(join(other, '.git'), join(linked, '.git'));
  await excludeInstallWorkspaces(linked);
  expect(await exclude(other)).not.toContain(INSTALL_WORKSPACE_PATTERN);
  // `.git/info` or `.git/info/exclude` as a link out of the checkout.
  const target = await tempDir();
  await writeFile(join(target, 'exclude'), 'outside\n');
  const infoLinked = await checkout();
  await rm(join(infoLinked, '.git', 'info'), { recursive: true, force: true });
  await symlink(target, join(infoLinked, '.git', 'info'));
  await excludeInstallWorkspaces(infoLinked);
  const fileLinked = await checkout();
  await rm(join(fileLinked, '.git', 'info', 'exclude'), { force: true });
  await symlink(join(target, 'exclude'), join(fileLinked, '.git', 'info', 'exclude'));
  await excludeInstallWorkspaces(fileLinked);
  expect(await readFile(join(target, 'exclude'), 'utf8')).toBe('outside\n');
});

it('a replacement inside a checkout keeps its backup out of git status; a new install leaves no workspace', async () => {
  const root = await checkout();
  const store = await createJobStore(join(await tempDir(), 'private'));
  closers.push(() => store.close());
  const installer = createInstaller(store);
  const manifest = (name: string, resourceId: string): PackageManifest => ({
    resourceId,
    agent: 'claude',
    kind: 'skill',
    name,
    scope: 'project',
    projectId: binding.accountId,
    files: [
      { path: `.claude/skills/${name}/SKILL.md`, sha256: sha256('new'), bytes: 3, mode: 420 },
    ],
    dependencies: [],
  });
  const roots = { claudeRoot: join(root, 'unused'), codexRoot: root, sharedRoot: root };
  // Replacement: the original is committed, so only the replaced file itself may show.
  const replaced = manifest('demo', '7f0e8c1a-2b3c-4d5e-8f90-a1b2c3d4e5f6');
  const destination = resourceDestination(replaced, roots, root);
  await mkdir(destination.path, { recursive: true });
  await writeFile(join(destination.path, 'SKILL.md'), 'old');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fixture']);
  const plan = await installer.review(replaced, 1, destination);
  const receipt = await installer.install(
    plan,
    binding,
    async () => Buffer.from('new'),
    () => {},
  );
  expect((await lstat(receipt.backup)).isDirectory()).toBe(true);
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  expect(status).not.toContain('.aasc-install-');
  expect(await exclude(root)).toContain(INSTALL_WORKSPACE_PATTERN);
  // A new install moves its stage into place and removes the emptied workspace.
  const added = manifest('fresh', '0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c');
  const freshDestination = resourceDestination(added, roots, root);
  const freshPlan = await installer.review(added, 1, freshDestination);
  await installer.install(
    freshPlan,
    binding,
    async () => Buffer.from('new'),
    () => {},
  );
  const siblings = await readdir(join(freshDestination.path, '..'));
  expect(siblings.filter((n) => n.startsWith('.aasc-install-'))).toHaveLength(1); // demo's backup only
});

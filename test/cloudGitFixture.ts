import { afterEach } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitOperations } from '../server/cloud/git.js';
import { ProjectRecordSchema } from '../src/types/cloudProjects.js';
const cleanups: string[] = [];
afterEach(async () => {
  for (const p of cleanups.splice(0)) await rm(p, { recursive: true, force: true });
});
export async function gitFixture(
  extra: {
    beforePublish?: (path: string) => Promise<void>;
    afterPublish?: () => Promise<void>;
    activeProjectPaths?: () => string[];
    /** A folder put first on PATH for AASC's Git only (the fixture's own commands keep PATH). */
    pathFirst?: string;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aasc-git-')));
  cleanups.push(root);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'none'),
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const source = join(root, 'source');
  await mkdir(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.email', 'fixture@example.invalid');
  git(source, 'config', 'user.name', 'Fixture');
  await writeFile(join(source, 'hello'), 'one');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'initial');
  const bare = join(root, 'fixture.git');
  git(root, 'clone', '--bare', source, bare);
  const project = ProjectRecordSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    version: 1,
    name: 'Fixture',
    description: '',
    resources: [],
    deleted: false,
    repository: {
      provider: 'github',
      owner: 'fixture',
      name: 'repo',
      url: 'https://github.com/fixture/repo',
      branch: 'main',
    },
  });
  const ops = await createGitOperations({
    directory: join(root, 'private'),
    activeProjectPaths: extra.activeProjectPaths,
    testTransport: {
      barePath: bare,
      env: extra.pathFirst ? { ...env, PATH: `${extra.pathFirst}${delimiter}${env.PATH}` } : env,
      afterPublish: extra.afterPublish,
      beforePublish: extra.beforePublish,
    },
  });
  return { root, source, bare, project, ops, git };
}

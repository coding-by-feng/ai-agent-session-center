/** Native argv-only Git. Local tooling/credential helpers stay on this device. */
import { spawn } from 'node:child_process';
import {
  lstat,
  realpath,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  rmdir,
  open,
} from 'node:fs/promises';
import { join, dirname, isAbsolute, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  ProjectRecordSchema,
  canonicalGithub,
  type ProjectRecord,
  type CheckoutState,
} from '../../src/types/cloudProjects.js';
import { privateDirectory } from './secretStore.js';
import { safeParents, syncDirectory, readSafeFile } from './installFs.js';
import { CloudError } from './types.js';
import { abortCheck } from './binding.js';
export interface CloneIntent {
  dev: number;
  ino: number;
  head: string;
  stagingRoot: string;
  lock: { dev: number; ino: number; token: string };
}
export interface GitOptions {
  directory: string;
  activeProjectPaths?: () => string[];
  /** Internal fixture seam, never derived from a request. Disabled outside Vitest. */
  testTransport?: {
    barePath: string;
    env: NodeJS.ProcessEnv;
    beforePublish?: (reservation: string) => Promise<void>;
    afterPublish?: () => Promise<void>;
  };
}
const fail = (code: string) =>
  new CloudError(
    code,
    (
      {
        dirty: 'Commit or remove local changes before pulling.',
        diverged: 'The checkout has local commits or diverged. Resolve it manually.',
        busy: 'Stop active agents or Git operations before retrying.',
        detached: 'Switch to the project branch before pulling.',
        'wrong-remote': 'The checkout remote or branch does not match this cloud project.',
        destination_exists: 'The destination already exists. Choose a new directory.',
        git_failed: 'Git failed. Check local authentication and repository access.',
        checkout_changed: 'The local checkout changed. Review its state again.',
      } as Record<string, string>
    )[code] ?? 'Git operation could not complete safely.',
    409,
  );
async function exists(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
export async function createGitOperations(options: GitOptions) {
  if (options.testTransport && process.env.VITEST !== 'true') throw fail('invalid_request');
  await privateDirectory(options.directory);
  const hooks = await mkdtemp(join(options.directory, 'empty-hooks-'));
  // One per start: drop earlier starts' copies. rmdir refuses a folder that is not empty.
  for (const name of await readdir(options.directory))
    if (name.startsWith('empty-hooks-') && join(options.directory, name) !== hooks)
      await rmdir(join(options.directory, name)).catch(() => {});
  const locks = new Set<string>();
  const fixture = options.testTransport;
  if (fixture) {
    const s = await lstat(fixture.barePath);
    if (!s.isDirectory() || (await realpath(fixture.barePath)) !== fixture.barePath)
      throw fail('invalid_request');
  }
  async function run(cwd: string, args: string[], signal?: AbortSignal, allowFailure = false) {
    if (signal) abortCheck(signal);
    const env = {
      ...(fixture?.env ?? process.env),
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GCM_INTERACTIVE: 'Never',
      GIT_OPTIONAL_LOCKS: '0',
    };
    // Ambient Git repository/config command overrides are not request authority.
    for (const key of Object.keys(env))
      if (
        /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS|SSH_COMMAND|SSH|SSH_VARIANT|PROXY_COMMAND|EXEC_PATH|TEMPLATE_DIR|ALLOW_PROTOCOL|PROTOCOL_FROM_USER)$/.test(
          key,
        )
      )
        delete (env as NodeJS.ProcessEnv)[key];
    return await new Promise<{ code: number; text: string }>((resolve, reject) => {
      const child = spawn(
        'git',
        [
          '-c',
          `core.hooksPath=${hooks}`,
          '-c',
          'protocol.allow=never',
          '-c',
          'protocol.https.allow=always',
          '-c',
          'protocol.ssh.allow=always',
          ...(fixture ? ['-c', 'protocol.file.allow=always'] : []),
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.sshCommand=ssh -oBatchMode=yes -oStrictHostKeyChecking=yes',
          '-c',
          'ssh.variant=ssh',
          '-c',
          'maintenance.auto=false',
          '-c',
          'gc.auto=0',
          '-c',
          'http.followRedirects=false',
          '-c',
          'submodule.recurse=false',
          '-c',
          'fetch.recurseSubmodules=false',
          ...args,
        ],
        { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
      );
      let out = '',
        bytes = 0,
        stopped = false,
        killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          child.kill('SIGKILL');
          child.stdout.destroy();
          child.stderr.destroy();
        }, 2000);
      };
      const timer = setTimeout(stop, 120000);
      signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (b: Buffer) => {
        bytes += b.length;
        if (bytes > 1024 * 1024) stop();
        else out += b.toString('utf8');
      });
      child.stderr.on('data', (b: Buffer) => {
        bytes += b.length;
        if (bytes > 1024 * 1024) stop();
      });
      child.once('error', () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', stop);
        reject(fail('git_failed'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', stop);
        if (signal?.aborted) return reject(new CloudError('cancelled', 'Git job cancelled.', 409));
        if (stopped || (!allowFailure && code !== 0)) return reject(fail('git_failed'));
        resolve({ code: code ?? 1, text: out.trim() });
      });
    });
  }
  async function configSafe(cwd: string, signal?: AbortSignal) {
    const v = await run(cwd, ['config', '--get-regexp', '^url\\..*\\.insteadof$'], signal, true);
    if (v.code === 0) throw fail('wrong-remote');
  }
  const active = (root: string) =>
    (options.activeProjectPaths?.() ?? []).some((p) => {
      const r = relative(root, p);
      return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r));
    });
  async function inspectCheckout(
    root: string,
    project: ProjectRecord,
    owned = false,
  ): Promise<{ state: CheckoutState; branch: string | null }> {
    ProjectRecordSchema.parse(project);
    if (!(await exists(root))) return { state: 'missing', branch: null };
    await safeParents(root);
    if ((await realpath(root)) !== root) throw fail('checkout_changed');
    if ((!owned && locks.has(root)) || active(root)) return { state: 'busy', branch: null };
    const gd = join(root, '.git');
    if (!(await exists(gd))?.isDirectory()) return { state: 'wrong-remote', branch: null };
    const entries = await readdir(gd);
    if (
      entries.some(
        (n) =>
          n.endsWith('.lock') ||
          [
            'rebase-merge',
            'rebase-apply',
            'MERGE_HEAD',
            'CHERRY_PICK_HEAD',
            'REVERT_HEAD',
            'BISECT_LOG',
          ].includes(n),
      )
    )
      return { state: 'busy', branch: null };
    const refLocks = async (path: string): Promise<boolean> => {
      for (const e of await readdir(path, { withFileTypes: true }).catch(() => [])) {
        if (
          e.isSymbolicLink() ||
          e.name.endsWith('.lock') ||
          (e.isDirectory() && (await refLocks(join(path, e.name))))
        )
          return true;
      }
      return false;
    };
    if (await refLocks(join(gd, 'refs'))) return { state: 'busy', branch: null };
    const branch =
      (await run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], undefined, true)).text ||
      null;
    if (!branch) return { state: 'detached', branch };
    await configSafe(root);
    const remote = (await run(root, ['remote', 'get-url', 'origin'], undefined, true)).text;
    if (branch !== project.repository.branch || canonicalGithub(remote) !== project.repository.url)
      return { state: 'wrong-remote', branch };
    if ((await run(root, ['status', '--porcelain=v1', '--untracked-files=all'])).text)
      return { state: 'dirty', branch };
    const upstream = await run(
      root,
      ['rev-parse', '--verify', `refs/remotes/origin/${branch}`],
      undefined,
      true,
    );
    if (
      upstream.code === 0 &&
      (await run(root, ['merge-base', '--is-ancestor', 'HEAD', upstream.text], undefined, true))
        .code !== 0
    )
      return { state: 'diverged', branch };
    return { state: 'ready', branch };
  }
  const lockPathFor = (root: string) =>
    join(dirname(root), `.aasc-git-${createHash('sha256').update(root).digest('hex')}.lock`);
  async function withLock<T>(root: string, op: (lock: CloneIntent['lock']) => Promise<T>) {
    if (locks.has(root) || active(root)) throw fail('busy');
    locks.add(root);
    const lockPath = lockPathFor(root);
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      const token = randomUUID();
      await handle.writeFile(token);
      await handle.sync();
      const stat = await handle.stat();
      return await op({ dev: stat.dev, ino: stat.ino, token });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw fail('busy');
      throw e;
    } finally {
      locks.delete(root);
      if (handle) {
        const owned = await handle.stat();
        await handle.close();
        const current = await exists(lockPath);
        if (current?.dev === owned.dev && current.ino === owned.ino && current.isFile())
          await rm(lockPath);
      }
    }
  }
  return {
    inspectCheckout: (root: string, project: ProjectRecord) => inspectCheckout(root, project),
    async clone(
      destination: string,
      project: ProjectRecord,
      transport: 'https' | 'ssh',
      signal: AbortSignal,
      check: () => void = () => {},
      onPublishIntent: (intent: CloneIntent) => void = () => {},
    ) {
      ProjectRecordSchema.parse(project);
      abortCheck(signal);
      await safeParents(dirname(destination));
      if (
        !isAbsolute(destination) ||
        (await realpath(dirname(destination))) !== dirname(destination)
      )
        throw fail('checkout_changed');
      if (await exists(destination)) throw fail('destination_exists');
      return withLock(destination, async (lock) => {
        const parentAnchor = await lstat(dirname(destination));
        const workspace = await mkdtemp(join(dirname(destination), '.aasc-clone-'));
        const workspaceAnchor = await lstat(workspace);
        const stage = join(workspace, 'checkout');
        let reservation: Awaited<ReturnType<typeof lstat>> | undefined;
        try {
          check();
          await configSafe(workspace, signal);
          const url =
            fixture?.barePath ??
            (transport === 'ssh'
              ? `git@github.com:${project.repository.owner}/${project.repository.name}.git`
              : project.repository.url + '.git');
          await run(
            workspace,
            [
              'clone',
              '--no-local',
              '--no-hardlinks',
              '--no-recurse-submodules',
              '--single-branch',
              '--branch',
              project.repository.branch,
              '--',
              url,
              stage,
            ],
            signal,
          );
          await run(
            stage,
            [
              'remote',
              'set-url',
              'origin',
              transport === 'ssh'
                ? `git@github.com:${project.repository.owner}/${project.repository.name}.git`
                : project.repository.url + '.git',
            ],
            signal,
          );
          abortCheck(signal);
          check();
          try {
            await mkdir(destination, { mode: 0o700 });
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw fail('destination_exists');
            throw e;
          }
          reservation = await lstat(destination);
          await fixture?.beforePublish?.(destination);
          const parentNow = await lstat(dirname(destination)),
            workspaceNow = await exists(workspace);
          if (
            parentNow.dev !== parentAnchor.dev ||
            parentNow.ino !== parentAnchor.ino ||
            workspaceNow?.dev !== workspaceAnchor.dev ||
            workspaceNow.ino !== workspaceAnchor.ino
          )
            throw fail('checkout_changed');
          const now = await lstat(destination);
          if (
            now.dev !== reservation.dev ||
            now.ino !== reservation.ino ||
            !now.isDirectory() ||
            (await readdir(destination)).length
          )
            throw fail('checkout_changed');
          abortCheck(signal);
          check();
          const stageStat = await lstat(stage);
          if (!stageStat.isDirectory() || stageStat.isSymbolicLink())
            throw fail('checkout_changed');
          const head = (await run(stage, ['rev-parse', 'HEAD'], signal)).text;
          if (!/^[a-f0-9]{40,64}$/.test(head)) throw fail('checkout_changed');
          onPublishIntent({
            dev: stageStat.dev,
            ino: stageStat.ino,
            head,
            stagingRoot: workspace,
            lock,
          });
          abortCheck(signal);
          check();
          const finalParent = await lstat(dirname(destination)),
            finalWorkspace = await lstat(workspace),
            finalStage = await lstat(stage),
            finalReservation = await lstat(destination);
          if (
            finalParent.dev !== parentAnchor.dev ||
            finalParent.ino !== parentAnchor.ino ||
            finalWorkspace.dev !== workspaceAnchor.dev ||
            finalWorkspace.ino !== workspaceAnchor.ino ||
            finalStage.dev !== stageStat.dev ||
            finalStage.ino !== stageStat.ino ||
            !finalStage.isDirectory() ||
            finalReservation.dev !== reservation.dev ||
            finalReservation.ino !== reservation.ino ||
            !finalReservation.isDirectory() ||
            (await readdir(destination)).length
          )
            throw fail('checkout_changed');
          abortCheck(signal);
          check();
          await rename(stage, destination);
          reservation = undefined;
          await syncDirectory(dirname(destination));
          await fixture?.afterPublish?.();
        } finally {
          if (reservation) {
            const now = await exists(destination);
            if (
              now?.dev === reservation.dev &&
              now.ino === reservation.ino &&
              now.isDirectory() &&
              !(await readdir(destination)).length
            )
              await rm(destination, { recursive: true });
          }
          const remaining = await exists(workspace);
          if (
            remaining?.dev === workspaceAnchor.dev &&
            remaining.ino === workspaceAnchor.ino &&
            remaining.isDirectory()
          )
            await rm(workspace, { recursive: true, force: true });
        }
      });
    },
    async recoverPublishedClone(
      root: string,
      project: ProjectRecord,
      intent: CloneIntent,
      check: () => void,
    ) {
      check();
      const stat = await exists(root);
      if (!stat || !stat.isDirectory() || stat.dev !== intent.dev || stat.ino !== intent.ino)
        throw fail('checkout_changed');
      const state = await inspectCheckout(root, project);
      if (['missing', 'wrong-remote', 'detached', 'busy'].includes(state.state))
        throw fail(state.state);
      if ((await run(root, ['rev-parse', 'HEAD'])).text !== intent.head)
        throw fail('checkout_changed');
      check();
      // Reclaim only the exact private lock recorded before this checkout was published.
      const path = lockPathFor(root),
        lock = await exists(path);
      if (lock) {
        if (
          !lock.isFile() ||
          lock.nlink !== 1 ||
          lock.dev !== intent.lock.dev ||
          lock.ino !== intent.lock.ino ||
          (await readSafeFile(path, 128)).toString('utf8') !== intent.lock.token
        )
          throw fail('busy');
        check();
        await rm(path);
        await syncDirectory(dirname(path));
      }
      await syncDirectory(dirname(root));
    },
    async pull(
      root: string,
      project: ProjectRecord,
      signal: AbortSignal,
      check: () => void = () => {},
      onFetched: () => void = () => {},
    ) {
      const initial = await inspectCheckout(root, project);
      if (initial.state !== 'ready') throw fail(initial.state);
      return withLock(root, async () => {
        // inspect outside the in-process lock check; retain all filesystem/agent guards.
        const inspect = async () => {
          const s = await inspectCheckout(root, project, true);
          if (s.state !== 'ready') throw fail(s.state);
        };
        await inspect();
        check();
        const head = (await run(root, ['rev-parse', 'HEAD'], signal)).text;
        if (!/^[a-f0-9]{40,64}$/.test(head)) throw fail('checkout_changed');
        const anchor = await lstat(root);
        await run(
          root,
          [
            'fetch',
            '--no-tags',
            '--no-recurse-submodules',
            '--',
            fixture?.barePath ?? 'origin',
            `+refs/heads/${project.repository.branch}:refs/remotes/origin/${project.repository.branch}`,
          ],
          signal,
        );
        abortCheck(signal);
        check();
        onFetched();
        await inspect();
        const now = await lstat(root);
        if (
          now.dev !== anchor.dev ||
          now.ino !== anchor.ino ||
          (await run(root, ['rev-parse', 'HEAD'], signal)).text !== head
        )
          throw fail('checkout_changed');
        const target = (
          await run(root, ['rev-parse', `refs/remotes/origin/${project.repository.branch}`], signal)
        ).text;
        // Both commits go to merge-base/merge as positional arguments: object names only.
        if (!/^[a-f0-9]{40,64}$/.test(target)) throw fail('checkout_changed');
        if (
          (await run(root, ['merge-base', '--is-ancestor', head, target], signal, true)).code !== 0
        )
          throw fail('diverged');
        abortCheck(signal);
        check();
        await run(
          root,
          ['merge', '--ff-only', '--no-overwrite-ignore', '--no-edit', target],
          signal,
        );
      });
    },
  };
}
export type GitOperations = Awaited<ReturnType<typeof createGitOperations>>;

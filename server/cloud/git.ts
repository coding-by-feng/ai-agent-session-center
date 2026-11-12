/** Native argv-only Git. Local tooling/credential helpers stay on this device. */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  stat,
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
import { join, dirname, isAbsolute, relative, sep, posix, win32 } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  ProjectRecordSchema,
  GithubLoginSchema,
  GithubRepositorySchema,
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
/**
 * A GitHub account from the GitHub CLI (AASC-63): its absolute path and the login whose token Git
 * asks it for. The token goes from the CLI's keychain to Git and never through AASC.
 */
export interface GitAccount {
  helper: string;
  login: string;
}
/** What a checkout is against its GitHub branch, as of the last fetch. */
export interface CheckoutInspection {
  state: CheckoutState;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
}
/** A folder's GitHub origin and current branch, for saving it as a cloud project. */
/** Why a GitHub checkout is one AASC won't work in (readOrigin). */
export interface FolderBlock {
  blocked: NonNullable<import('../../src/types/cloudProjects.js').ProjectFolder['blocked']>;
}
export interface GithubOrigin {
  url: string;
  owner: string;
  name: string;
  branch: string;
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
        diverged:
          'This checkout and GitHub both have new commits. Merge or rebase it yourself, then try again.',
        ahead: 'This checkout has commits GitHub does not have yet. Push them first.',
        nothing_to_push: 'Nothing to push: GitHub already has every commit on this branch.',
        missing: 'This project is not on this device.',
        busy: 'Stop active agents or Git operations before retrying.',
        detached: 'Switch to the project branch before pulling.',
        'wrong-remote': 'The checkout remote or branch does not match this cloud project.',
        destination_exists: 'The destination already exists. Choose a new directory.',
        git_failed: 'Git failed. Check local authentication and repository access.',
        checkout_changed: 'The local checkout changed. Review its state again.',
        git_unavailable:
          'No usable Git was found. Install Git in an absolute PATH folder outside your projects, then try again.',
      } as Record<string, string>
    )[code] ?? 'Git operation could not complete safely.',
    409,
  );
/**
 * Git config for one GitHub account: drop every credential helper configured anywhere, then ask
 * only the GitHub CLI, for that login. Refused (before any Git runs) unless the login is a GitHub
 * login and the helper an absolute path that can sit inside single quotes.
 */
/** `git version` output names Git `major.minor` or later; anything unreadable is older. */
export function gitAtLeast(version: string, major: number, minor: number): boolean {
  const m = /^git version (\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > major || (a === major && b >= minor);
}
export function credentialConfig(account?: GitAccount): string[] {
  if (!account) return [];
  if (
    !GithubLoginSchema.safeParse(account.login).success ||
    !isAbsolute(account.helper) ||
    // eslint-disable-next-line no-control-regex
    /['\u0000-\u001f\u007f]/u.test(account.helper)
  )
    throw new CloudError('invalid_request', 'Choose a GitHub account signed in on this Mac.', 400);
  return [
    '-c',
    'credential.helper=',
    '-c',
    `credential.https://github.com.helper=!'${account.helper}' auth git-credential`,
    '-c',
    `credential.https://github.com.username=${account.login}`,
  ];
}
const within = (parent: string, child: string) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r));
};
async function isExecutableFile(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (process.platform !== 'win32') await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
/**
 * Git's absolute path, from absolute PATH folders only. An empty, `.` or relative
 * entry means the working folder, which may be a checkout that planted its own
 * `git`; so does Windows' own search, which tries the working folder first. On
 * Windows only `git.exe` counts: a `git.cmd`/`git.bat` runs through cmd.exe, a
 * shell, which Git here never gets. Not found is `git_unavailable`, never a bare `git`.
 */
export async function resolveGitExecutable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  probe: (file: string) => Promise<boolean> = isExecutableFile,
): Promise<string> {
  const windows = platform === 'win32';
  const key = windows ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') : 'PATH';
  const path = windows ? win32 : posix;
  for (const raw of (key ? (env[key] ?? '') : '').split(path.delimiter)) {
    const dir = windows ? raw.replace(/^"(.*)"$/, '$1') : raw;
    // `\dir` and `C:dir` are relative to a drive's current folder on Windows.
    const absolute = windows
      ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(dir)
      : path.isAbsolute(dir);
    if (!absolute) continue;
    const file = path.join(dir, windows ? 'git.exe' : 'git');
    if (await probe(file)) return file;
  }
  throw fail('git_unavailable');
}
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
  // Git's working folder: private and empty, never a checkout (each run names its target with -C).
  const workdir = await mkdtemp(join(options.directory, 'empty-cwd-'));
  // One per start: drop earlier starts' copies. rmdir refuses a folder that is not empty.
  for (const name of await readdir(options.directory))
    if (
      /^empty-(?:hooks|cwd)-/.test(name) &&
      ![hooks, workdir].includes(join(options.directory, name))
    )
      await rmdir(join(options.directory, name)).catch(() => {});
  /** Folders AASC's Git works in now: a fetch moves only refs/remotes, anything else the folder. */
  const locks = new Map<string, 'fetch' | 'write'>();
  const fixture = options.testTransport;
  if (fixture) {
    const s = await lstat(fixture.barePath);
    if (!s.isDirectory() || (await realpath(fixture.barePath)) !== fixture.barePath)
      throw fail('invalid_request');
  }
  // Resolved once, from the same environment Git runs with; a failed lookup is tried again next time.
  let program: Promise<string> | null = null;
  const gitProgram = () =>
    (program ??= resolveGitExecutable(fixture?.env ?? process.env).catch((e) => {
      program = null;
      throw e;
    }));
  // Git 2.29+ fetches without writing FETCH_HEAD, which a `git pull` in the folder reads between
  // its own fetch and merge (security review, Oct 29 2026). With an older Git, or when the version
  // cannot be read, a check waits for a live agent instead of running past it.
  let quiet: Promise<boolean> | null = null;
  const quietFetch = (root: string) =>
    (quiet ??= run(root, ['version'], undefined, true).then(
      (v) => v.code === 0 && gitAtLeast(v.text, 2, 29),
      () => {
        quiet = null;
        return false;
      },
    ));
  async function run(
    root: string,
    args: string[],
    signal?: AbortSignal,
    allowFailure = false,
    config: string[] = [],
  ) {
    if (signal) abortCheck(signal);
    if (!isAbsolute(root)) throw fail('checkout_changed');
    const git = await gitProgram();
    // A Git found inside the folder it would work on (a PATH entry naming a checkout) is that checkout's.
    if (within(root, git)) throw fail('git_unavailable');
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
    // A chosen GitHub account answers from the CLI's keychain, never from an ambient token.
    if (config.length)
      for (const key of [
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'GH_ENTERPRISE_TOKEN',
        'GITHUB_ENTERPRISE_TOKEN',
      ])
        delete (env as NodeJS.ProcessEnv)[key];
    return await new Promise<{ code: number; text: string }>((resolve, reject) => {
      const child = spawn(
        git,
        [
          '-C',
          root,
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
          ...config,
          ...args,
        ],
        { cwd: workdir, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
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
  async function configSafe(root: string, signal?: AbortSignal) {
    // Any rewrite of a URL, for fetch or for push, at any config level.
    const v = await run(
      root,
      ['config', '--get-regexp', '^url\\..*\\.(push)?insteadof$'],
      signal,
      true,
    );
    if (v.code === 0) throw fail('wrong-remote');
    // The checkout's own config may not send this repository's traffic elsewhere, widen a push
    // (mirror), or route it through a proxy with TLS checks off (security review, Oct 23 2026).
    const local = await run(
      root,
      [
        'config',
        '--local',
        '--get-regexp',
        '^(remote\\.origin\\.(pushurl|mirror|proxy)|http\\.(.*\\.)?(proxy|sslverify))$',
      ],
      signal,
      true,
    );
    if (
      local.code === 0 &&
      local.text.split('\n').some((line) => !/sslverify (true|yes|on|1)$/i.test(line.trim()))
    )
      throw fail('wrong-remote');
  }
  /**
   * Fetch and push name the saved repository itself, so no remote's config can redirect them, in
   * the checkout's own transport (an SSH clone keeps SSH; inspect has already matched its origin
   * to the record).
   */
  async function remoteUrl(root: string, project: ProjectRecord): Promise<string> {
    if (fixture) return fixture.barePath;
    const { owner, name, url } = project.repository;
    return (await sshOrigin(root)) ? `git@github.com:${owner}/${name}.git` : `${url}.git`;
  }
  /** The checkout's origin is GitHub's SSH form, so remoteUrl reaches GitHub over SSH. */
  const sshOrigin = async (root: string) =>
    (await run(root, ['remote', 'get-url', 'origin'], undefined, true)).text.startsWith(
      'git@github.com:',
    );
  /** A GitHub CLI inside the folder it would sign in for is that folder's, like a Git there. */
  const assertHelperOutside = (root: string, account?: GitAccount) => {
    if (account && within(root, account.helper)) throw fail('git_unavailable');
  };
  const active = (root: string) =>
    (options.activeProjectPaths?.() ?? []).some((p) => within(root, p));
  async function inspectCheckout(
    root: string,
    project: ProjectRecord,
    owned = false,
    ignoreAgents = false,
  ): Promise<CheckoutInspection> {
    ProjectRecordSchema.parse(project);
    const only = (state: CheckoutState, branch: string | null = null): CheckoutInspection => ({
      state,
      branch,
      ahead: null,
      behind: null,
    });
    if (!(await exists(root))) return only('missing');
    await safeParents(root);
    if ((await realpath(root)) !== root) throw fail('checkout_changed');
    // A live agent blocks Git work in the folder, not recording a link to it (ignoreAgents). So
    // does AASC's own Git, except a fetch for such a read: it moves only refs/remotes, and a
    // reload while the tab checks a project would read "In use" (code review, Oct 29 2026).
    const held = locks.get(root);
    if (!owned && held && !(held === 'fetch' && ignoreAgents)) return only('busy');
    if (!ignoreAgents && active(root)) return only('busy');
    const gd = join(root, '.git');
    if (!(await exists(gd))?.isDirectory()) return only('wrong-remote');
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
      return only('busy');
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
    if (await refLocks(join(gd, 'refs'))) return only('busy');
    const branch =
      (await run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], undefined, true)).text ||
      null;
    if (!branch) return only('detached');
    await configSafe(root);
    const remote = (await run(root, ['remote', 'get-url', 'origin'], undefined, true)).text;
    if (branch !== project.repository.branch || canonicalGithub(remote) !== project.repository.url)
      return only('wrong-remote', branch);
    // Ahead/behind against the branch as last fetched; unknown before the first fetch.
    let ahead: number | null = null,
      behind: number | null = null;
    const upstream = await run(
      root,
      ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
      undefined,
      true,
    );
    if (upstream.code === 0 && /^[a-f0-9]{40,64}$/.test(upstream.text)) {
      const counts = /^(\d+)\s+(\d+)$/.exec(
        (
          await run(
            root,
            ['rev-list', '--left-right', '--count', `HEAD...${upstream.text}`],
            undefined,
            true,
          )
        ).text,
      );
      if (counts) [ahead, behind] = [Number(counts[1]), Number(counts[2])];
    }
    const counted = (state: CheckoutState): CheckoutInspection => ({
      state,
      branch,
      ahead,
      behind,
    });
    if ((await run(root, ['status', '--porcelain=v1', '--untracked-files=all'])).text)
      return counted('dirty');
    if (ahead && behind) return counted('diverged');
    return counted(ahead ? 'ahead' : 'ready');
  }
  /** Bring GitHub's branch into refs/remotes/origin; the files, HEAD and FETCH_HEAD never move. */
  async function fetchBranch(
    root: string,
    project: ProjectRecord,
    signal: AbortSignal,
    config: string[],
  ) {
    await run(
      root,
      [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        ...((await quietFetch(root)) ? ['--no-write-fetch-head'] : []),
        '--',
        await remoteUrl(root, project),
        `+refs/heads/${project.repository.branch}:refs/remotes/origin/${project.repository.branch}`,
      ],
      signal,
      false,
      config,
    );
  }
  /** A checkout Git may work in: here, on the project's branch and remote, not in use. */
  const usable = (s: CheckoutInspection) => {
    if (['missing', 'busy', 'detached', 'wrong-remote'].includes(s.state)) throw fail(s.state);
    return s;
  };
  const lockPathFor = (root: string) =>
    join(dirname(root), `.aasc-git-${createHash('sha256').update(root).digest('hex')}.lock`);
  /**
   * `kind: 'fetch'` moves only refs/remotes; `ignoreAgents`: it runs while an agent works here
   * (Git 2.29+, which leaves FETCH_HEAD alone).
   */
  async function withLock<T>(
    root: string,
    op: (lock: CloneIntent['lock']) => Promise<T>,
    { kind = 'write', ignoreAgents = false }: { kind?: 'fetch' | 'write'; ignoreAgents?: boolean } = {},
  ) {
    if (locks.has(root) || (!ignoreAgents && active(root))) throw fail('busy');
    locks.set(root, kind);
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
    /** `ignoreAgents`: for saving or linking (metadata), a live agent in the folder is not busy. */
    inspectCheckout: (root: string, project: ProjectRecord, opts?: { ignoreAgents?: boolean }) =>
      inspectCheckout(root, project, false, opts?.ignoreAgents === true),
    /** A live agent session works in this folder (Pull and Push wait for it; Check does not). */
    agentActive: (root: string) => active(root),
    async clone(
      destination: string,
      project: ProjectRecord,
      transport: 'https' | 'ssh',
      signal: AbortSignal,
      check: () => void = () => {},
      onPublishIntent: (intent: CloneIntent) => void = () => {},
      account?: GitAccount,
    ) {
      ProjectRecordSchema.parse(project);
      const config = credentialConfig(account);
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
            false,
            config,
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
    /**
     * Check: fetch GitHub's branch so ahead/behind are current. Nothing in the folder changes, so
     * a live agent there does not block it (Oct 29 2026) when Git can leave FETCH_HEAD alone; a
     * Git lock or merge in progress does.
     */
    async fetch(root: string, project: ProjectRecord, signal: AbortSignal, account?: GitAccount) {
      const config = credentialConfig(account);
      assertHelperOutside(root, account);
      const pastAgents = await quietFetch(root);
      usable(await inspectCheckout(root, project, false, pastAgents));
      return withLock(
        root,
        async () => {
          usable(await inspectCheckout(root, project, true, pastAgents));
          await fetchBranch(root, project, signal, config);
        },
        { kind: 'fetch', ignoreAgents: pastAgents },
      );
    },
    /** Check, Pull and Push reach GitHub over SSH here (an SSH clone keeps SSH). Reads only. */
    sshTransport: (root: string) => sshOrigin(root),
    /**
     * Push this branch's commits to GitHub. Never forced: GitHub must have nothing this checkout
     * lacks (fetched first), and the refspec has no `+`, so Git itself refuses a rewrite too.
     * Uncommitted changes stay where they are.
     */
    async push(
      root: string,
      project: ProjectRecord,
      signal: AbortSignal,
      check: () => void = () => {},
      account?: GitAccount,
    ) {
      const config = credentialConfig(account);
      assertHelperOutside(root, account);
      const initial = usable(await inspectCheckout(root, project));
      if (initial.ahead === 0) throw fail('nothing_to_push');
      return withLock(root, async () => {
        usable(await inspectCheckout(root, project, true));
        check();
        await fetchBranch(root, project, signal, config);
        abortCheck(signal);
        check();
        const now = usable(await inspectCheckout(root, project, true));
        if (now.behind) throw fail('diverged');
        if (!now.ahead) throw fail('nothing_to_push');
        const branch = project.repository.branch;
        await run(
          root,
          [
            '-c',
            'push.followTags=false',
            'push',
            '--porcelain',
            '--',
            await remoteUrl(root, project),
            `refs/heads/${branch}:refs/heads/${branch}`,
          ],
          signal,
          false,
          config,
        );
        // Record what GitHub has now, so the checkout reads up to date.
        await fetchBranch(root, project, signal, config);
      });
    },
    /**
     * The folder's GitHub origin and branch; for a checkout AASC won't work in, why (code review,
     * Oct 29 2026): its Git settings send the traffic elsewhere (configSafe), its `.git` points at
     * another checkout (a worktree or a submodule), or it is not on a branch. Null for anything
     * else: no checkout, or an origin that is not GitHub. Reads only.
     */
    async readOrigin(root: string): Promise<GithubOrigin | FolderBlock | null> {
      try {
        if (!isAbsolute(root)) return null;
        const dotGit = await exists(join(root, '.git'));
        if (dotGit?.isFile()) return { blocked: 'worktree' };
        if (!dotGit?.isDirectory() || (await realpath(root)) !== root) return null;
        // get-url expands url.insteadOf, so an SSH rewrite of GitHub still reads as GitHub here.
        const remote = await run(root, ['remote', 'get-url', 'origin'], undefined, true);
        const url = remote.code === 0 ? canonicalGithub(remote.text) : null;
        if (!url) return null;
        if (!(await configSafe(root).then(() => true, () => false))) return { blocked: 'settings' };
        const branch = (
          await run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], undefined, true)
        ).text;
        if (!branch) return { blocked: 'detached' };
        const [owner, name] = url.slice('https://github.com/'.length).split('/');
        GithubRepositorySchema.parse({ provider: 'github', owner, name, url, branch });
        return { url, owner, name, branch };
      } catch {
        return null;
      }
    },
    async pull(
      root: string,
      project: ProjectRecord,
      signal: AbortSignal,
      check: () => void = () => {},
      onFetched: () => void = () => {},
      account?: GitAccount,
    ) {
      const config = credentialConfig(account);
      assertHelperOutside(root, account);
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
        await fetchBranch(root, project, signal, config);
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

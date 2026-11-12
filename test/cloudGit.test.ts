import { expect, it, vi } from 'vitest';
import { spawn, type SpawnOptions } from 'node:child_process';
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
import { mkdir, mkdtemp, writeFile, readFile, rm, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter, isAbsolute, relative } from 'node:path';
import { createGitOperations, gitAtLeast, resolveGitExecutable } from '../server/cloud/git.js';
import { ProjectRecordSchema } from '../src/types/cloudProjects.js';
import { gitFixture } from './cloudGitFixture.js';
it('clone_uses_validated_argv and leaves correct canonical remote and branch', async () => {
  const f = await gitFixture();
  const dest = join(f.root, 'checkout');
  await f.ops.clone(dest, f.project, 'https', new AbortController().signal);
  expect(await readFile(join(dest, 'hello'), 'utf8')).toBe('one');
  const calls = vi.mocked(spawn).mock.calls;
  const clone = calls.find(([, args]) => Array.isArray(args) && args.includes('clone'))!;
  expect(clone[1]).toContain('core.sshCommand=ssh -oBatchMode=yes -oStrictHostKeyChecking=yes');
  expect(clone[2]).toMatchObject({ shell: false });
  expect(await f.ops.inspectCheckout(dest, f.project)).toMatchObject({
    state: 'ready',
    branch: 'main',
  });
});
it('credential_url_refused and unsafe refs', () => {
  for (const url of [
    'https://token@github.com/a/b',
    'file:///tmp/x',
    'ext::sh evil',
    'https://evil.example/a/b',
  ])
    expect(() =>
      ProjectRecordSchema.parse({
        id: '11111111-1111-4111-8111-111111111111',
        version: 1,
        name: 'a',
        description: '',
        resources: [],
        deleted: false,
        repository: { provider: 'github', owner: 'a', name: 'b', url, branch: 'main' },
      }),
    ).toThrow();
});
it('clone_never_replaces_existing_directory', async () => {
  const f = await gitFixture();
  const dest = join(f.root, 'existing');
  await mkdir(dest);
  await writeFile(join(dest, 'keep'), 'safe');
  await expect(
    f.ops.clone(dest, f.project, 'https', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'destination_exists' });
  expect(await readFile(join(dest, 'keep'), 'utf8')).toBe('safe');
});
it('dirty_or_diverged_pull_preserves_head and detached guard', async () => {
  const f = await gitFixture();
  const dest = join(f.root, 'checkout');
  await f.ops.clone(dest, f.project, 'https', new AbortController().signal);
  const head = f.git(dest, 'rev-parse', 'HEAD');
  await writeFile(join(dest, 'hello'), 'dirty');
  await expect(f.ops.pull(dest, f.project, new AbortController().signal)).rejects.toMatchObject({
    code: 'dirty',
  });
  expect(f.git(dest, 'rev-parse', 'HEAD')).toBe(head);
  f.git(dest, 'checkout', '--', 'hello');
  f.git(dest, 'checkout', '--detach');
  await expect(f.ops.pull(dest, f.project, new AbortController().signal)).rejects.toMatchObject({
    code: 'detached',
  });
});
it('wrong_remote_is_blocked and git_lock_is_busy', async () => {
  const f = await gitFixture();
  const dest = join(f.root, 'checkout');
  await f.ops.clone(dest, f.project, 'https', new AbortController().signal);
  f.git(dest, 'remote', 'set-url', 'origin', 'https://github.com/other/repo');
  expect(await f.ops.inspectCheckout(dest, f.project)).toMatchObject({ state: 'wrong-remote' });
  await writeFile(join(dest, '.git', 'index.lock'), '');
  expect(await f.ops.inspectCheckout(dest, f.project)).toMatchObject({ state: 'busy' });
});
it('cancelled_clone_keeps_unrelated_files', async () => {
  const f = await gitFixture();
  await writeFile(join(f.root, 'keep'), 'safe');
  const c = new AbortController();
  c.abort();
  await expect(
    f.ops.clone(join(f.root, 'cancelled'), f.project, 'https', c.signal),
  ).rejects.toMatchObject({ code: 'cancelled' });
  expect(await readFile(join(f.root, 'keep'), 'utf8')).toBe('safe');
});
it('pull fast forwards the allowed branch through fixture transport only', async () => {
  const f = await gitFixture();
  const dest = join(f.root, 'checkout');
  await f.ops.clone(dest, f.project, 'https', new AbortController().signal);
  await writeFile(join(f.source, 'hello'), 'two');
  f.git(f.source, 'commit', '-am', 'second');
  f.git(f.source, 'push', f.bare, 'main');
  await f.ops.pull(dest, f.project, new AbortController().signal);
  expect(await readFile(join(dest, 'hello'), 'utf8')).toBe('two');
});

it('filled reservation is preserved and clone stage is removed', async () => {
  const f = await gitFixture({
    beforePublish: async (path) => {
      await writeFile(join(path, 'user'), 'preserve');
    },
  });
  const dest = join(f.root, 'checkout');
  await expect(
    f.ops.clone(dest, f.project, 'https', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'checkout_changed' });
  expect(await readFile(join(dest, 'user'), 'utf8')).toBe('preserve');
  expect((await readdir(f.root)).filter((p) => p.startsWith('.aasc-clone-'))).toEqual([]);
});
it('swapped empty reservation is not removed', async () => {
  const f = await gitFixture({
    beforePublish: async (path) => {
      await rename(path, path + '-owned');
      await mkdir(path);
    },
  });
  const dest = join(f.root, 'checkout');
  await expect(
    f.ops.clone(dest, f.project, 'https', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'checkout_changed' });
  expect(await readdir(dest)).toEqual([]);
});
it('nested live agent makes checkout busy', async () => {
  let active: string[] = [];
  const f = await gitFixture({ activeProjectPaths: () => active });
  const dest = join(f.root, 'checkout');
  await f.ops.clone(dest, f.project, 'https', new AbortController().signal);
  active = [join(dest, 'nested', 'service')];
  expect(await f.ops.inspectCheckout(dest, f.project)).toMatchObject({ state: 'busy' });
  await expect(f.ops.pull(dest, f.project, new AbortController().signal)).rejects.toMatchObject({
    code: 'busy',
  });
});
// Oct 26 2026: saving or linking a project is metadata, so a live agent in the folder does not
// block it; a Git operation in progress still does.
it('ignoreAgents: a live agent does not make a checkout busy for linking; a Git lock still does', async () => {
  let active: string[] = [];
  const f = await gitFixture({ activeProjectPaths: () => active });
  const dest = join(f.root, 'checkout');
  await f.ops.clone(dest, f.project, 'https', new AbortController().signal);
  active = [dest];
  expect(await f.ops.inspectCheckout(dest, f.project)).toMatchObject({ state: 'busy' });
  expect(await f.ops.inspectCheckout(dest, f.project, { ignoreAgents: true })).toMatchObject({
    state: 'ready',
    branch: 'main',
  });
  await writeFile(join(dest, '.git', 'index.lock'), '');
  expect(await f.ops.inspectCheckout(dest, f.project, { ignoreAgents: true })).toMatchObject({
    state: 'busy',
  });
});
// Oct 29 2026: Check only moves refs/remotes, so a live agent no longer blocks it (the Projects tab
// fetches every recent project, and those are the ones agents work in). Pull and Push still wait.
it('a live agent does not block fetch; pull and push still refuse; agentActive reports it', async () => {
  let active: string[] = [];
  const f = await gitFixture({ activeProjectPaths: () => active });
  const dest = join(f.root, 'checkout');
  await f.ops.clone(dest, f.project, 'https', new AbortController().signal);
  await writeFile(join(f.source, 'hello'), 'two');
  f.git(f.source, 'commit', '-am', 'second');
  f.git(f.source, 'push', f.bare, 'main');
  active = [join(dest, 'src')];
  expect(f.ops.agentActive(dest)).toBe(true);
  await f.ops.fetch(dest, f.project, new AbortController().signal);
  expect(await f.ops.inspectCheckout(dest, f.project, { ignoreAgents: true })).toMatchObject({
    state: 'ready',
    behind: 1,
  });
  await expect(f.ops.pull(dest, f.project, new AbortController().signal)).rejects.toMatchObject({
    code: 'busy',
  });
  await expect(f.ops.push(dest, f.project, new AbortController().signal)).rejects.toMatchObject({
    code: 'busy',
  });
  active = [];
  expect(f.ops.agentActive(dest)).toBe(false);
});
// Oct 29 2026 (security review): a `git pull` running in the folder reads FETCH_HEAD between its
// own fetch and merge, so a check that runs past an agent never writes it (Git 2.29+). With an
// older Git a check waits for the agent again.
it('fetch leaves FETCH_HEAD alone; sshTransport reads the checkout’s own origin', async () => {
  const f = await gitFixture();
  const dest = join(f.root, 'checkout');
  await f.ops.clone(dest, f.project, 'https', new AbortController().signal);
  await writeFile(join(f.source, 'hello'), 'two');
  f.git(f.source, 'commit', '-am', 'second');
  f.git(f.source, 'push', f.bare, 'main');
  await f.ops.fetch(dest, f.project, new AbortController().signal);
  expect(await f.ops.inspectCheckout(dest, f.project)).toMatchObject({ behind: 1 });
  await expect(readFile(join(dest, '.git', 'FETCH_HEAD'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await f.ops.sshTransport(dest)).toBe(false);
  f.git(dest, 'remote', 'set-url', 'origin', 'git@github.com:fixture/repo.git');
  expect(await f.ops.sshTransport(dest)).toBe(true);
});
it('with a Git older than 2.29 a check fetches as before, and waits for a live agent', async () => {
  const real = await resolveGitExecutable(process.env);
  const shim = await mkdtemp(join(tmpdir(), 'aasc-old-git-'));
  try {
    await writeFile(
      join(shim, 'git'),
      `#!/bin/sh\nfor a in "$@"; do last="$a"; done\n[ "$last" = version ] && { echo 'git version 2.25.1'; exit 0; }\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    );
    let active: string[] = [];
    const f = await gitFixture({ activeProjectPaths: () => active, pathFirst: shim });
    const dest = join(f.root, 'checkout');
    await f.ops.clone(dest, f.project, 'https', new AbortController().signal);
    active = [dest];
    await expect(
      f.ops.fetch(dest, f.project, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'busy' });
    active = [];
    vi.mocked(spawn).mockClear();
    await f.ops.fetch(dest, f.project, new AbortController().signal);
    const fetches = vi
      .mocked(spawn)
      .mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('fetch'));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]![1]).not.toContain('--no-write-fetch-head');
  } finally {
    await rm(shim, { recursive: true, force: true });
  }
});
// Code review, Oct 29 2026: the tab reloads while it checks a project (a Save, a tab switch); that
// read is not "In use" over AASC's own fetch, while Git work that changes the folder still waits.
it('a read past agents reads through AASC’s own fetch; work that changes the folder waits', async () => {
  const f = await gitFixture();
  const dest = join(f.root, 'checkout');
  await f.ops.clone(dest, f.project, 'https', new AbortController().signal);
  const real = vi.mocked(spawn).getMockImplementation()!;
  let started!: () => void;
  const inFetch = new Promise<void>((r) => (started = r));
  vi.mocked(spawn).mockImplementation(((file: string, args: readonly string[], opts: SpawnOptions) => {
    if (!args.includes('fetch')) return real(file, args as string[], opts);
    started();
    return real('/bin/sh', ['-c', 'sleep 0.4; exec "$0" "$@"', file, ...args], opts);
  }) as typeof spawn);
  try {
    const fetching = f.ops.fetch(dest, f.project, new AbortController().signal);
    await inFetch;
    expect(await f.ops.inspectCheckout(dest, f.project, { ignoreAgents: true })).toMatchObject({
      state: 'ready',
    });
    expect(await f.ops.inspectCheckout(dest, f.project)).toMatchObject({ state: 'busy' });
    await fetching;
  } finally {
    vi.mocked(spawn).mockImplementation(real);
  }
});
it('gitAtLeast reads `git version`; anything it cannot read is older', () => {
  expect(gitAtLeast('git version 2.54.0 (Apple Git-157)', 2, 29)).toBe(true);
  expect(gitAtLeast('git version 2.29.0.windows.1', 2, 29)).toBe(true);
  expect(gitAtLeast('git version 3.0.0', 2, 29)).toBe(true);
  expect(gitAtLeast('git version 2.25.1', 2, 29)).toBe(false);
  expect(gitAtLeast('git version 1.99.9', 2, 29)).toBe(false);
  expect(gitAtLeast('hub version 2.14.2', 2, 29)).toBe(false);
  expect(gitAtLeast('', 2, 29)).toBe(false);
});
it('pull with local commits preserves them (ahead: push first) and remote rewrite is refused', async () => {
  const f = await gitFixture();
  const dest = join(f.root, 'checkout');
  await f.ops.clone(dest, f.project, 'https', new AbortController().signal);
  f.git(dest, 'config', 'user.email', 'fixture@example.invalid');
  f.git(dest, 'config', 'user.name', 'Fixture');
  await writeFile(join(dest, 'local'), 'local');
  f.git(dest, 'add', '.');
  f.git(dest, 'commit', '-m', 'local');
  const head = f.git(dest, 'rev-parse', 'HEAD');
  // AASC-63: a checkout with only its own commits reads `ahead` (Push), not `diverged`.
  await expect(f.ops.pull(dest, f.project, new AbortController().signal)).rejects.toMatchObject({
    code: 'ahead',
  });
  expect(f.git(dest, 'rev-parse', 'HEAD')).toBe(head);
  f.git(dest, 'config', 'url.https://evil.example/.insteadOf', 'https://github.com/');
  await expect(f.ops.pull(dest, f.project, new AbortController().signal)).rejects.toMatchObject({
    code: 'wrong-remote',
  });
});
it('clone publication checks an unchanged parent inode', async () => {
  const f = await gitFixture();
  const parent = join(f.root, 'parent');
  await mkdir(parent);
  let moved = false;
  const check = () => {
    if (moved) return;
    moved = true;
  }; // final async mutation uses the private fixture hook below
  const ops = await createGitOperations({
    directory: join(f.root, 'private2'),
    testTransport: {
      barePath: f.bare,
      env: {
        PATH: process.env.PATH,
        HOME: f.root,
        GIT_CONFIG_GLOBAL: join(f.root, 'none'),
        GIT_CONFIG_NOSYSTEM: '1',
      },
      beforePublish: async () => {
        await rename(parent, parent + '-old');
        await mkdir(parent);
        await mkdir(join(parent, 'checkout'));
      },
    },
  });
  await expect(
    ops.clone(join(parent, 'checkout'), f.project, 'https', new AbortController().signal, check),
  ).rejects.toMatchObject({ code: 'checkout_changed' });
  expect(await readdir(join(parent, 'checkout'))).toEqual([]);
});
it('swapped staging workspace is never published or removed', async () => {
  let replacement = '';
  const f = await gitFixture({
    beforePublish: async (path) => {
      const parent = join(path, '..');
      const name = (await readdir(parent)).find((n) => n.startsWith('.aasc-clone-'))!;
      replacement = join(parent, name);
      await rename(replacement, replacement + '-owned');
      await mkdir(join(replacement, 'checkout'), { recursive: true });
      await writeFile(join(replacement, 'checkout', 'user'), 'keep');
    },
  });
  await expect(
    f.ops.clone(join(f.root, 'checkout'), f.project, 'https', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'checkout_changed' });
  expect(await readFile(join(replacement, 'checkout', 'user'), 'utf8')).toBe('keep');
});
it('cancellation after checkout cleans only owned stage and reservation', async () => {
  const c = new AbortController();
  const f = await gitFixture({
    beforePublish: async () => {
      c.abort();
    },
  });
  await writeFile(join(f.root, 'unrelated'), 'keep');
  await expect(
    f.ops.clone(join(f.root, 'checkout'), f.project, 'https', c.signal),
  ).rejects.toMatchObject({ code: 'cancelled' });
  expect(await readFile(join(f.root, 'unrelated'), 'utf8')).toBe('keep');
  expect(
    (await readdir(f.root)).filter((n) => n === 'checkout' || n.startsWith('.aasc-clone-')),
  ).toEqual([]);
});
it('configured hooks do not run during checkout and pull', async () => {
  const f = await gitFixture();
  const dest = join(f.root, 'checkout');
  await f.ops.clone(dest, f.project, 'https', new AbortController().signal);
  const hooks = join(f.root, 'malicious-hooks');
  await mkdir(hooks);
  const sentinel = join(f.root, 'hook-ran');
  await writeFile(join(hooks, 'post-merge'), `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
  f.git(dest, 'config', 'core.hooksPath', hooks);
  await writeFile(join(f.source, 'hello'), 'two');
  f.git(f.source, 'commit', '-am', 'next');
  f.git(f.source, 'push', f.bare, 'main');
  await f.ops.pull(dest, f.project, new AbortController().signal);
  expect(await readFile(sentinel).catch(() => null)).toBe(null);
});
it('destination is rechecked after durable intent before rename', async () => {
  const f = await gitFixture();
  const { renameSync, mkdirSync } = await import('node:fs');
  const dest = join(f.root, 'checkout');
  await expect(
    f.ops.clone(
      dest,
      f.project,
      'https',
      new AbortController().signal,
      () => {},
      () => {
        renameSync(dest, dest + '-owned');
        mkdirSync(dest);
      },
    ),
  ).rejects.toMatchObject({ code: 'checkout_changed' });
  expect(await readdir(dest)).toEqual([]);
});
it('recovery reclaims only its recorded inode and nonce lock', async () => {
  let orphan = '',
    lockPath = '';
  const f = await gitFixture({
    afterPublish: async () => {
      lockPath = join(f.root, (await readdir(f.root)).find((n) => n.startsWith('.aasc-git-'))!);
      orphan = lockPath + '.orphan';
      await rename(lockPath, orphan);
      throw new Error('simulated loss');
    },
  });
  let intent: import('../server/cloud/git.js').CloneIntent | undefined;
  const root = join(f.root, 'checkout');
  await expect(
    f.ops.clone(
      root,
      f.project,
      'https',
      new AbortController().signal,
      () => {},
      (i) => {
        intent = i;
      },
    ),
  ).rejects.toThrow();
  await rename(orphan, lockPath);
  await f.ops.recoverPublishedClone(root, f.project, intent!, () => {});
  expect(await readFile(lockPath).catch(() => null)).toBe(null);
  await writeFile(lockPath, 'unrelated-lock');
  await expect(
    f.ops.recoverPublishedClone(root, f.project, intent!, () => {}),
  ).rejects.toMatchObject({ code: 'busy' });
  expect(await readFile(lockPath, 'utf8')).toBe('unrelated-lock');
});
it('pull refuses upstream tracking an ignored local file and preserves HEAD and bytes', async () => {
  const f = await gitFixture();
  await writeFile(join(f.source, '.gitignore'), 'ignored.txt\n');
  f.git(f.source, 'add', '.gitignore');
  f.git(f.source, 'commit', '-m', 'ignore local data');
  f.git(f.source, 'push', f.bare, 'main');
  const root = join(f.root, 'checkout');
  await f.ops.clone(root, f.project, 'https', new AbortController().signal);
  const head = f.git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'ignored.txt'), 'LOCAL USER DATA');
  expect(await f.ops.inspectCheckout(root, f.project)).toMatchObject({ state: 'ready' });
  await writeFile(join(f.source, 'ignored.txt'), 'REMOTE REPLACEMENT');
  f.git(f.source, 'add', '-f', 'ignored.txt');
  f.git(f.source, 'commit', '-m', 'track ignored file');
  f.git(f.source, 'push', f.bare, 'main');
  await expect(f.ops.pull(root, f.project, new AbortController().signal)).rejects.toMatchObject({
    code: 'git_failed',
  });
  expect(f.git(root, 'rev-parse', 'HEAD')).toBe(head);
  expect(await readFile(join(root, 'ignored.txt'), 'utf8')).toBe('LOCAL USER DATA');
});

// AASC-51 review: Git never runs from inside an untrusted checkout. On Windows a git.exe at the
// repository root would run instead of the real Git (the working folder is searched first), and on
// any OS an empty or relative PATH entry means "the working folder".
const within = (parent: string, child: string) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
it('runs Git by its absolute path from a private empty folder, aimed at the checkout with -C', async () => {
  const f = await gitFixture();
  vi.mocked(spawn).mockClear();
  const dest = join(f.root, 'checkout');
  await f.ops.clone(dest, f.project, 'https', new AbortController().signal);
  await writeFile(join(f.source, 'hello'), 'two');
  f.git(f.source, 'commit', '-am', 'second');
  f.git(f.source, 'push', f.bare, 'main');
  await f.ops.pull(dest, f.project, new AbortController().signal);
  const calls = vi.mocked(spawn).mock.calls.map(([program, args, opts]) => ({
    program,
    args: args as string[],
    cwd: String((opts as SpawnOptions).cwd),
  }));
  for (const step of ['clone', 'set-url', 'status', 'merge'])
    expect(calls.filter((c) => c.args.includes(step)).length, step).toBeGreaterThan(0);
  expect(new Set(calls.map((c) => c.program)).size).toBe(1);
  for (const c of calls) {
    expect(isAbsolute(c.program), c.program).toBe(true);
    expect(c.args[0]).toBe('-C');
    const target = c.args[1];
    expect(isAbsolute(target)).toBe(true);
    expect(within(target, c.cwd), `${c.args.join(' ')} ran in ${c.cwd}`).toBe(false);
    expect(within(dest, c.cwd)).toBe(false);
    expect(await readdir(c.cwd)).toEqual([]);
  }
});
it('resolves Git from absolute PATH folders only: an empty, "." or relative entry is never used', async () => {
  const f = await gitFixture();
  const planted = join(f.root, 'planted');
  await mkdir(planted);
  await writeFile(join(planted, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const rel = relative(process.cwd(), planted);
  expect(isAbsolute(rel)).toBe(false);
  const real = await resolveGitExecutable({ PATH: process.env.PATH });
  expect(isAbsolute(real)).toBe(true);
  expect(await resolveGitExecutable({ PATH: ['', '.', rel, dirname(real)].join(delimiter) })).toBe(
    real,
  );
  await expect(
    resolveGitExecutable({ PATH: ['', '.', rel].join(delimiter) }),
  ).rejects.toMatchObject({
    code: 'git_unavailable',
  });
  await expect(resolveGitExecutable({})).rejects.toMatchObject({ code: 'git_unavailable' });
});
it('on Windows takes only git.exe from a drive or UNC folder, never git.cmd or a relative entry', async () => {
  const probed: string[] = [];
  const program = await resolveGitExecutable(
    {
      Path: ['', '.', 'tools', '\\rooted', 'C:relative', '"C:\\Program Files\\Git\\cmd"'].join(';'),
    },
    'win32',
    async (file) => {
      probed.push(file);
      return true;
    },
  );
  expect(program).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
  expect(probed).toEqual(['C:\\Program Files\\Git\\cmd\\git.exe']);
  await expect(
    resolveGitExecutable({ PATH: 'tools;.;' }, 'win32', async () => true),
  ).rejects.toMatchObject({ code: 'git_unavailable' });
});
it('never runs a git that sits inside the checkout, even when PATH points there', async () => {
  const f = await gitFixture();
  const dest = join(f.root, 'checkout');
  await f.ops.clone(dest, f.project, 'https', new AbortController().signal);
  const sentinel = join(f.root, 'planted-ran');
  await mkdir(join(dest, 'bin'));
  await writeFile(join(dest, 'bin', 'git'), `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
  const ops = await createGitOperations({
    directory: join(f.root, 'private3'),
    testTransport: {
      barePath: f.bare,
      env: {
        PATH: join(dest, 'bin') + delimiter + process.env.PATH,
        HOME: f.root,
        GIT_CONFIG_GLOBAL: join(f.root, 'none'),
        GIT_CONFIG_NOSYSTEM: '1',
      },
    },
  });
  await expect(ops.inspectCheckout(dest, f.project)).rejects.toMatchObject({
    code: 'git_unavailable',
  });
  expect(await readFile(sentinel).catch(() => null)).toBe(null);
});

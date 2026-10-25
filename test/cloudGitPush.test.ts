// AASC-63: ahead/behind, Check (fetch only), Push (never forced) and a chosen GitHub account,
// with real Git against a temporary bare repository (the VITEST-only test transport).
import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitFixture } from './cloudGitFixture.js';

const signal = () => new AbortController().signal;
async function cloned() {
  const f = await gitFixture();
  const dest = join(f.root, 'checkout');
  await f.ops.clone(dest, f.project, 'https', signal());
  f.git(dest, 'config', 'user.email', 'fixture@example.invalid');
  f.git(dest, 'config', 'user.name', 'Fixture');
  return { ...f, dest };
}
/** A commit that lands on GitHub (the bare repository) from another device. */
function commitElsewhere(f: Awaited<ReturnType<typeof cloned>>, text: string) {
  f.git(f.source, 'pull', '--quiet', f.bare, 'main');
  return writeFile(join(f.source, 'hello'), text).then(() => {
    f.git(f.source, 'commit', '-qam', text);
    f.git(f.source, 'push', '--quiet', f.bare, 'main');
  });
}
async function commitHere(f: Awaited<ReturnType<typeof cloned>>, file: string, text: string) {
  await writeFile(join(f.dest, file), text);
  f.git(f.dest, 'add', '.');
  f.git(f.dest, 'commit', '-qm', text);
}
const gitArgs = () =>
  vi.mocked(spawn).mock.calls.map(([, args]) => (Array.isArray(args) ? (args as string[]) : []));

it('reports commits to push as ahead, and Push sends them to GitHub', async () => {
  const f = await cloned();
  expect(await f.ops.inspectCheckout(f.dest, f.project)).toMatchObject({
    state: 'ready',
    ahead: 0,
    behind: 0,
  });
  await commitHere(f, 'mine', 'from this device');
  expect(await f.ops.inspectCheckout(f.dest, f.project)).toMatchObject({
    state: 'ahead',
    ahead: 1,
    behind: 0,
  });
  await f.ops.push(f.dest, f.project, signal());
  expect(f.git(f.bare, 'rev-parse', 'main')).toBe(f.git(f.dest, 'rev-parse', 'HEAD'));
  expect(await f.ops.inspectCheckout(f.dest, f.project)).toMatchObject({
    state: 'ready',
    ahead: 0,
    behind: 0,
  });
});

it('Check fetches only: it shows what is behind and never changes the files', async () => {
  const f = await cloned();
  await commitElsewhere(f, 'two');
  expect(await f.ops.inspectCheckout(f.dest, f.project)).toMatchObject({ behind: 0 });
  await f.ops.fetch(f.dest, f.project, signal());
  expect(await f.ops.inspectCheckout(f.dest, f.project)).toMatchObject({
    state: 'ready',
    ahead: 0,
    behind: 1,
  });
  expect(await readFile(join(f.dest, 'hello'), 'utf8')).toBe('one');
  await f.ops.pull(f.dest, f.project, signal());
  expect(await readFile(join(f.dest, 'hello'), 'utf8')).toBe('two');
});

it('Push never forces: with GitHub ahead too, it refuses and GitHub keeps its commit', async () => {
  const f = await cloned();
  await commitHere(f, 'mine', 'local');
  await commitElsewhere(f, 'remote');
  const remote = f.git(f.bare, 'rev-parse', 'main');
  await expect(f.ops.push(f.dest, f.project, signal())).rejects.toMatchObject({
    code: 'diverged',
  });
  expect(f.git(f.bare, 'rev-parse', 'main')).toBe(remote);
  expect(await f.ops.inspectCheckout(f.dest, f.project)).toMatchObject({
    state: 'diverged',
    ahead: 1,
    behind: 1,
  });
  const pushes = gitArgs().filter((a) => a.includes('push'));
  for (const args of pushes) {
    expect(args.some((a) => /^--force/.test(a) || a === '-f' || a.startsWith('+'))).toBe(false);
  }
});

it('pushes committed work and leaves uncommitted changes alone', async () => {
  const f = await cloned();
  await commitHere(f, 'mine', 'committed');
  await writeFile(join(f.dest, 'scratch'), 'not committed');
  expect(await f.ops.inspectCheckout(f.dest, f.project)).toMatchObject({
    state: 'dirty',
    ahead: 1,
  });
  await f.ops.push(f.dest, f.project, signal());
  expect(f.git(f.bare, 'rev-parse', 'main')).toBe(f.git(f.dest, 'rev-parse', 'HEAD'));
  expect(await readFile(join(f.dest, 'scratch'), 'utf8')).toBe('not committed');
});

it('nothing to push is refused before any network call', async () => {
  const f = await cloned();
  const before = gitArgs().length;
  await expect(f.ops.push(f.dest, f.project, signal())).rejects.toMatchObject({
    code: 'nothing_to_push',
  });
  expect(
    gitArgs()
      .slice(before)
      .some((a) => a.includes('push')),
  ).toBe(false);
});

it('a chosen GitHub account replaces every credential helper with the GitHub CLI for that login', async () => {
  const f = await cloned();
  const account = { helper: '/opt/fixture/bin/gh', login: 'octo-cat' };
  const before = gitArgs().length;
  await f.ops.fetch(f.dest, f.project, signal(), account);
  const fetch = gitArgs()
    .slice(before)
    .find((a) => a.includes('fetch'))!;
  const configs = fetch.filter((_, i) => fetch[i - 1] === '-c');
  expect(configs).toEqual(
    expect.arrayContaining([
      'credential.helper=',
      "credential.https://github.com.helper=!'/opt/fixture/bin/gh' auth git-credential",
      'credential.https://github.com.username=octo-cat',
    ]),
  );
  // The reset comes before the GitHub CLI helper, so no other helper is asked first.
  expect(configs.indexOf('credential.helper=')).toBeLessThan(
    configs.indexOf(
      "credential.https://github.com.helper=!'/opt/fixture/bin/gh' auth git-credential",
    ),
  );
  for (const bad of [
    { helper: '/opt/fixture/bin/gh', login: 'x;rm -rf' },
    { helper: "/opt/it's/gh", login: 'octo' },
    { helper: 'gh', login: 'octo' },
  ])
    await expect(f.ops.fetch(f.dest, f.project, signal(), bad)).rejects.toMatchObject({
      code: 'invalid_request',
    });
});

it('reads a folder\'s GitHub origin and branch for "Save a project", and nothing else', async () => {
  const f = await cloned();
  expect(await f.ops.readOrigin(f.dest)).toEqual({
    url: 'https://github.com/fixture/repo',
    owner: 'fixture',
    name: 'repo',
    branch: 'main',
  });
  f.git(f.dest, 'remote', 'set-url', 'origin', 'https://gitlab.example/a/b.git');
  expect(await f.ops.readOrigin(f.dest)).toBeNull();
  expect(await f.ops.readOrigin(join(f.root, 'not-a-checkout'))).toBeNull();
});

// Security review (Oct 23 2026): the checkout's own config must not redirect, widen or proxy a
// push or fetch, and a GitHub CLI inside the checkout is never the credential helper.
it.each([
  ['remote.origin.pushurl', 'https://attacker.example/x.git'],
  ['url.https://attacker.example/.pushInsteadOf', 'https://github.com/'],
  ['remote.origin.mirror', 'true'],
  ['remote.origin.proxy', 'http://127.0.0.1:9'],
  ['http.proxy', 'http://127.0.0.1:9'],
  ['http.sslVerify', 'false'],
])('refuses to push or check a checkout whose own config sets %s', async (key, value) => {
  const f = await cloned();
  await commitHere(f, 'mine', 'local');
  f.git(f.dest, 'config', key, value);
  const remote = f.git(f.bare, 'rev-parse', 'main');
  await expect(f.ops.push(f.dest, f.project, signal())).rejects.toMatchObject({
    code: 'wrong-remote',
  });
  await expect(f.ops.fetch(f.dest, f.project, signal())).rejects.toMatchObject({
    code: 'wrong-remote',
  });
  expect(f.git(f.bare, 'rev-parse', 'main')).toBe(remote);
});

it('pushes to the saved repository by URL, never through the remote named origin', async () => {
  const f = await cloned();
  await commitHere(f, 'mine', 'local');
  const before = gitArgs().length;
  await f.ops.push(f.dest, f.project, signal());
  const push = gitArgs()
    .slice(before)
    .find((a) => a.includes('push'))!;
  expect(push).not.toContain('origin');
  expect(push).toContain('push.followTags=false');
});

it('never uses a GitHub CLI that sits inside the checkout as the credential helper', async () => {
  const f = await cloned();
  await expect(
    f.ops.fetch(f.dest, f.project, signal(), { helper: join(f.dest, 'bin', 'gh'), login: 'octo' }),
  ).rejects.toMatchObject({ code: 'git_unavailable' });
});

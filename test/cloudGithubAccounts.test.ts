// AASC-63: GitHub accounts come from the GitHub CLI. AASC reads logins; a token never passes
// through it (no --show-token, nothing stored).
import { expect, it, vi } from 'vitest';
import { createGithubAccounts } from '../server/cloud/githubAccounts.js';

const status = (accounts: object[], extra: object = {}) =>
  JSON.stringify({ hosts: { 'github.com': accounts, ...extra } });
function accounts(stdout: string, code = 0, found = ['/opt/homebrew/bin/gh']) {
  const exec = vi.fn(async () => ({ code, stdout }));
  const probe = vi.fn(async (file: string) => found.includes(file));
  return {
    exec,
    probe,
    gh: createGithubAccounts({ env: { PATH: '/usr/bin:relative/bin:/bin' }, exec, probe }),
  };
}

it('reports a missing GitHub CLI without running anything', async () => {
  const { gh, exec } = accounts('', 0, []);
  expect(await gh.list()).toEqual({ installed: false, accounts: [] });
  expect(exec).not.toHaveBeenCalled();
  await expect(gh.account('octo')).rejects.toMatchObject({ code: 'github_cli_missing' });
});

it('lists github.com logins only, asking the CLI without --show-token', async () => {
  const { gh, exec, probe } = accounts(
    status(
      [
        {
          state: 'success',
          active: true,
          host: 'github.com',
          login: 'Octo-Cat',
          tokenSource: 'keyring',
          scopes: 'repo',
          gitProtocol: 'https',
        },
        { state: 'error', active: false, host: 'github.com', login: 'work-me' },
        { state: 'success', active: false, host: 'github.com', login: 'bad;login' },
      ],
      { 'ghe.example': [{ state: 'success', active: true, login: 'enterprise' }] },
    ),
  );
  expect(await gh.list()).toEqual({
    installed: true,
    accounts: [
      { login: 'Octo-Cat', active: true, ok: true },
      { login: 'work-me', active: false, ok: false },
    ],
  });
  const [file, args] = exec.mock.calls[0] as unknown as [string, string[]];
  expect(file).toBe('/opt/homebrew/bin/gh');
  expect(args).toEqual(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']);
  expect(args.join(' ')).not.toContain('token');
  // Relative PATH entries are never searched.
  expect(probe.mock.calls.map(([f]) => f)).not.toContain('relative/bin/gh');
});

it('still reads the JSON when the CLI exits 1 because one account needs signing in again', async () => {
  const { gh } = accounts(
    status([{ state: 'error', active: true, host: 'github.com', login: 'expired' }]),
    1,
  );
  expect((await gh.list()).accounts).toEqual([{ login: 'expired', active: true, ok: false }]);
});

it('hands Git the CLI and the exact login, or refuses an account that is not signed in', async () => {
  const { gh } = accounts(
    status([{ state: 'success', active: true, host: 'github.com', login: 'Octo-Cat' }]),
  );
  expect(await gh.account('octo-cat')).toEqual({
    helper: '/opt/homebrew/bin/gh',
    login: 'Octo-Cat',
  });
  await expect(gh.account('someone-else')).rejects.toMatchObject({
    code: 'github_account_missing',
  });
  const broken = accounts('not json');
  expect(await broken.gh.list()).toEqual({ installed: true, accounts: [] });
});

it('never runs a gh found inside a project folder on PATH (a planted one), only a trusted one', async () => {
  const exec = vi.fn(async () => ({ code: 0, stdout: status([]) }));
  const probe = vi.fn(async () => true);
  const gh = createGithubAccounts({
    env: { PATH: '/Users/me/code/app/bin:/opt/homebrew/bin' },
    exec,
    probe,
    untrusted: () => ['/Users/me/code/app'],
  });
  await gh.list();
  expect(exec.mock.calls[0][0]).toBe('/opt/homebrew/bin/gh');
});

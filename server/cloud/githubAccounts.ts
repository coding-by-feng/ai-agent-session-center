/**
 * githubAccounts.ts — the GitHub accounts this Mac can clone, pull and push with (AASC-63).
 *
 * They are the GitHub CLI's (`gh`): the user signs in with `gh auth login` (one or more accounts),
 * and the tokens stay in the CLI's keychain. AASC reads only the logins (`gh auth status --json
 * hosts`, never `--show-token`) and, for a project's Git command, names the CLI as the credential
 * helper for one login (git.ts `credentialConfig`), so a token goes from the CLI to Git directly.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { GithubLoginSchema, type GithubAccounts } from '../../src/types/cloudProjects.js';
import type { GitAccount } from './git.js';
import { CloudError } from './types.js';

/** Where Homebrew puts `gh` when the app's PATH (launched from Finder) doesn't name it. */
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];
const OUTPUT_LIMIT = 256 * 1024;
const TIMEOUT_MS = 10_000;
const StatusSchema = z.object({
  hosts: z.record(
    z.string(),
    z.array(
      z.object({ login: z.string(), active: z.boolean().optional(), state: z.string().optional() }),
    ),
  ),
});

type Exec = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ code: number; stdout: string }>;

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (process.platform !== 'win32') await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
/** argv only, no shell, bounded in time and output; a failure reads as no output. */
const execFile: Exec = (file, args, env) =>
  new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: tmpdir(),
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => {
      if (stdout.length + b.length > OUTPUT_LIMIT) child.kill('SIGKILL');
      else stdout += b.toString('utf8');
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: '' });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout });
    });
  });

export function createGithubAccounts(
  deps: {
    env?: NodeJS.ProcessEnv;
    exec?: Exec;
    probe?: (file: string) => Promise<boolean>;
    platform?: NodeJS.Platform;
    /** Folders a `gh` may not come from: the user's projects (a PATH entry can name one). */
    untrusted?: () => string[];
  } = {},
) {
  const env = deps.env ?? process.env,
    exec = deps.exec ?? execFile,
    probe = deps.probe ?? isExecutableFile,
    windows = (deps.platform ?? process.platform) === 'win32',
    path = windows ? win32 : posix;
  // The CLI reads its keychain; no prompt, no update check, and no ambient token in its place.
  const cliEnv: NodeJS.ProcessEnv = {
    ...env,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'])
    delete cliEnv[key];

  /** `gh` from absolute PATH folders (never the working folder), then Homebrew's. */
  async function program(): Promise<string | null> {
    const key = windows ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') : 'PATH';
    const dirs = [
      ...(key ? (env[key] ?? '') : '').split(path.delimiter),
      ...(windows ? [] : FALLBACK_DIRS),
    ];
    const projects = deps.untrusted?.() ?? [];
    const inProject = (dir: string) =>
      projects.some((p) => {
        const r = path.relative(p, dir);
        return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
      });
    for (const dir of dirs) {
      if (!path.isAbsolute(dir) || inProject(dir)) continue;
      const file = path.join(dir, windows ? 'gh.exe' : 'gh');
      if (await probe(file)) return file;
    }
    return null;
  }
  async function read(): Promise<{ gh: string | null; list: GithubAccounts }> {
    const gh = await program();
    if (!gh) return { gh, list: { installed: false, accounts: [] } };
    // `gh auth status` exits 1 when any account needs signing in again; its JSON is still whole.
    const { stdout } = await exec(
      gh,
      ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'],
      cliEnv,
    );
    let parsed: z.infer<typeof StatusSchema> | null = null;
    try {
      parsed = StatusSchema.parse(JSON.parse(stdout));
    } catch {
      parsed = null;
    }
    const seen = new Set<string>();
    const accounts = (parsed?.hosts['github.com'] ?? [])
      .filter((a) => GithubLoginSchema.safeParse(a.login).success)
      .filter((a) => !seen.has(a.login.toLowerCase()) && !!seen.add(a.login.toLowerCase()))
      .slice(0, 50)
      .map((a) => ({ login: a.login, active: a.active === true, ok: a.state === 'success' }));
    return { gh, list: { installed: true, accounts } };
  }
  return {
    list: async () => (await read()).list,
    /** The helper and exact login Git uses for one signed-in account. */
    async account(login: string): Promise<GitAccount> {
      const { gh, list } = await read();
      if (!gh)
        throw new CloudError(
          'github_cli_missing',
          'Install the GitHub CLI (gh) to use a GitHub account on this Mac.',
          409,
        );
      const found = list.accounts.find((a) => a.login.toLowerCase() === login.toLowerCase());
      if (!found?.ok)
        throw new CloudError(
          'github_account_missing',
          'That GitHub account is not signed in on this Mac. Run gh auth login, then try again.',
          409,
        );
      return { helper: gh, login: found.login };
    },
  };
}
export type GithubAccountsService = ReturnType<typeof createGithubAccounts>;

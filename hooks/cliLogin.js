// cliLogin.js — setup's "log in now?" for the enabled agent CLIs (Oct 29 2026).
//
// The same reading as the server's server/cliAuth.ts (`claude auth status` JSON, `codex login status`
// text); test/cliLogin.test.ts runs both parsers over the same outputs, so they can't drift. Only a
// definite "logged out" offers a login: an unclear answer (a config error, an old CLI) is shown as is.

import { spawnSync } from 'child_process';

const NOT_FOUND_EXIT = 127;
const STATUS_TIMEOUT_MS = 15_000;

export const CLI_LABELS = { claude: 'Claude Code', codex: 'Codex' };

const STATUS_LINES = { claude: 'claude auth status', codex: 'codex login status' };

// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const lastLine = (s) => {
  const lines = stripAnsi(s).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? '').slice(0, 200);
};
const isMissing = (r) => r.code === NOT_FOUND_EXIT || /command not found/i.test(r.stderr);
const unknown = (detail) => ({ state: 'unknown', method: null, detail: detail || null });

/** `{ code, stdout, stderr }` of `<cli> … status` → `{ state, method, detail }`, as server/cliAuth.ts reads it. */
export function loginStateOf(cli, r) {
  if (isMissing(r)) return { state: 'missing', method: null, detail: null };
  if (cli === 'claude') {
    const text = stripAnsi(r.stdout);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        const json = JSON.parse(text.slice(start, end + 1));
        if (typeof json.loggedIn === 'boolean') {
          const method = typeof json.authMethod === 'string' && json.authMethod !== 'none' ? json.authMethod : null;
          return { state: json.loggedIn ? 'logged-in' : 'logged-out', method: json.loggedIn ? method : null, detail: null };
        }
      } catch {
        // Not JSON after all: unknown.
      }
    }
    return unknown(lastLine(`${r.stdout}\n${r.stderr}`));
  }
  const text = stripAnsi(`${r.stdout}\n${r.stderr}`);
  if (/^\s*Not logged in\b/im.test(text)) return { state: 'logged-out', method: null, detail: null };
  const using = text.match(/^\s*Logged in using\s+(.+?)\s*$/im);
  if (using) {
    const method = /api key/i.test(using[1]) ? 'API key' : using[1].replace(/^an?\s+/i, '');
    return { state: 'logged-in', method, detail: null };
  }
  return unknown(lastLine(text));
}

/** The login line: Codex's browser login answers on localhost, so over ssh or headless it uses a device code. */
export function loginLineOf(cli, { remote }) {
  if (cli === 'claude') return 'claude auth login';
  return remote ? 'codex login --device-auth' : 'codex login';
}

/** A login shell, as the server runs the CLIs: the PATH an interactive terminal would have. */
function inLoginShell(line, options) {
  return spawnSync(process.env.SHELL || '/bin/sh', ['-lc', line], options);
}

export function readLoginState(cli) {
  const r = inLoginShell(STATUS_LINES[cli], { encoding: 'utf8', timeout: STATUS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return unknown(r.error.message);
  return loginStateOf(cli, { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
}

/**
 * After setup: for each enabled CLI that is logged out, ask, then run its login in this terminal.
 * `ask(question)` answers a line; `pause`/`resume` hand the terminal to the login and back.
 */
export async function offerLogins(clis, { ask, pause, resume, out, remote }) {
  for (const cli of clis.filter((c) => c in CLI_LABELS)) {
    const label = CLI_LABELS[cli];
    let state = readLoginState(cli);
    if (state.state === 'logged-in') { out.ok(`${label}: logged in${state.method ? ` (${state.method})` : ''}`); continue; }
    if (state.state === 'missing') { out.warn(`${label}: not installed. Install it, then run: ${loginLineOf(cli, { remote })}`); continue; }
    if (state.state === 'unknown') { out.warn(`${label}: couldn't tell if it's logged in${state.detail ? ` (${state.detail})` : ''}`); continue; }
    const answer = (await ask(`${label} isn't logged in. Log in now? [Y/n] `)).trim().toLowerCase();
    if (answer === 'n' || answer === 'no') { out.info(`Later: run ${loginLineOf(cli, { remote })}, or press Log in in the dashboard`); continue; }
    pause();
    try {
      inLoginShell(loginLineOf(cli, { remote }), { stdio: 'inherit' });
    } finally {
      resume();
    }
    state = readLoginState(cli);
    if (state.state === 'logged-in') out.ok(`${label}: logged in${state.method ? ` (${state.method})` : ''}`);
    else out.warn(`${label}: still not logged in. The dashboard will offer it again.`);
  }
}

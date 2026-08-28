#!/usr/bin/env node
/**
 * set-password.mjs — set (or clear) the dashboard password.
 *
 * ## Why this exists separately from `npm run setup`
 *
 * `hooks/setup-wizard.js` hard-codes `<repo>/data/server-config.json`, but a
 * PACKAGED Electron app reads `$APP_USER_DATA/server-config.json`
 * (`~/Library/Application Support/ai-agent-session-center/…` on macOS) — see
 * `server/serverConfig.ts`. So running the wizard against an installed app
 * writes a password the app never reads: it silently appears to do nothing.
 * This script resolves the same path the app does, and by default writes BOTH
 * locations so a dev run and the installed app agree.
 *
 * ## Why input is prompted, never passed as an argument
 *
 * A password on the command line lands in shell history and in the process
 * list (`ps`) for every user on the machine. This reads it from the TTY with
 * echo disabled, so it is never displayed, never stored in history, and never
 * appears in a transcript.
 *
 * Usage:
 *   node scripts/set-password.mjs           # prompt, set the password
 *   node scripts/set-password.mjs --clear   # remove it (localhost-only again)
 *   node scripts/set-password.mjs --status  # report whether one is set
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scryptSync, randomBytes } from 'crypto';
import { createInterface } from 'readline';
import { homedir, platform } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const RESET = '\x1b[0m', BOLD = '\x1b[1m', DIM = '\x1b[2m';
const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m';

/** Where the PACKAGED app keeps its config, per Electron's app.getPath('userData'). */
function userDataConfigPath() {
  const app = 'ai-agent-session-center';
  const p = platform();
  if (p === 'darwin') return join(homedir(), 'Library', 'Application Support', app, 'server-config.json');
  if (p === 'win32') {
    const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(base, app, 'server-config.json');
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, app, 'server-config.json');
}

const REPO_CONFIG = join(PROJECT_ROOT, 'data', 'server-config.json');
const APP_CONFIG = userDataConfigPath();

/** Same scrypt parameters and "salt:hash" shape as server/authManager.ts —
 *  verifyPassword() splits on ':' and derives with keylen 64. Changing either
 *  here silently produces a hash the server can never match. */
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/** Mirrors validatePasswordComplexity() in server/authManager.ts. */
function validate(password) {
  const errors = [];
  if (password.length < 8) errors.push('at least 8 characters');
  if (!/[A-Z]/.test(password)) errors.push('1 uppercase letter');
  if (!/[a-z]/.test(password)) errors.push('1 lowercase letter');
  if (!/[0-9]/.test(password)) errors.push('1 digit');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('1 special character');
  return errors;
}

function readConfig(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeConfig(path, cfg) {
  mkdirSync(dirname(path), { recursive: true });
  // Write-to-temp + rename, matching the rule the app already follows for
  // ~/.claude/settings.json. rename() is atomic within a filesystem, so a
  // crash mid-write can never leave a truncated config — which would drop the
  // user's port and CLI settings along with the password.
  //
  // The temp file is written with mode 0600 BEFORE it holds the hash, and
  // rename preserves that mode: a config containing a password hash should not
  // be world-readable on a shared machine.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * A reader for one or more hidden prompts.
 *
 * This is a factory rather than a bare `promptHidden(q)` function because the
 * non-TTY path MUST reuse a single readline interface. Creating one per prompt
 * and closing it ends `process.stdin`, so the *second* prompt (the confirm)
 * reads from a dead stream and never resolves — the script printed "Confirm:"
 * and then exited having written nothing, with no error shown. Holding one
 * reader for the whole run is what makes a piped/scripted invocation work.
 */
function createPrompter() {
  const input = process.stdin;

  if (!input.isTTY) {
    // Piped or redirected stdin (CI, `printf ... | node`). Input cannot be
    // hidden here — there is no terminal to disable echo on — but it is also
    // not being typed, so there is nothing to shoulder-surf.
    const rl = createInterface({ input, output: process.stdout, terminal: false });
    const lines = rl[Symbol.asyncIterator]();
    return {
      async ask(question) {
        process.stdout.write(question);
        const { value, done } = await lines.next();
        // The overwhelmingly common way to reach this is running the script
        // somewhere without an interactive terminal — an agent/CLI tool's
        // shell-out (Claude Code's `!` prefix), a CI step, an IDE run button.
        // "stdin ended" is accurate and tells the user nothing about what to
        // do, so name the actual cause and the fix.
        if (done) {
          throw new Error(
            'No terminal available to type a password into.\n'
            + '  This shell has no interactive TTY — that happens when the script is run\n'
            + '  from an agent, a CI job, or an editor\'s run button rather than a terminal.\n\n'
            + '  Open Terminal.app (or iTerm) and run it there:\n'
            + '      cd ' + PROJECT_ROOT + ' && npm run set-password\n\n'
            + '  Avoid piping the password in (`echo ... |`): it would be saved to your\n'
            + '  shell history and visible in `ps` to every user on this machine.',
          );
        }
        process.stdout.write('\n');
        return value;
      },
      close() { rl.close(); },
    };
  }

  return {
    ask(question) {
      return new Promise((resolve) => {
        process.stdout.write(question);
        input.setRawMode(true);
        input.resume();
        input.setEncoding('utf8');
        let buf = '';
        const onData = (ch) => {
          if (ch === '\n' || ch === '\r' || ch === '') {
            input.setRawMode(false);
            input.pause();
            input.removeListener('data', onData);
            process.stdout.write('\n');
            resolve(buf);
            return;
          }
          if (ch === '') { process.stdout.write('\n'); process.exit(130); }  // Ctrl-C
          if (ch === '' || ch === '\b') { buf = buf.slice(0, -1); return; }  // backspace
          buf += ch;
        };
        input.on('data', onData);
      });
    },
    close() { input.pause(); },
  };
}

function targets() {
  // Always write the app's config. Also write the repo one when it already
  // exists, so a dev `npm start` in this checkout matches the installed app
  // instead of quietly disagreeing about whether a password is set.
  return existsSync(REPO_CONFIG) ? [APP_CONFIG, REPO_CONFIG] : [APP_CONFIG];
}

async function main() {
  const arg = process.argv[2];

  if (arg === '--status') {
    for (const path of [APP_CONFIG, REPO_CONFIG]) {
      const cfg = readConfig(path);
      const state = !cfg ? `${DIM}(no config file)${RESET}`
        : cfg.passwordHash ? `${GREEN}password SET${RESET}`
        : `${YELLOW}no password — remote devices blocked${RESET}`;
      console.log(`  ${state}  ${DIM}${path}${RESET}`);
    }
    return;
  }

  if (arg === '--clear') {
    for (const path of targets()) {
      const cfg = readConfig(path) ?? {};
      delete cfg.passwordHash;
      writeConfig(path, cfg);
      console.log(`${YELLOW}✓${RESET} password removed  ${DIM}${path}${RESET}`);
    }
    console.log(`\n${YELLOW}Remote devices are now BLOCKED${RESET} (localhost still has full access).`);
    console.log(`${DIM}Restart the app for this to take effect.${RESET}`);
    return;
  }

  console.log(`\n${BOLD}Set the AI Agent Session Center password${RESET}`);
  console.log(`${DIM}Required before any device other than this machine can connect.`);
  console.log(`Input is hidden and is never echoed, logged, or stored in shell history.${RESET}\n`);

  const prompter = createPrompter();
  let pw, again;
  try {
    pw = await prompter.ask('  New password: ');
    again = await prompter.ask('  Confirm:      ');
  } finally {
    prompter.close();
  }

  // Validated AFTER both reads so a weak password does not exit mid-prompt
  // with the terminal still in raw mode.
  const errors = validate(pw);
  if (errors.length) {
    console.error(`\n${RED}✗ Password needs: ${errors.join(', ')}.${RESET}\n`);
    process.exit(1);
  }
  if (again !== pw) {
    console.error(`\n${RED}✗ Passwords did not match — nothing was changed.${RESET}\n`);
    process.exit(1);
  }

  const hash = hashPassword(pw);
  for (const path of targets()) {
    const cfg = readConfig(path) ?? {};
    cfg.passwordHash = hash;
    writeConfig(path, cfg);
    console.log(`${GREEN}✓${RESET} password set  ${DIM}${path}${RESET}`);
  }

  console.log(`\n${BOLD}Next:${RESET}`);
  console.log(`  1. Quit and reopen the app  ${DIM}(config is read at startup)${RESET}`);
  console.log(`  2. From a phone, open the LAN URL and log in with this password`);
  console.log(`     ${DIM}the address is in the 🖥 device chip in the header${RESET}`);
  console.log(`\n  ${CYAN}Tokens last 1h; login is rate-limited to 5 attempts / 15 min.${RESET}\n`);
}

main().catch((err) => {
  console.error(`\n${RED}✗ ${err?.message ?? err}${RESET}\n`);
  process.exit(1);
});

#!/usr/bin/env node
// aasc-server — the headless server's one command (terminal-editions plan §7–8).
//
//   aasc-server [serve]           start the server (what the systemd unit runs)
//   aasc-server setup             terminal setup wizard, written into the data folder
//   aasc-server set-password      set the dashboard password (required to serve)
//   aasc-server install-service   write and start a systemd user unit (Linux)
//   aasc-server uninstall-service stop it and remove the unit
//   aasc-server install-hooks     (re)install the agent CLI hooks
//   aasc-server uninstall-hooks   remove them
//   aasc-server pair              pair a phone or computer (a link, a text QR, then y/N)
//   aasc-server devices           list, revoke or rename paired devices
//   aasc-server status · doctor   what the server is doing · what this box is missing
//   aasc-server logs              the service's journal, or <data>/logs/server.log
//
// Every command takes --data-dir <path>. What each one runs is decided in cliPlan.js; this file only
// executes it, forwarding signals and the child's exit code (systemd's RestartPreventExitStatus reads
// this process's code).

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { parseCli, planServe, planTool, exitStatus, EX_CONFIG, EX_USAGE } from './cliPlan.js';
import { ensureDataDir } from '../hooks/dataDir.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: aasc-server [command] [--data-dir <path>] [--port <n>]

Commands:
  serve               start the server (the default) · --port <n> · --allow-second-server
  setup               run the setup wizard
  set-password        set the dashboard password (a headless server needs one)
  install-service     run the server as a systemd user service (Linux)
  uninstall-service   stop the service and remove its unit
  install-hooks       install the Claude Code / Codex hooks
  uninstall-hooks     remove them
  pair                pair a phone or computer · --lan --tailscale --public · --invert
  devices             list paired devices · devices revoke <id> · devices rename <id> <name>
  status              what the server is doing · --json
  doctor              check what this box needs to run the server
  logs                follow the server's log · -n <lines> · --no-follow
  share-default       share sessions started on this box with paired devices · on|off|status
  help                show this help
`;

function fail(message, code = 1) {
  process.stderr.write(`aasc-server: ${message}\n`);
  process.exit(code);
}

/**
 * Run a child with this terminal, pass SIGINT/SIGTERM on, and resolve with how it ended:
 * `{ code }` or `{ signal }`.
 */
function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', env, cwd: projectRoot });
    const forward = (signal) => { if (child.exitCode === null) child.kill(signal); };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('error', (err) => {
      process.stderr.write(`aasc-server: cannot run ${command}: ${err.message}\n`);
      resolve({ code: 1, signal: null });
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve({ code, signal });
    });
  });
}

/**
 * End this process the way the child ended. A signal is re-raised on ourselves (with our forwarding
 * handlers gone), so systemd sees a crash as a crash; 128 + the signal number if that doesn't stop us.
 */
function exitLike({ code, signal }) {
  if (code === null && signal) {
    process.removeAllListeners(signal);
    try { process.kill(process.pid, signal); } catch { /* fall through to the exit code */ }
  }
  process.exit(exitStatus(code, signal));
}

async function serve({ rest, setup }) {
  let plan;
  try {
    plan = planServe({ projectRoot, rest });
  } catch (err) {
    return fail(err.message);
  }
  ensureDataDir(plan.dataDir);
  if (setup || plan.needsSetup) {
    if (!process.stdin.isTTY) {
      return fail(`no server-config.json in ${plan.dataDir}. Run \`aasc-server setup\` in a terminal first.`, EX_CONFIG);
    }
    const wizard = await run(process.execPath, [join(projectRoot, 'hooks', 'setup-wizard.js')], plan.env);
    if (wizard.code !== 0) exitLike(wizard);
    process.stdout.write('Starting the server...\n');
  }
  exitLike(await run(plan.command, plan.args, plan.env));
}

async function tool(command, rest) {
  let plan;
  try {
    plan = planTool(command, { projectRoot, rest });
  } catch (err) {
    return fail(err.message);
  }
  ensureDataDir(plan.dataDir);
  exitLike(await run(plan.command, plan.args, plan.env));
}

const parsed = parseCli(process.argv.slice(2));
switch (parsed.command) {
  case 'help':
    process.stdout.write(USAGE);
    break;
  case 'unknown':
    process.stderr.write(`aasc-server: unknown command "${parsed.name}"\n\n${USAGE}`);
    process.exit(EX_USAGE);
    break;
  case 'serve':
    await serve(parsed);
    break;
  default:
    await tool(parsed.command, parsed.rest);
}

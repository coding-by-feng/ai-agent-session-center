// runtime.ts — the process-wide settings of the central-session MCP server (server/mcp/).
//
// Two things the rest of the folder needs and none of them owns: the port /mcp is served on (a launch
// line names it, and only the code that starts the server knows it), and the off switch.
//
// The switch is OFF by default (Oct 28 2026, by request: every central and the /mcp runtime cost memory
// and timers most people never use). Settings → ADVANCED turns it on; that choice is saved in its own
// small file beside server-config.json (`central-sessions.json`, written atomically) and applies the
// next time AASC starts, because /mcp and its runtime are built once at startup (index.ts).

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import log from '../logger.js';
import { config } from '../serverConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mcpPort: number | null = null;

/** Is this a TCP port: a whole number from 1 to 65535? */
export function isTcpPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Record the port the server listens on, for launch lines (launch.ts) to name. Called once by the
 * code that starts the server. Throws `RangeError` for a value that is not a TCP port: a wrong one
 * would not fail here but in every central's launch, silently, so it is refused where it is set.
 */
export function setMcpPort(port: number): void {
  if (!isTcpPort(port)) throw new RangeError(`Not a TCP port: ${String(port)}`);
  mcpPort = port;
}

/**
 * A port the way `server.listen()` reads one: a number as it is, a string that is not blank through
 * `Number()` (net's `validatePort` takes `+port`: '3333' and ' 3333 ' are port 3333). Anything else is
 * no port.
 */
function listenPort(port: unknown): number {
  if (typeof port === 'number') return port;
  if (typeof port === 'string' && port.trim() !== '') return Number(port);
  return Number.NaN;
}

/**
 * What server startup calls with the port it is about to listen on (a config value can be a string).
 * Records it when it is a TCP port and answers true. Anything else is not recorded and never throws: the
 * server starts all the same, a warning says why, and centrals are left unwired (a launch with no port
 * names no /mcp, and the central it minted is revoked at once). Answers whether the port was recorded.
 */
export function recordMcpPort(port: unknown): boolean {
  const value = listenPort(port);
  if (!isTcpPort(value)) {
    log.warn(
      'mcp',
      `Central sessions are left unwired: the server port ${String(port).slice(0, 40)} is not a TCP port`,
    );
    return false;
  }
  setMcpPort(value);
  return true;
}

/** The port set by `setMcpPort`, or null while the server has not said what it listens on. */
export function getMcpPort(): number | null {
  return mcpPort;
}

function settingFile(): string {
  if (process.env.AASC_CENTRAL_SESSIONS_FILE) return process.env.AASC_CENTRAL_SESSIONS_FILE;
  return process.env.APP_USER_DATA
    ? join(process.env.APP_USER_DATA, 'central-sessions.json')
    : join(__dirname, '..', '..', 'data', 'central-sessions.json');
}

/** The Settings choice this process started with: read once, so a later save waits for a restart. */
let bootChoice: boolean | null | undefined;
/** The choice saved since start (null: none saved this run). */
let savedChoice: boolean | null = null;

function readSavedChoice(): boolean | null {
  try {
    const value = (JSON.parse(readFileSync(settingFile(), 'utf8')) as { enabled?: unknown }).enabled;
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

function startChoice(): boolean | null {
  if (bootChoice === undefined) bootChoice = readSavedChoice();
  return bootChoice;
}

/**
 * Is the central-session feature on in this run? The Settings choice AASC started with, else
 * `mcp.enabled` in `server-config.json`; off unless one of them says `true`.
 */
export function isMcpEnabled(): boolean {
  return startChoice() ?? config.mcp?.enabled === true;
}

/** For Settings: on in this run, and on after the next start (they differ until a restart). */
export function centralSessionsSetting(): { enabled: boolean; nextStart: boolean } {
  const enabled = isMcpEnabled();
  return { enabled, nextStart: savedChoice ?? enabled };
}

/** Save the Settings choice (temp file, then rename). It applies the next time AASC starts. */
export function setCentralSessionsEnabled(on: boolean): void {
  startChoice(); // pin this run's choice before the file changes under it
  const file = settingFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ enabled: on })}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  savedChoice = on;
}

/** @internal — test only: forget both choices, so the next read goes to the file. */
export function __resetCentralSessionsForTest(): void {
  bootChoice = undefined;
  savedChoice = null;
}

/** @internal — test only: forget the port, as a server that has not started would. */
export function __resetMcpPortForTest(): void {
  mcpPort = null;
}

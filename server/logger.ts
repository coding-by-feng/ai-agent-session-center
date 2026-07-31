// logger.ts — Debug-aware logging utility
// Usage: node server/index.js --debug   OR   npm start -- --debug

import { readFileSync, appendFileSync, mkdirSync, renameSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { inspect } from 'util';

const __dir = dirname(fileURLToPath(import.meta.url));

// Check CLI flag first, then fall back to config file
let isDebug = process.argv.includes('--debug') || process.argv.includes('-debug');
if (!isDebug) {
  try {
    const cfg = JSON.parse(readFileSync(join(__dir, '..', 'data', 'server-config.json'), 'utf8'));
    if (cfg.debug) isDebug = true;
  } catch { /* no config file yet */ }
}

const RESET = '\x1b[0m';
const DIM   = '\x1b[2m';
const CYAN  = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED   = '\x1b[31m';
const MAGENTA = '\x1b[35m';

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function formatTag(tag: string): string {
  return `${DIM}[${timestamp()}]${RESET} ${CYAN}[${tag}]${RESET}`;
}

// Persist logs to disk too -- console output alone vanishes in a packaged Electron
// app once the loading screen's stdout/stderr mirror tears down after startup (see
// electron/main.ts captureLogsToLoadingScreen), so this is the only trace left of
// anything that goes wrong afterward. Same APP_USER_DATA convention as
// serverConfig.ts/db.ts: packaged Electron writes under userData, dev/CLI falls
// back to the local data/ directory (already gitignored).
const LOG_DIR = process.env.APP_USER_DATA
  ? join(process.env.APP_USER_DATA, 'logs')
  : join(__dir, '..', 'data', 'logs');
const LOG_FILE = join(LOG_DIR, 'server.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024; // rotate server.log -> server.old.log past this size

let logDirReady = false;

function rotateIfNeeded() {
  try {
    if (statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      renameSync(LOG_FILE, join(LOG_DIR, 'server.old.log'));
    }
  } catch { /* no existing file yet -- nothing to rotate */ }
}

function formatArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4 }))).join(' ');
}

function writeToFile(tag: string, level: string, args: unknown[]) {
  try {
    if (!logDirReady) {
      mkdirSync(LOG_DIR, { recursive: true });
      logDirReady = true;
    }
    rotateIfNeeded();
    const line = `[${timestamp()}] [${tag}]${level ? ` ${level}` : ''} ${formatArgs(args)}`;
    appendFileSync(LOG_FILE, line + '\n');
  } catch { /* logging must never crash the app it's trying to diagnose */ }
}

interface Logger {
  info(tag: string, ...args: unknown[]): void;
  warn(tag: string, ...args: unknown[]): void;
  error(tag: string, ...args: unknown[]): void;
  debug(tag: string, ...args: unknown[]): void;
  debugJson(tag: string, label: string, obj: unknown): void;
  readonly isDebug: boolean;
}

const logger: Logger = {
  /** Always shown */
  info(tag: string, ...args: unknown[]) {
    console.log(formatTag(tag), ...args);
    writeToFile(tag, '', args);
  },

  /** Always shown */
  warn(tag: string, ...args: unknown[]) {
    console.warn(`${formatTag(tag)} ${YELLOW}WARN${RESET}`, ...args);
    writeToFile(tag, 'WARN', args);
  },

  /** Always shown */
  error(tag: string, ...args: unknown[]) {
    console.error(`${formatTag(tag)} ${RED}ERROR${RESET}`, ...args);
    writeToFile(tag, 'ERROR', args);
  },

  /** Only shown in debug mode */
  debug(tag: string, ...args: unknown[]) {
    if (!isDebug) return;
    console.log(`${formatTag(tag)} ${MAGENTA}DEBUG${RESET}`, ...args);
    writeToFile(tag, 'DEBUG', args);
  },

  /** Only shown in debug mode — logs object as JSON */
  debugJson(tag: string, label: string, obj: unknown) {
    if (!isDebug) return;
    console.log(`${formatTag(tag)} ${MAGENTA}DEBUG${RESET} ${label}:`, JSON.stringify(obj, null, 2));
    writeToFile(tag, 'DEBUG', [`${label}:`, obj]);
  },

  get isDebug() {
    return isDebug;
  },
};

export default logger;

/** Absolute path to the server-side log file, for surfacing in UI (tray menu, etc). */
export function getServerLogPath(): string {
  return LOG_FILE;
}

// logger.ts — Debug-aware logging utility
// Usage: node server/index.js --debug   OR   npm start -- --debug

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Check CLI flag first, then fall back to config file
let isDebug = process.argv.includes('--debug') || process.argv.includes('-debug');
if (!isDebug) {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
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
  },

  /** Always shown */
  warn(tag: string, ...args: unknown[]) {
    console.warn(`${formatTag(tag)} ${YELLOW}WARN${RESET}`, ...args);
  },

  /** Always shown */
  error(tag: string, ...args: unknown[]) {
    console.error(`${formatTag(tag)} ${RED}ERROR${RESET}`, ...args);
  },

  /** Only shown in debug mode */
  debug(tag: string, ...args: unknown[]) {
    if (!isDebug) return;
    console.log(`${formatTag(tag)} ${MAGENTA}DEBUG${RESET}`, ...args);
  },

  /** Only shown in debug mode — logs object as JSON */
  debugJson(tag: string, label: string, obj: unknown) {
    if (!isDebug) return;
    console.log(`${formatTag(tag)} ${MAGENTA}DEBUG${RESET} ${label}:`, JSON.stringify(obj, null, 2));
  },

  get isDebug() {
    return isDebug;
  },
};

export default logger;

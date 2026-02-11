// logger.js — Debug-aware logging utility
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
const GREEN = '\x1b[32m';
const MAGENTA = '\x1b[35m';

function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function formatTag(tag) {
  return `${DIM}[${timestamp()}]${RESET} ${CYAN}[${tag}]${RESET}`;
}

const logger = {
  /** Always shown */
  info(tag, ...args) {
    console.log(formatTag(tag), ...args);
  },

  /** Always shown */
  warn(tag, ...args) {
    console.warn(`${formatTag(tag)} ${YELLOW}WARN${RESET}`, ...args);
  },

  /** Always shown */
  error(tag, ...args) {
    console.error(`${formatTag(tag)} ${RED}ERROR${RESET}`, ...args);
  },

  /** Only shown in debug mode */
  debug(tag, ...args) {
    if (!isDebug) return;
    console.log(`${formatTag(tag)} ${MAGENTA}DEBUG${RESET}`, ...args);
  },

  /** Only shown in debug mode — logs object as JSON */
  debugJson(tag, label, obj) {
    if (!isDebug) return;
    console.log(`${formatTag(tag)} ${MAGENTA}DEBUG${RESET} ${label}:`, JSON.stringify(obj, null, 2));
  },

  get isDebug() {
    return isDebug;
  },
};

export default logger;

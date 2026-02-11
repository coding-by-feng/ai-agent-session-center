// serverConfig.js — Loads user config from data/server-config.json
// Falls back to defaults if file is missing (first run without wizard)

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'data', 'server-config.json');

const DEFAULTS = {
  port: 3333,
  hookDensity: 'medium',
  debug: false,
  processCheckInterval: 15000,
  sessionHistoryHours: 24,
  enabledClis: ['claude'],
};

let userConfig = {};
try {
  userConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch {
  // No config file yet — use defaults
}

export const config = { ...DEFAULTS, ...userConfig };

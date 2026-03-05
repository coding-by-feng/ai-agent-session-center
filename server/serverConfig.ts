// serverConfig.ts — Loads user config from data/server-config.json
// Falls back to defaults if file is missing (first run without wizard)

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ServerConfig } from '../src/types/settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// In packaged Electron, APP_USER_DATA is set to app.getPath('userData') — a writable directory.
// In dev/CLI mode, fall back to the local data/ directory.
const CONFIG_PATH = process.env.APP_USER_DATA
  ? join(process.env.APP_USER_DATA, 'server-config.json')
  : join(__dirname, '..', 'data', 'server-config.json');

const DEFAULTS: ServerConfig = {
  port: 3333,
  hookDensity: 'medium',
  debug: false,
  processCheckInterval: 15000,
  sessionHistoryHours: 24,
  enabledClis: ['claude'],
  passwordHash: null,
};

let userConfig: Partial<ServerConfig> = {};
try {
  userConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch {
  // No config file yet — use defaults
}

export const config: ServerConfig = { ...DEFAULTS, ...userConfig };

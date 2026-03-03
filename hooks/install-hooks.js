// install-hooks.js — CLI entry point.
// Thin wrapper around install-hooks-api.js: parses CLI args, calls installHooks(), handles process.exit.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { installHooks } from './install-hooks-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// ── ANSI colors ──
const RESET   = '\x1b[0m';
const BOLD    = '\x1b[1m';
const DIM     = '\x1b[2m';
const GREEN   = '\x1b[32m';
const YELLOW  = '\x1b[33m';
const RED     = '\x1b[31m';
const CYAN    = '\x1b[36m';

const VALID_DENSITIES = ['high', 'medium', 'low'];

// Parse CLI flags, then fall back to saved config
let density = 'medium';
let enabledClis = ['claude'];

const densityArgIdx = process.argv.indexOf('--density');
if (densityArgIdx >= 0 && process.argv[densityArgIdx + 1]) {
  const val = process.argv[densityArgIdx + 1].toLowerCase();
  if (VALID_DENSITIES.includes(val)) {
    density = val;
  } else {
    console.error(`${RED}ERROR${RESET} Invalid density: "${val}" (use: high, medium, low)`);
    process.exit(1);
  }
} else {
  // Read from saved config if no CLI flag
  try {
    const configPath = join(PROJECT_ROOT, 'data', 'server-config.json');
    const savedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    if (savedConfig.hookDensity && VALID_DENSITIES.includes(savedConfig.hookDensity)) {
      density = savedConfig.hookDensity;
    }
    if (savedConfig.enabledClis) enabledClis = savedConfig.enabledClis;
  } catch { /* no saved config, use default */ }
}

// Parse --clis flag (e.g., --clis claude,gemini,codex)
const clisArgIdx = process.argv.indexOf('--clis');
if (clisArgIdx >= 0 && process.argv[clisArgIdx + 1]) {
  enabledClis = process.argv[clisArgIdx + 1].split(',').map(s => s.trim().toLowerCase());
}

const uninstallMode = process.argv.includes('--uninstall');
const quietMode = process.argv.includes('--quiet');

// ── Banner ──
if (!quietMode) {
  console.log(`\n${CYAN}\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E${RESET}`);
  console.log(`${CYAN}\u2502${RESET}  ${BOLD}AI Agent Session Center \u2014 Hook Setup${RESET}          ${CYAN}\u2502${RESET}`);
  console.log(`${CYAN}\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F${RESET}`);
}

// Run the API and handle exit
installHooks({
  density,
  enabledClis,
  projectRoot: PROJECT_ROOT,
  uninstall: uninstallMode,
  onLog: (line) => console.log(`  ${DIM}\u2192${RESET} ${line}`),
}).then((result) => {
  if (result.success) {
    console.log(`\n${GREEN}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${RESET}`);
    console.log(`  ${GREEN}\u2713 Done!${RESET}`);
    console.log(`${GREEN}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${RESET}`);
    if (!uninstallMode) {
      console.log(`\n  Start the dashboard: ${BOLD}npm start${RESET}\n`);
    }
    process.exit(0);
  } else {
    console.log(`\n${YELLOW}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${RESET}`);
    console.log(`  ${YELLOW}\u26A0 Setup completed with warnings${RESET}`);
    console.log(`${YELLOW}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${RESET}\n`);
    process.exit(0);
  }
}).catch((err) => {
  console.error(`\n${RED}ERROR${RESET}: ${err.message}`);
  process.exit(1);
});

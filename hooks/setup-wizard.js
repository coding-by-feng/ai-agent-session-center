import { createInterface } from 'readline';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CONFIG_PATH = join(PROJECT_ROOT, 'data', 'server-config.json');

// ── ANSI colors ──
const RESET   = '\x1b[0m';
const BOLD    = '\x1b[1m';
const DIM     = '\x1b[2m';
const GREEN   = '\x1b[32m';
const YELLOW  = '\x1b[33m';
const RED     = '\x1b[31m';
const CYAN    = '\x1b[36m';

const ok   = (msg) => console.log(`  ${GREEN}✓${RESET} ${msg}`);
const info = (msg) => console.log(`  ${DIM}→${RESET} ${msg}`);

// ── Load existing config (if re-running setup) ──
let existing = {};
try {
  existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch { /* first run */ }

// ── readline helper ──
const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

async function choose(stepNum, totalSteps, label, options, defaultIdx = 0) {
  console.log(`\n${CYAN}[${stepNum}/${totalSteps}]${RESET} ${BOLD}${label}${RESET}`);
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIdx ? ` ${GREEN}← default${RESET}` : '';
    console.log(`  ${DIM}[${i + 1}]${RESET} ${options[i].label}${marker}`);
  }
  const answer = await ask(`  ${DIM}>${RESET} `);
  const idx = answer.trim() === '' ? defaultIdx : parseInt(answer.trim(), 10) - 1;
  if (idx < 0 || idx >= options.length || isNaN(idx)) {
    console.log(`  ${YELLOW}Invalid choice, using default${RESET}`);
    return options[defaultIdx];
  }
  return options[idx];
}

async function askValue(stepNum, totalSteps, label, defaultVal) {
  console.log(`\n${CYAN}[${stepNum}/${totalSteps}]${RESET} ${BOLD}${label}${RESET}`);
  const answer = await ask(`  ${DIM}(default: ${defaultVal}) >${RESET} `);
  return answer.trim() || String(defaultVal);
}

// ── Main ──
const TOTAL = 5;

console.log(`\n${CYAN}╭──────────────────────────────────────────────╮${RESET}`);
console.log(`${CYAN}│${RESET}  ${BOLD}Claude Session Center — Setup Wizard${RESET}        ${CYAN}│${RESET}`);
console.log(`${CYAN}╰──────────────────────────────────────────────╯${RESET}`);

if (Object.keys(existing).length > 0) {
  info(`Existing config found — current values shown as defaults`);
}

// 1. Port
const portStr = await askValue(1, TOTAL, 'Server port', existing.port || 3333);
const port = parseInt(portStr, 10) || 3333;

// 2. Hook density
const densityOptions = [
  { label: `high    ${DIM}— All 9 events (PreToolUse, PostToolUse, etc.)${RESET}`, value: 'high' },
  { label: `medium  ${DIM}— 7 events (skip Pre/PostToolUse)${RESET}`, value: 'medium' },
  { label: `low     ${DIM}— 4 events (minimal: start, prompt, stop, end)${RESET}`, value: 'low' },
];
const currentDensityIdx = densityOptions.findIndex(o => o.value === (existing.hookDensity || 'medium'));
const density = await choose(2, TOTAL, 'Hook trace density', densityOptions, currentDensityIdx >= 0 ? currentDensityIdx : 1);

// 3. Debug mode
const debugOptions = [
  { label: `Off`, value: false },
  { label: `On  ${DIM}— Verbose logging for troubleshooting${RESET}`, value: true },
];
const currentDebugIdx = existing.debug ? 1 : 0;
const debug = await choose(3, TOTAL, 'Debug mode?', debugOptions, currentDebugIdx);

// 4. Process liveness check interval
const processOptions = [
  { label: `Fast    ${DIM}— Every 5 seconds (more responsive, slightly more CPU)${RESET}`, value: 5000 },
  { label: `Normal  ${DIM}— Every 15 seconds${RESET}`, value: 15000 },
  { label: `Relaxed ${DIM}— Every 30 seconds (less CPU)${RESET}`, value: 30000 },
];
const currentProcIdx = processOptions.findIndex(o => o.value === (existing.processCheckInterval || 15000));
const procCheck = await choose(4, TOTAL, 'Process liveness check interval', processOptions, currentProcIdx >= 0 ? currentProcIdx : 1);

// 5. Session history retention
const historyOptions = [
  { label: `12 hours`, value: 12 },
  { label: `24 hours`, value: 24 },
  { label: `48 hours`, value: 48 },
  { label: `7 days`, value: 168 },
];
const currentHistIdx = historyOptions.findIndex(o => o.value === (existing.sessionHistoryHours || 24));
const history = await choose(5, TOTAL, 'Session history retention', historyOptions, currentHistIdx >= 0 ? currentHistIdx : 1);

rl.close();

// ── Save config ──
const configData = {
  port,
  hookDensity: density.value,
  debug: debug.value,
  processCheckInterval: procCheck.value,
  sessionHistoryHours: history.value,
};

const dataDir = join(PROJECT_ROOT, 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
writeFileSync(CONFIG_PATH, JSON.stringify(configData, null, 2) + '\n');
console.log('');
ok(`Config saved to ${DIM}data/server-config.json${RESET}`);

// ── Print chosen config ──
info(`Port: ${BOLD}${configData.port}${RESET}`);
info(`Hook density: ${BOLD}${configData.hookDensity}${RESET}`);
info(`Debug: ${BOLD}${configData.debug ? 'ON' : 'OFF'}${RESET}`);
info(`Process check: ${BOLD}${configData.processCheckInterval / 1000}s${RESET}`);
info(`History retention: ${BOLD}${configData.sessionHistoryHours}h${RESET}`);

// ── Install hooks with chosen density ──
console.log('');
info('Installing hooks...');
try {
  execSync(`node "${join(__dirname, 'install-hooks.js')}" --density ${configData.hookDensity}`, {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
  });
} catch (e) {
  console.log(`  ${RED}✗${RESET} Hook installation failed: ${e.message}`);
}

console.log(`\n${GREEN}────────────────────────────────────────────────${RESET}`);
console.log(`  ${GREEN}✓ Setup complete! Starting server...${RESET}`);
console.log(`${GREEN}────────────────────────────────────────────────${RESET}\n`);

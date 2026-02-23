import { createInterface } from 'readline';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { scryptSync, randomBytes } from 'crypto';

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
let rlClosed = false;

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

// ── Password helpers ──
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Validate password complexity:
 * - At least 8 characters
 * - At least 1 uppercase letter
 * - At least 1 lowercase letter
 * - At least 1 digit
 * - At least 1 special character
 * Returns { valid: boolean, errors: string[] }
 */
function validatePassword(password) {
  const errors = [];
  if (password.length < 8) errors.push('at least 8 characters');
  if (!/[A-Z]/.test(password)) errors.push('at least 1 uppercase letter');
  if (!/[a-z]/.test(password)) errors.push('at least 1 lowercase letter');
  if (!/[0-9]/.test(password)) errors.push('at least 1 digit');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('at least 1 special character (!@#$%^&* etc.)');
  return { valid: errors.length === 0, errors };
}

async function askPassword(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    let input = '';
    const onData = (ch) => {
      const c = ch.toString();
      if (c === '\n' || c === '\r') {
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw || false);
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (c === '\u007f' || c === '\b') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (c === '\u0003') {
        // Ctrl+C
        process.exit(1);
      } else {
        input += c;
        process.stdout.write('*');
      }
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

// ── Main ──
const TOTAL = 6;

console.log(`\n${CYAN}╭──────────────────────────────────────────────╮${RESET}`);
console.log(`${CYAN}│${RESET}  ${BOLD}AI Agent Session Center — Setup Wizard${RESET}        ${CYAN}│${RESET}`);
console.log(`${CYAN}╰──────────────────────────────────────────────╯${RESET}`);

if (Object.keys(existing).length > 0) {
  info(`Existing config found — current values shown as defaults`);
}

// 1. Port
let port;
{
  const defaultPort = 3333;
  console.log(`\n${CYAN}[1/${TOTAL}]${RESET} ${BOLD}Server port${RESET}`);
  while (true) {
    const answer = await ask(`  ${DIM}(default: ${defaultPort}) >${RESET} `);
    const val = answer.trim() === '' ? defaultPort : parseInt(answer.trim(), 10);
    if (!isNaN(val) && val >= 1 && val <= 65535) { port = val; break; }
    console.log(`  ${RED}✗ Port must be a number between 1 and 65535${RESET}`);
  }
}

// 2. AI CLI selection
const cliOptions = [
  { label: `Claude Code only`, value: ['claude'] },
  { label: `Claude Code + Gemini CLI`, value: ['claude', 'gemini'] },
  { label: `Claude Code + Codex CLI`, value: ['claude', 'codex'] },
  { label: `All (Claude + Gemini + Codex)`, value: ['claude', 'gemini', 'codex'] },
];
const currentCliIdx = (() => {
  const ec = existing.enabledClis || ['claude'];
  if (ec.length === 1 && ec[0] === 'claude') return 0;
  if (ec.length === 2 && ec.includes('gemini')) return 1;
  if (ec.length === 2 && ec.includes('codex')) return 2;
  if (ec.length === 3) return 3;
  return 0;
})();
const cliChoice = await choose(2, TOTAL, 'Which AI CLIs do you want to hook?', cliOptions, currentCliIdx);

// 3. Hook density
const densityOptions = [
  { label: `high    ${DIM}— All 14 events (includes TeammateIdle, PreCompact)${RESET}`, value: 'high' },
  { label: `medium  ${DIM}— 12 events (best balance of detail vs overhead)${RESET}`, value: 'medium' },
  { label: `low     ${DIM}— 5 events (minimal: start, prompt, permission, stop, end)${RESET}`, value: 'low' },
];
const currentDensityIdx = densityOptions.findIndex(o => o.value === (existing.hookDensity || 'medium'));
const density = await choose(3, TOTAL, 'Hook trace density', densityOptions, currentDensityIdx >= 0 ? currentDensityIdx : 1);

// 4. Debug mode
const debugOptions = [
  { label: `Off`, value: false },
  { label: `On  ${DIM}— Verbose logging for troubleshooting${RESET}`, value: true },
];
const currentDebugIdx = existing.debug ? 1 : 0;
const debug = await choose(4, TOTAL, 'Debug mode?', debugOptions, currentDebugIdx);

// 5. Session history retention
const historyOptions = [
  { label: `12 hours`, value: 12 },
  { label: `24 hours`, value: 24 },
  { label: `48 hours`, value: 48 },
  { label: `7 days`, value: 168 },
];
const currentHistIdx = historyOptions.findIndex(o => o.value === (existing.sessionHistoryHours || 24));
const history = await choose(5, TOTAL, 'Session history retention', historyOptions, currentHistIdx >= 0 ? currentHistIdx : 1);

// 6. Dashboard password
const hasExistingPassword = Boolean(existing.passwordHash);
let passwordHash = null;

if (hasExistingPassword) {
  const pwOptions = [
    { label: `Keep current password`, value: 'keep' },
    { label: `Change password`, value: 'change' },
    { label: `Remove password ${DIM}— no login required${RESET}`, value: 'remove' },
  ];
  const pwChoice = await choose(6, TOTAL, 'Dashboard password', pwOptions, 0);
  if (pwChoice.value === 'keep') {
    passwordHash = existing.passwordHash;
  } else if (pwChoice.value === 'change') {
    rl.close(); rlClosed = true;
    console.log(`  ${DIM}Requirements: 8+ chars, uppercase, lowercase, digit, special char${RESET}`);
    let pw;
    while (true) {
      pw = await askPassword(`  ${DIM}New password:${RESET} `);
      const check = validatePassword(pw);
      if (check.valid) break;
      console.log(`  ${RED}✗ Password must have: ${check.errors.join(', ')}${RESET}`);
    }
    let confirm;
    while (true) {
      confirm = await askPassword(`  ${DIM}Confirm password:${RESET} `);
      if (pw === confirm) break;
      console.log(`  ${RED}✗ Passwords do not match — try again${RESET}`);
    }
    passwordHash = hashPassword(pw);
    ok('Password updated');
  } else {
    passwordHash = null;
    ok('Password removed — no login required');
  }
} else {
  const pwOptions = [
    { label: `No password ${DIM}— open access on localhost${RESET}`, value: 'none' },
    { label: `Set a password ${DIM}— require login${RESET}`, value: 'set' },
  ];
  const pwChoice = await choose(6, TOTAL, 'Dashboard password (optional)', pwOptions, 1);
  if (pwChoice.value === 'set') {
    rl.close(); rlClosed = true;
    console.log(`  ${DIM}Requirements: 8+ chars, uppercase, lowercase, digit, special char${RESET}`);
    let pw;
    while (true) {
      pw = await askPassword(`  ${DIM}Enter password:${RESET} `);
      const check = validatePassword(pw);
      if (check.valid) break;
      console.log(`  ${RED}✗ Password must have: ${check.errors.join(', ')}${RESET}`);
    }
    let confirm;
    while (true) {
      confirm = await askPassword(`  ${DIM}Confirm password:${RESET} `);
      if (pw === confirm) break;
      console.log(`  ${RED}✗ Passwords do not match — try again${RESET}`);
    }
    passwordHash = hashPassword(pw);
    ok('Password set — login will be required');
  }
}

if (!rlClosed) { rl.close(); rlClosed = true; }

// ── Save config ──
const configData = {
  port,
  enabledClis: cliChoice.value,
  hookDensity: density.value,
  debug: debug.value,
  sessionHistoryHours: history.value,
  ...(passwordHash ? { passwordHash } : {}),
};

const dataDir = join(PROJECT_ROOT, 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
writeFileSync(CONFIG_PATH, JSON.stringify(configData, null, 2) + '\n');
console.log('');
ok(`Config saved to ${DIM}data/server-config.json${RESET}`);

// ── Print chosen config ──
info(`Port: ${BOLD}${configData.port}${RESET}`);
info(`Enabled CLIs: ${BOLD}${configData.enabledClis.join(', ')}${RESET}`);
info(`Hook density: ${BOLD}${configData.hookDensity}${RESET}`);
info(`Debug: ${BOLD}${configData.debug ? 'ON' : 'OFF'}${RESET}`);
info(`History retention: ${BOLD}${configData.sessionHistoryHours}h${RESET}`);
info(`Password: ${BOLD}${configData.passwordHash ? 'Enabled' : 'Disabled'}${RESET}`);

// ── Install hooks with chosen density ──
console.log('');
info('Installing hooks...');
try {
  execSync(`node "${join(__dirname, 'install-hooks.js')}" --density ${configData.hookDensity} --clis ${configData.enabledClis.join(',')}`, {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
  });
} catch (e) {
  console.log(`  ${RED}✗${RESET} Hook installation failed: ${e.message}`);
}

console.log(`\n${GREEN}────────────────────────────────────────────────${RESET}`);
console.log(`  ${GREEN}✓ Setup complete!${RESET}`);
console.log(`${GREEN}────────────────────────────────────────────────${RESET}`);
console.log(`\n  Starting server on port ${BOLD}${configData.port}${RESET}...\n`);

// Unref stdin so the event loop can exit naturally (askPassword's resume() keeps it alive)
process.stdin.unref();

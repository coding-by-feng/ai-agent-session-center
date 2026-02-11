import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync, copyFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const isWindows = process.platform === 'win32';

// ── ANSI colors ──
const RESET   = '\x1b[0m';
const BOLD    = '\x1b[1m';
const DIM     = '\x1b[2m';
const GREEN   = '\x1b[32m';
const YELLOW  = '\x1b[33m';
const RED     = '\x1b[31m';
const CYAN    = '\x1b[36m';

const ok   = (msg) => console.log(`  ${GREEN}✓${RESET} ${msg}`);
const warn = (msg) => console.log(`  ${YELLOW}⚠${RESET} ${msg}`);
const info = (msg) => console.log(`  ${DIM}→${RESET} ${msg}`);
const step = (n, total, label) => console.log(`\n${CYAN}[${n}/${total}]${RESET} ${BOLD}${label}${RESET}`);

// ── Paths ──
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const HOOKS_DIR = join(homedir(), '.claude', 'hooks');
const HOOK_PATTERN = 'dashboard-hook.';
const DATA_DIR = join(PROJECT_ROOT, 'data');
const BACKUP_DIR = join(PROJECT_ROOT, 'data', 'backups');
const MQ_DIR = isWindows
  ? join(process.env.TEMP || process.env.TMP || 'C:\\Temp', 'claude-session-center')
  : '/tmp/claude-session-center';

const ALL_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Stop', 'Notification', 'SubagentStart', 'SubagentStop', 'SessionEnd'
];

const TOTAL_STEPS = 5;

// ── Banner ──
console.log(`\n${RED}╭──────────────────────────────────────────────╮${RESET}`);
console.log(`${RED}│${RESET}  ${BOLD}Claude Session Center — Full Reset${RESET}          ${RED}│${RESET}`);
console.log(`${RED}╰──────────────────────────────────────────────╯${RESET}`);

// ═══════════════════════════════════════════════
// STEP 1: Create backup
// ═══════════════════════════════════════════════
step(1, TOTAL_STEPS, 'Backing up current state...');

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const backupPath = join(BACKUP_DIR, `reset-${timestamp}`);
mkdirSync(backupPath, { recursive: true });
ok(`Backup directory: ${DIM}${backupPath}${RESET}`);

let backedUp = 0;

// Backup server-config.json
const configPath = join(DATA_DIR, 'server-config.json');
if (existsSync(configPath)) {
  copyFileSync(configPath, join(backupPath, 'server-config.json'));
  ok('Backed up server-config.json');
  backedUp++;
}

// Backup sessions.db
const dbPath = join(DATA_DIR, 'sessions.db');
if (existsSync(dbPath)) {
  copyFileSync(dbPath, join(backupPath, 'sessions.db'));
  ok('Backed up sessions.db');
  backedUp++;
}

// Backup ~/.claude/settings.json
if (existsSync(SETTINGS_PATH)) {
  copyFileSync(SETTINGS_PATH, join(backupPath, 'claude-settings.json'));
  ok('Backed up ~/.claude/settings.json');
  backedUp++;
}

// Backup deployed hook scripts
for (const script of ['dashboard-hook.sh', 'dashboard-hook.ps1']) {
  const deployed = join(HOOKS_DIR, script);
  if (existsSync(deployed)) {
    copyFileSync(deployed, join(backupPath, script));
    ok(`Backed up ${script}`);
    backedUp++;
  }
}

info(`${backedUp} file(s) backed up`);

// ═══════════════════════════════════════════════
// STEP 2: Remove hooks from ~/.claude/settings.json
// ═══════════════════════════════════════════════
step(2, TOTAL_STEPS, 'Removing dashboard hooks from settings...');

if (existsSync(SETTINGS_PATH)) {
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    let removed = 0;

    if (settings.hooks) {
      for (const event of ALL_EVENTS) {
        if (!settings.hooks[event]) continue;
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter(group =>
          !group.hooks?.some(h => h.command?.includes(HOOK_PATTERN))
        );
        if (settings.hooks[event].length === 0) {
          delete settings.hooks[event];
        }
        const diff = before - (settings.hooks[event]?.length ?? 0);
        if (diff > 0) {
          removed += diff;
          ok(`Removed hook for ${event}`);
        }
      }

      // Clean up empty hooks object
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
    }

    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');

    if (removed > 0) {
      ok(`${removed} dashboard hook(s) removed from settings`);
    } else {
      info('No dashboard hooks found in settings');
    }

    // Report preserved hooks
    const remainingEvents = Object.keys(settings.hooks || {});
    if (remainingEvents.length > 0) {
      info(`${YELLOW}Preserved${RESET} ${remainingEvents.length} non-dashboard hook event(s): ${remainingEvents.join(', ')}`);
    }
  } catch (e) {
    warn(`Could not parse settings: ${e.message}`);
  }
} else {
  info('No settings file found');
}

// ═══════════════════════════════════════════════
// STEP 3: Remove deployed hook scripts
// ═══════════════════════════════════════════════
step(3, TOTAL_STEPS, 'Removing deployed hook scripts...');

for (const script of ['dashboard-hook.sh', 'dashboard-hook.ps1']) {
  const deployed = join(HOOKS_DIR, script);
  if (existsSync(deployed)) {
    unlinkSync(deployed);
    ok(`Removed ${deployed}`);
  } else {
    info(`${script} not found ${DIM}(already clean)${RESET}`);
  }
}

// ═══════════════════════════════════════════════
// STEP 4: Clean local data
// ═══════════════════════════════════════════════
step(4, TOTAL_STEPS, 'Cleaning local data...');

// Remove server-config.json
if (existsSync(configPath)) {
  unlinkSync(configPath);
  ok('Removed server-config.json');
} else {
  info('server-config.json not found');
}

// Remove sessions.db + WAL files
for (const dbFile of ['sessions.db', 'sessions.db-shm', 'sessions.db-wal']) {
  const p = join(DATA_DIR, dbFile);
  if (existsSync(p)) {
    unlinkSync(p);
    ok(`Removed ${dbFile}`);
  }
}

// Remove MQ queue directory
if (existsSync(MQ_DIR)) {
  rmSync(MQ_DIR, { recursive: true, force: true });
  ok(`Removed MQ directory: ${MQ_DIR}`);
} else {
  info('MQ directory not found');
}

// ═══════════════════════════════════════════════
// STEP 5: Summary
// ═══════════════════════════════════════════════
step(5, TOTAL_STEPS, 'Summary');

// List backup contents
const backupFiles = readdirSync(backupPath);
info(`Backup location: ${BOLD}${backupPath}${RESET}`);
for (const f of backupFiles) {
  info(`  ${DIM}${f}${RESET}`);
}

console.log(`\n${GREEN}────────────────────────────────────────────────${RESET}`);
console.log(`  ${GREEN}✓ Reset complete${RESET}`);
console.log(`${GREEN}────────────────────────────────────────────────${RESET}`);
console.log(`\n  To set up again: ${BOLD}npm run setup${RESET}`);
console.log(`  To restore backup: ${DIM}cp ${backupPath}/* data/${RESET}\n`);

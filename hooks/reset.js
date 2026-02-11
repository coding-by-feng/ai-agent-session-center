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
const GEMINI_SETTINGS_PATH = join(homedir(), '.gemini', 'settings.json');
const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
const HOOKS_DIR = join(homedir(), '.claude', 'hooks');
const GEMINI_HOOKS_DIR = join(homedir(), '.gemini', 'hooks');
const CODEX_HOOKS_DIR = join(homedir(), '.codex', 'hooks');
const HOOK_PATTERN = 'dashboard-hook';
const HOOK_SOURCE = 'ai-agent-session-center'; // Must match the _source marker in hook groups
const DATA_DIR = join(PROJECT_ROOT, 'data');
const BACKUP_DIR = join(PROJECT_ROOT, 'data', 'backups');
const MQ_DIR = isWindows
  ? join(process.env.TEMP || process.env.TMP || 'C:\\Temp', 'claude-session-center')
  : '/tmp/claude-session-center';

const ALL_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop',
  'TeammateIdle', 'TaskCompleted', 'PreCompact', 'SessionEnd'
];

const GEMINI_ALL_EVENTS = [
  'SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool',
  'AfterAgent', 'SessionEnd', 'Notification'
];

const TOTAL_STEPS = 6;

// ── Banner ──
console.log(`\n${RED}╭──────────────────────────────────────────────╮${RESET}`);
console.log(`${RED}│${RESET}  ${BOLD}AI Agent Session Center — Full Reset${RESET}          ${RED}│${RESET}`);
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

// Backup deployed hook scripts (Claude)
for (const script of ['dashboard-hook.sh', 'dashboard-hook.ps1']) {
  const deployed = join(HOOKS_DIR, script);
  if (existsSync(deployed)) {
    copyFileSync(deployed, join(backupPath, `claude-${script}`));
    ok(`Backed up Claude ${script}`);
    backedUp++;
  }
}

// Backup ~/.gemini/settings.json
if (existsSync(GEMINI_SETTINGS_PATH)) {
  copyFileSync(GEMINI_SETTINGS_PATH, join(backupPath, 'gemini-settings.json'));
  ok('Backed up ~/.gemini/settings.json');
  backedUp++;
}

// Backup Gemini hook script
const geminiHook = join(GEMINI_HOOKS_DIR, 'dashboard-hook.sh');
if (existsSync(geminiHook)) {
  copyFileSync(geminiHook, join(backupPath, 'gemini-dashboard-hook.sh'));
  ok('Backed up Gemini dashboard-hook.sh');
  backedUp++;
}

// Backup ~/.codex/config.toml
if (existsSync(CODEX_CONFIG_PATH)) {
  copyFileSync(CODEX_CONFIG_PATH, join(backupPath, 'codex-config.toml'));
  ok('Backed up ~/.codex/config.toml');
  backedUp++;
}

// Backup Codex hook script
const codexHook = join(CODEX_HOOKS_DIR, 'dashboard-hook.sh');
if (existsSync(codexHook)) {
  copyFileSync(codexHook, join(backupPath, 'codex-dashboard-hook.sh'));
  ok('Backed up Codex dashboard-hook.sh');
  backedUp++;
}

info(`${backedUp} file(s) backed up`);

// ═══════════════════════════════════════════════
// STEP 2: Remove hooks from all CLI settings
// ═══════════════════════════════════════════════
step(2, TOTAL_STEPS, 'Removing dashboard hooks from settings...');

// Helper: check if a hook group belongs to this project
// Uses dual matching: _source marker (preferred) OR command pattern (legacy/fallback)
function isOurHookGroup(group) {
  if (group._source === HOOK_SOURCE) return true;
  return group.hooks?.some(h => h.command?.includes(HOOK_PATTERN));
}

// Helper: clean dashboard hooks from a JSON settings file
// SAFETY: Only removes hook groups that match our _source marker or command pattern.
//         All other hooks (user's custom hooks, other tools) are preserved untouched.
function cleanJsonSettings(path, events, label) {
  if (!existsSync(path)) {
    info(`${label} settings not found — skipping`);
    return;
  }
  try {
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    let removed = 0;
    let preserved = 0;

    if (settings.hooks) {
      // Only iterate events we know about — never touch unknown event keys
      for (const event of events) {
        if (!settings.hooks[event]) continue;
        const before = settings.hooks[event].length;
        const kept = [];
        for (const group of settings.hooks[event]) {
          if (isOurHookGroup(group)) {
            ok(`[${label}] Removing hook for ${event}${group._source ? ' (source: ' + group._source + ')' : ''}`);
          } else {
            kept.push(group);
            preserved++;
          }
        }
        const diff = before - kept.length;
        if (diff > 0) removed += diff;
        if (kept.length === 0) {
          delete settings.hooks[event];
        } else {
          settings.hooks[event] = kept;
        }
      }

      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
    }

    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');

    if (removed > 0) {
      ok(`[${label}] ${removed} dashboard hook(s) removed`);
    } else {
      info(`[${label}] No dashboard hooks found`);
    }

    // Report all preserved hooks in detail so user can verify nothing was touched
    const remainingEvents = Object.keys(settings.hooks || {});
    if (remainingEvents.length > 0) {
      info(`${YELLOW}Preserved${RESET} ${preserved} non-dashboard hook(s) across ${remainingEvents.length} event(s) in ${label}:`);
      for (const event of remainingEvents) {
        const groups = settings.hooks[event] || [];
        for (const group of groups) {
          const cmds = (group.hooks || []).map(h => h.command || h.type || '?').join(', ');
          info(`  ${DIM}${event}: ${cmds}${RESET}`);
        }
      }
    }
  } catch (e) {
    warn(`Could not parse ${label} settings: ${e.message}`);
  }
}

// Claude
cleanJsonSettings(SETTINGS_PATH, ALL_EVENTS, 'Claude');

// Gemini
cleanJsonSettings(GEMINI_SETTINGS_PATH, GEMINI_ALL_EVENTS, 'Gemini');

// Codex (TOML — remove only our comment + notify lines)
// SAFETY: Only removes lines matching our comment marker or the specific dashboard-hook notify.
//         All other Codex config lines are preserved untouched.
if (existsSync(CODEX_CONFIG_PATH)) {
  try {
    const toml = readFileSync(CODEX_CONFIG_PATH, 'utf8');
    const lines = toml.split('\n');
    const kept = [];
    let removed = 0;
    for (const line of lines) {
      const isOurComment = line.includes(`[${HOOK_SOURCE}]`);
      const isOurNotify = line.includes(HOOK_PATTERN) && line.trimStart().startsWith('notify');
      if (isOurComment || isOurNotify) {
        ok(`[Codex] Removing line: ${DIM}${line.trim()}${RESET}`);
        removed++;
      } else {
        kept.push(line);
      }
    }
    if (removed > 0) {
      writeFileSync(CODEX_CONFIG_PATH, kept.join('\n'));
      ok(`[Codex] ${removed} line(s) removed from config.toml`);
      // Show what's left
      const remaining = kept.filter(l => l.trim()).length;
      if (remaining > 0) {
        info(`${YELLOW}Preserved${RESET} ${remaining} other line(s) in Codex config.toml`);
      }
    } else {
      info('[Codex] No dashboard hooks found in config.toml');
    }
  } catch (e) {
    warn(`Could not parse Codex config: ${e.message}`);
  }
} else {
  info('Codex config.toml not found');
}

// ═══════════════════════════════════════════════
// STEP 3: Remove deployed hook scripts
// ═══════════════════════════════════════════════
step(3, TOTAL_STEPS, 'Removing deployed hook scripts...');

// SAFETY: Verify file content belongs to our project before deleting.
// Only remove scripts that contain "AI Agent Session Center" or "claude-session-center" identifiers.
function safeRemoveHookScript(filePath, label) {
  if (!existsSync(filePath)) {
    info(`${label} not found ${DIM}(already clean)${RESET}`);
    return;
  }
  try {
    const content = readFileSync(filePath, 'utf8');
    const isOurs = content.includes('AI Agent Session Center')
      || content.includes('claude-session-center')
      || content.includes(HOOK_SOURCE);
    if (isOurs) {
      unlinkSync(filePath);
      ok(`Removed ${label}: ${DIM}${filePath}${RESET}`);
    } else {
      warn(`${YELLOW}SKIPPED${RESET} ${label}: ${filePath} — file does not contain our project marker, may belong to another tool`);
    }
  } catch (e) {
    warn(`Could not verify ${label}: ${e.message}`);
  }
}

// Claude hooks
for (const script of ['dashboard-hook.sh', 'dashboard-hook.ps1']) {
  safeRemoveHookScript(join(HOOKS_DIR, script), `Claude ${script}`);
}

// Gemini hook
safeRemoveHookScript(join(GEMINI_HOOKS_DIR, 'dashboard-hook.sh'), 'Gemini dashboard-hook.sh');

// Codex hook
safeRemoveHookScript(join(CODEX_HOOKS_DIR, 'dashboard-hook.sh'), 'Codex dashboard-hook.sh');

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
// STEP 5: Clear browser IndexedDB (if server is running)
// ═══════════════════════════════════════════════
step(5, TOTAL_STEPS, 'Clearing browser IndexedDB...');

try {
  const resp = await fetch('http://localhost:3333/api/reset', { method: 'POST', signal: AbortSignal.timeout(2000) });
  if (resp.ok) {
    ok('Sent clearBrowserDb signal to all connected browsers');
  } else {
    warn(`Server responded with ${resp.status}`);
  }
} catch {
  info('Server not running — browser DB will be cleared on next connect (empty snapshot)');
}

// ═══════════════════════════════════════════════
// STEP 6: Summary
// ═══════════════════════════════════════════════
step(6, TOTAL_STEPS, 'Summary');

// List backup contents
const backupFiles = readdirSync(backupPath);
info(`Backup location: ${BOLD}${backupPath}${RESET}`);
for (const f of backupFiles) {
  info(`  ${DIM}${f}${RESET}`);
}

console.log(`\n${GREEN}────────────────────────────────────────────────${RESET}`);
console.log(`  ${GREEN}✓ Reset complete${RESET}`);
console.log(`${GREEN}────────────────────────────────────────────────${RESET}`);
console.log(`\n  To set up again:    ${BOLD}npm run setup${RESET}  ${DIM}(interactive wizard)${RESET}`);
console.log(`  To quick start:     ${BOLD}npm start${RESET}      ${DIM}(uses defaults)${RESET}`);
console.log(`  To restore backup:  ${DIM}cp ${backupPath}/* data/${RESET}\n`);

import { readFileSync, writeFileSync, copyFileSync, chmodSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';

// Atomic JSON file write: writes to temp file, then renames
function atomicWriteJSON(filePath, data) {
  const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

// ── ANSI colors ──
const RESET   = '\x1b[0m';
const BOLD    = '\x1b[1m';
const DIM     = '\x1b[2m';
const GREEN   = '\x1b[32m';
const YELLOW  = '\x1b[33m';
const RED     = '\x1b[31m';
const CYAN    = '\x1b[36m';
const MAGENTA = '\x1b[35m';

// ── Log helpers ──
const ok    = (msg) => console.log(`  ${GREEN}✓${RESET} ${msg}`);
const warn  = (msg) => console.log(`  ${YELLOW}⚠${RESET} ${msg}`);
const fail  = (msg) => console.log(`  ${RED}✗${RESET} ${msg}`);
const info  = (msg) => console.log(`  ${DIM}→${RESET} ${msg}`);
const step  = (n, total, label) => console.log(`\n${CYAN}[${n}/${total}]${RESET} ${BOLD}${label}${RESET}`);

// ── Platform-specific hook config ──
const HOOK_SCRIPT = isWindows ? 'dashboard-hook.ps1' : 'dashboard-hook.sh';
const HOOKS_DIR = join(homedir(), '.claude', 'hooks');
const HOOK_DEST = join(HOOKS_DIR, HOOK_SCRIPT);
const HOOK_COMMAND = isWindows
  ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${HOOK_DEST}"`
  : '~/.claude/hooks/dashboard-hook.sh';
const HOOK_PATTERN = 'dashboard-hook.';
const HOOK_SOURCE = 'ai-agent-session-center'; // Marker to identify our hooks in settings

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

// All possible hook events (Claude Code supports 14 lifecycle events)
const ALL_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop',
  'TeammateIdle', 'TaskCompleted', 'PreCompact', 'SessionEnd'
];

// Density levels: which events to register
const DENSITY_EVENTS = {
  high: ALL_EVENTS,
  medium: [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PermissionRequest', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop',
    'TaskCompleted', 'SessionEnd'
  ],
  low: [
    'SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd'
  ]
};

// Parse CLI flags, then fall back to saved config
let density = 'medium';
let enabledClis = ['claude'];
const densityArgIdx = process.argv.indexOf('--density');
if (densityArgIdx >= 0 && process.argv[densityArgIdx + 1]) {
  const val = process.argv[densityArgIdx + 1].toLowerCase();
  if (DENSITY_EVENTS[val]) {
    density = val;
  } else {
    console.error(`${RED}ERROR${RESET} Invalid density: "${val}" (use: high, medium, low)`);
    process.exit(1);
  }
} else {
  // Read from saved config if no CLI flag
  try {
    const configPath = join(__dirname, '..', 'data', 'server-config.json');
    const savedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    if (savedConfig.hookDensity && DENSITY_EVENTS[savedConfig.hookDensity]) {
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

const EVENTS = DENSITY_EVENTS[density];
const TOTAL_STEPS = uninstallMode ? 4 : 6;

// Gemini events by density
const GEMINI_DENSITY_EVENTS = {
  high: ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'SessionEnd', 'Notification'],
  medium: ['SessionStart', 'BeforeAgent', 'AfterAgent', 'SessionEnd', 'Notification'],
  low: ['SessionStart', 'AfterAgent', 'SessionEnd'],
};
const GEMINI_EVENTS = GEMINI_DENSITY_EVENTS[density] || GEMINI_DENSITY_EVENTS.medium;

// ── Banner ──
if (!quietMode) {
  console.log(`\n${CYAN}╭──────────────────────────────────────────────╮${RESET}`);
  console.log(`${CYAN}│${RESET}  ${BOLD}AI Agent Session Center — Hook Setup${RESET}          ${CYAN}│${RESET}`);
  console.log(`${CYAN}╰──────────────────────────────────────────────╯${RESET}`);
}

// ═══════════════════════════════════════════════
// STEP 1: Platform Detection
// ═══════════════════════════════════════════════
step(1, TOTAL_STEPS, 'Detecting platform...');
ok(`Platform: ${process.platform} (${isWindows ? 'PowerShell' : 'Bash'} hook)`);
ok(`Architecture: ${process.arch}`);
ok(`Node.js: ${process.version}`);
ok(`Home directory: ${homedir()}`);
info(`Settings path: ${SETTINGS_PATH}`);
info(`Hooks directory: ${HOOKS_DIR}`);

if (uninstallMode) {
  info(`Mode: ${YELLOW}UNINSTALL${RESET} (removing all dashboard hooks)`);
} else {
  info(`Enabled CLIs: ${BOLD}${enabledClis.join(', ')}${RESET}`);
  info(`Density: ${BOLD}${density}${RESET} → ${EVENTS.length} of ${ALL_EVENTS.length} Claude events`);
  info(`Claude events: ${EVENTS.join(', ')}`);
  if (enabledClis.includes('gemini')) {
    info(`Gemini events: ${GEMINI_EVENTS.join(', ')}`);
  }
  if (enabledClis.includes('codex')) {
    info(`Codex: agent-turn-complete (only event)`);
  }
  const excluded = ALL_EVENTS.filter(e => !EVENTS.includes(e));
  if (excluded.length > 0) {
    info(`Excluded (Claude): ${DIM}${excluded.join(', ')}${RESET}`);
  }
}

// ═══════════════════════════════════════════════
// STEP 2: Dependency Check
// ═══════════════════════════════════════════════
step(2, TOTAL_STEPS, 'Checking dependencies...');

if (!isWindows && !uninstallMode) {
  // Check jq
  try {
    const jqPath = execSync('which jq', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const jqVersion = execSync('jq --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    ok(`jq: ${jqVersion} (${jqPath})`);
  } catch {
    warn(`jq: ${YELLOW}NOT FOUND${RESET} — hook will work but without PID/TTY/tab enrichment`);
    info(`Install jq for full session detection:`);
    info(`  ${DIM}brew install jq${RESET}   (macOS)`);
    info(`  ${DIM}apt install jq${RESET}    (Linux)`);
  }

  // Check curl
  try {
    const curlPath = execSync('which curl', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    ok(`curl: found (${curlPath})`);
  } catch {
    fail(`curl: ${RED}NOT FOUND${RESET} — hook cannot send data to dashboard!`);
    info('Install curl to enable hook communication');
  }

  // Check bash version
  try {
    const bashVersion = execSync('bash --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      .split('\n')[0].replace(/.*version\s+/, '').replace(/\(.*/, '').trim();
    ok(`bash: ${bashVersion}`);
  } catch {
    info('bash: version unknown');
  }
} else if (isWindows) {
  try {
    const psVersion = execSync('powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    ok(`PowerShell: ${psVersion}`);
  } catch {
    warn('PowerShell: version unknown');
  }
} else {
  info('Dependency check skipped (uninstall mode)');
}

// ═══════════════════════════════════════════════
// STEP 3: Prepare Directories & Read Settings
// ═══════════════════════════════════════════════
step(3, TOTAL_STEPS, 'Preparing directories & reading settings...');

// Ensure ~/.claude/hooks/ exists
if (existsSync(HOOKS_DIR)) {
  ok(`Hooks directory exists: ${HOOKS_DIR}`);
} else {
  mkdirSync(HOOKS_DIR, { recursive: true });
  ok(`Created hooks directory: ${HOOKS_DIR}`);
}

// Ensure ~/.claude/ exists
const claudeDir = join(homedir(), '.claude');
if (!existsSync(claudeDir)) {
  mkdirSync(claudeDir, { recursive: true });
  ok(`Created ~/.claude/ directory`);
}

// Read current settings
let settings;
try {
  const raw = readFileSync(SETTINGS_PATH, 'utf8');
  settings = JSON.parse(raw);
  const size = statSync(SETTINGS_PATH).size;
  ok(`Settings file loaded: ${SETTINGS_PATH} (${formatBytes(size)})`);

  // Report existing hooks
  const existingHookEvents = Object.keys(settings.hooks || {});
  if (existingHookEvents.length > 0) {
    info(`Existing hook events in settings: ${existingHookEvents.join(', ')}`);
    // Check for non-dashboard hooks
    for (const event of existingHookEvents) {
      const groups = settings.hooks[event] || [];
      const otherHooks = groups.filter(g => !g.hooks?.some(h => h.command?.includes(HOOK_PATTERN)));
      if (otherHooks.length > 0) {
        info(`  ${event}: ${otherHooks.length} non-dashboard hook(s) will be preserved`);
      }
    }
  } else {
    info('No existing hooks registered');
  }
} catch (err) {
  if (err.code === 'ENOENT') {
    settings = {};
    ok(`Creating new settings file: ${SETTINGS_PATH}`);
  } else {
    fail(`Failed to read settings: ${err.message}`);
    throw err;
  }
}

if (!settings.hooks) settings.hooks = {};

// ═══════════════════════════════════════════════
// UNINSTALL MODE
// ═══════════════════════════════════════════════
if (uninstallMode) {
  step(4, TOTAL_STEPS, 'Removing dashboard hooks...');

  let removed = 0;
  for (const event of ALL_EVENTS) {
    if (!settings.hooks[event]) continue;
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(group =>
      !group.hooks?.some(h => h.command?.includes(HOOK_PATTERN))
    );
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
    if (before !== (settings.hooks[event]?.length ?? 0)) {
      removed++;
      ok(`Removed hook for ${event}`);
    }
  }

  if (removed === 0) {
    info('No dashboard hooks were found to remove');
  }

  if (Object.keys(settings.hooks).length === 0) {
    settings.hooks = {};
  }

  atomicWriteJSON(SETTINGS_PATH, settings);
  ok(`Saved settings: ${removed} hook(s) removed`);

  // Summary
  printSummary(`Uninstall complete — ${removed} hook(s) removed`);
  process.exit(0);
}

// ═══════════════════════════════════════════════
// STEP 4: Configure Hook Events
// ═══════════════════════════════════════════════
step(4, TOTAL_STEPS, `Configuring hook events (density: ${density})...`);

let added = 0;
let updated = 0;
let unchanged = 0;
let removedCount = 0;

// Add/update hooks for events in the selected density
for (const event of EVENTS) {
  if (!settings.hooks[event]) settings.hooks[event] = [];

  const existingIdx = settings.hooks[event].findIndex(group =>
    group.hooks?.some(h => h.command?.includes(HOOK_PATTERN))
  );

  if (existingIdx >= 0) {
    const group = settings.hooks[event][existingIdx];
    const hookEntry = group.hooks.find(h => h.command?.includes(HOOK_PATTERN));
    if (hookEntry && hookEntry.command !== HOOK_COMMAND) {
      hookEntry.command = HOOK_COMMAND;
      ok(`Updated hook command for ${event}`);
      updated++;
    } else {
      info(`${event}: already registered ${DIM}(no change)${RESET}`);
      unchanged++;
    }
  } else {
    settings.hooks[event].push({
      _source: HOOK_SOURCE,
      hooks: [{
        type: 'command',
        command: HOOK_COMMAND,
        async: true
      }]
    });
    ok(`Added hook for ${GREEN}${event}${RESET}`);
    added++;
  }
}

// Remove hooks for events NOT in the selected density
const excludedEvents = ALL_EVENTS.filter(e => !EVENTS.includes(e));
for (const event of excludedEvents) {
  if (!settings.hooks[event]) continue;
  const before = settings.hooks[event].length;
  settings.hooks[event] = settings.hooks[event].filter(group =>
    !group.hooks?.some(h => h.command?.includes(HOOK_PATTERN))
  );
  if (settings.hooks[event].length === 0) {
    delete settings.hooks[event];
  }
  if (before !== (settings.hooks[event]?.length ?? 0)) {
    removedCount++;
    ok(`Removed hook for ${YELLOW}${event}${RESET} ${DIM}(not in ${density} density)${RESET}`);
  }
}

// Write settings
atomicWriteJSON(SETTINGS_PATH, settings);
info(`Settings saved: ${GREEN}${added} added${RESET}, ${CYAN}${updated} updated${RESET}, ${YELLOW}${removedCount} removed${RESET}, ${DIM}${unchanged} unchanged${RESET}`);

// ═══════════════════════════════════════════════
// STEP 5: Deploy Hook Scripts
// ═══════════════════════════════════════════════
step(5, TOTAL_STEPS, 'Deploying hook scripts...');

// Copy primary hook script
const src = join(__dirname, HOOK_SCRIPT);
if (!existsSync(src)) {
  fail(`Hook script not found: ${src}`);
  console.error(`\n${RED}ERROR${RESET}: Expected hook script at ${src}`);
  console.error('Make sure you are running this from the project directory.');
  process.exit(1);
}

const srcSize = statSync(src).size;
copyFileSync(src, HOOK_DEST);
if (!isWindows) {
  chmodSync(HOOK_DEST, 0o755);
}
ok(`Deployed ${HOOK_SCRIPT} → ${HOOK_DEST} (${formatBytes(srcSize)}, ${isWindows ? 'standard' : 'chmod 755'})`);

// Copy alternate platform hook (for reference / dual-boot)
const altScript = isWindows ? 'dashboard-hook.sh' : 'dashboard-hook.ps1';
const altSrc = join(__dirname, altScript);
if (existsSync(altSrc)) {
  const altDest = join(HOOKS_DIR, altScript);
  copyFileSync(altSrc, altDest);
  if (!isWindows && altScript.endsWith('.sh')) chmodSync(altDest, 0o755);
  info(`Also copied ${altScript} → ${altDest} ${DIM}(reference copy)${RESET}`);
} else {
  info(`Alternate hook ${altScript} not found ${DIM}(skipped)${RESET}`);
}

// Deploy Gemini hook script
if (enabledClis.includes('gemini')) {
  const geminiSrc = join(__dirname, 'dashboard-hook-gemini.sh');
  const geminiHooksDir = join(homedir(), '.gemini', 'hooks');
  const geminiDest = join(geminiHooksDir, 'dashboard-hook.sh');
  if (existsSync(geminiSrc)) {
    mkdirSync(geminiHooksDir, { recursive: true });
    copyFileSync(geminiSrc, geminiDest);
    chmodSync(geminiDest, 0o755);
    ok(`Deployed dashboard-hook-gemini.sh → ${geminiDest}`);
  } else {
    fail(`Gemini hook script not found: ${geminiSrc}`);
  }

  // Register in ~/.gemini/settings.json
  const geminiSettingsPath = join(homedir(), '.gemini', 'settings.json');
  try {
    let gs;
    try { gs = JSON.parse(readFileSync(geminiSettingsPath, 'utf8')); } catch { gs = {}; }
    if (!gs.hooks) gs.hooks = {};
    let gChanged = 0;
    for (const event of GEMINI_EVENTS) {
      if (!gs.hooks[event]) gs.hooks[event] = [];
      const has = gs.hooks[event].some(g => g.hooks?.some(h => h.command?.includes('dashboard-hook')));
      if (!has) {
        gs.hooks[event].push({
          _source: HOOK_SOURCE,
          hooks: [{ type: 'command', command: `~/.gemini/hooks/dashboard-hook.sh ${event}` }]
        });
        gChanged++;
      }
    }
    if (gChanged) {
      mkdirSync(join(homedir(), '.gemini'), { recursive: true });
      atomicWriteJSON(geminiSettingsPath, gs);
      ok(`Registered ${gChanged} Gemini hook events in ~/.gemini/settings.json`);
    } else {
      info('Gemini hooks already registered');
    }
  } catch (e) {
    warn(`Gemini hook registration: ${e.message}`);
  }
}

// Deploy Codex hook script
if (enabledClis.includes('codex')) {
  const codexSrc = join(__dirname, 'dashboard-hook-codex.sh');
  const codexHooksDir = join(homedir(), '.codex', 'hooks');
  const codexDest = join(codexHooksDir, 'dashboard-hook.sh');
  if (existsSync(codexSrc)) {
    mkdirSync(codexHooksDir, { recursive: true });
    copyFileSync(codexSrc, codexDest);
    chmodSync(codexDest, 0o755);
    ok(`Deployed dashboard-hook-codex.sh → ${codexDest}`);
  } else {
    fail(`Codex hook script not found: ${codexSrc}`);
  }

  // Register in ~/.codex/config.toml
  const codexConfigPath = join(homedir(), '.codex', 'config.toml');
  try {
    let toml = '';
    try { toml = readFileSync(codexConfigPath, 'utf8'); } catch {}
    if (!toml.includes('dashboard-hook')) {
      mkdirSync(join(homedir(), '.codex'), { recursive: true });
      const commentLine = `# [${HOOK_SOURCE}] Dashboard hook — safe to remove with "npm run reset"`;
      const notifyLine = 'notify = ["~/.codex/hooks/dashboard-hook.sh"]';
      if (toml && !toml.endsWith('\n')) toml += '\n';
      toml += commentLine + '\n' + notifyLine + '\n';
      writeFileSync(codexConfigPath, toml);
      ok('Registered Codex notify hook in ~/.codex/config.toml');
    } else {
      info('Codex hook already registered');
    }
  } catch (e) {
    warn(`Codex hook registration: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════
// STEP 6: Verify Installation
// ═══════════════════════════════════════════════
step(6, TOTAL_STEPS, 'Verifying installation...');

let verifyOk = true;

// Check hook script is executable
if (!isWindows) {
  try {
    execSync(`test -x "${HOOK_DEST}"`, { stdio: 'ignore' });
    ok('Hook script is executable');
  } catch {
    fail('Hook script is NOT executable');
    verifyOk = false;
  }
}

// Verify settings file is valid JSON
try {
  const check = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  const registeredEvents = Object.keys(check.hooks || {}).filter(event =>
    check.hooks[event]?.some(g => g.hooks?.some(h => h.command?.includes(HOOK_PATTERN)))
  );
  ok(`Settings file: valid JSON`);
  ok(`Dashboard hooks registered: ${registeredEvents.length} event(s)`);
  if (registeredEvents.length !== EVENTS.length) {
    warn(`Expected ${EVENTS.length} events but found ${registeredEvents.length}`);
    verifyOk = false;
  }
} catch (err) {
  fail(`Settings file invalid: ${err.message}`);
  verifyOk = false;
}

// Check hook destination exists
if (existsSync(HOOK_DEST)) {
  ok(`Claude hook file exists at ${HOOK_DEST}`);
} else {
  fail(`Claude hook file missing: ${HOOK_DEST}`);
  verifyOk = false;
}

// Verify Gemini hooks
if (enabledClis.includes('gemini')) {
  const geminiDest = join(homedir(), '.gemini', 'hooks', 'dashboard-hook.sh');
  if (existsSync(geminiDest)) {
    ok(`Gemini hook file exists at ${geminiDest}`);
  } else {
    fail(`Gemini hook file missing: ${geminiDest}`);
    verifyOk = false;
  }
}

// Verify Codex hooks
if (enabledClis.includes('codex')) {
  const codexDest = join(homedir(), '.codex', 'hooks', 'dashboard-hook.sh');
  if (existsSync(codexDest)) {
    ok(`Codex hook file exists at ${codexDest}`);
  } else {
    fail(`Codex hook file missing: ${codexDest}`);
    verifyOk = false;
  }
}

// ═══════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════
if (verifyOk) {
  printSummary(`Setup complete! (density: ${density}, ${EVENTS.length} events)`);
  info('Hook captures: claude_pid, tty_path, term_program, tab_id, vscode_pid, tmux, window_id');
  console.log(`\n  Start the dashboard: ${BOLD}npm start${RESET}\n`);
} else {
  console.log(`\n${YELLOW}────────────────────────────────────────────────${RESET}`);
  console.log(`  ${YELLOW}⚠ Setup completed with warnings${RESET}`);
  console.log(`${YELLOW}────────────────────────────────────────────────${RESET}\n`);
}

// ── Utility functions ──
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function printSummary(msg) {
  console.log(`\n${GREEN}────────────────────────────────────────────────${RESET}`);
  console.log(`  ${GREEN}✓ ${msg}${RESET}`);
  console.log(`${GREEN}────────────────────────────────────────────────${RESET}`);
}

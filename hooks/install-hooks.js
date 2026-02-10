import { readFileSync, writeFileSync, copyFileSync, chmodSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

// Platform-specific hook config
const HOOK_SCRIPT = isWindows ? 'dashboard-hook.ps1' : 'dashboard-hook.sh';
const HOOKS_DIR = join(homedir(), '.claude', 'hooks');
const HOOK_DEST = join(HOOKS_DIR, HOOK_SCRIPT);
// On Windows: call PowerShell; on Unix: call the shell script directly
const HOOK_COMMAND = isWindows
  ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${HOOK_DEST}"`
  : '~/.claude/hooks/dashboard-hook.sh';
// Match both .sh and .ps1 when checking for existing hooks
const HOOK_PATTERN = 'dashboard-hook.';

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Stop', 'Notification', 'SubagentStart', 'SubagentStop', 'SessionEnd'
];

console.log(`\n  Platform: ${process.platform} (${isWindows ? 'PowerShell' : 'Bash'} hook)`);

// Check for jq on macOS/Linux (used by bash hook for JSON enrichment)
if (!isWindows) {
  try {
    execSync('which jq', { stdio: 'ignore' });
    console.log('  jq: found');
  } catch {
    console.warn('  jq: NOT FOUND — install for full session detection:');
    console.warn('     brew install jq   (macOS)');
    console.warn('     apt install jq    (Linux)');
    console.warn('     Hook will still work but without PID/TTY/tab enrichment.');
  }
}

// Ensure ~/.claude/hooks/ directory exists
mkdirSync(HOOKS_DIR, { recursive: true });

// Read current settings
let settings;
try {
  settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
} catch (err) {
  if (err.code === 'ENOENT') {
    settings = {};
    console.log('  Creating new settings.json');
  } else {
    throw err;
  }
}

if (!settings.hooks) settings.hooks = {};

let added = 0;
for (const event of EVENTS) {
  if (!settings.hooks[event]) settings.hooks[event] = [];

  // Find existing dashboard hook entry (either .sh or .ps1)
  const existingIdx = settings.hooks[event].findIndex(group =>
    group.hooks?.some(h => h.command?.includes(HOOK_PATTERN))
  );

  if (existingIdx >= 0) {
    // Update existing entry to use current platform's command
    const group = settings.hooks[event][existingIdx];
    const hookEntry = group.hooks.find(h => h.command?.includes(HOOK_PATTERN));
    if (hookEntry && hookEntry.command !== HOOK_COMMAND) {
      hookEntry.command = HOOK_COMMAND;
      console.log(`  ~ Updated hook command for ${event}`);
      added++;
    } else {
      console.log(`  = ${event} already registered`);
    }
  } else {
    settings.hooks[event].push({
      hooks: [{
        type: 'command',
        command: HOOK_COMMAND,
        async: true
      }]
    });
    added++;
    console.log(`  + Added hook for ${event}`);
  }
}

// Write settings back (preserves all existing keys and hooks)
writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
console.log(`\n  Updated ${SETTINGS_PATH} (${added} changes)`);

// Copy the platform-specific hook script to ~/.claude/hooks/
const src = join(__dirname, HOOK_SCRIPT);
if (!existsSync(src)) {
  console.error(`\n  ERROR: Hook script not found: ${src}`);
  process.exit(1);
}
copyFileSync(src, HOOK_DEST);
if (!isWindows) {
  chmodSync(HOOK_DEST, 0o755);
}
console.log(`  Installed ${HOOK_DEST}`);

// Also copy the other platform's hook (for reference / dual-boot setups)
const altScript = isWindows ? 'dashboard-hook.sh' : 'dashboard-hook.ps1';
const altSrc = join(__dirname, altScript);
if (existsSync(altSrc)) {
  const altDest = join(HOOKS_DIR, altScript);
  copyFileSync(altSrc, altDest);
  if (!isWindows && altScript.endsWith('.sh')) chmodSync(altDest, 0o755);
}

console.log(`\n  Hook captures: claude_pid, tty_path, term_program, tab_id, vscode_pid, tmux, window_id`);
console.log('  Done! Start the dashboard with: npm start\n');

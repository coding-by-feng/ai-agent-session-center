import { readFileSync, writeFileSync, copyFileSync, chmodSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const HOOKS_DIR = join(homedir(), '.claude', 'hooks');
const HOOK_SCRIPT = 'dashboard-hook.sh';
const HOOK_COMMAND = '~/.claude/hooks/dashboard-hook.sh';

const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Stop', 'Notification', 'SubagentStart', 'SubagentStop', 'SessionEnd'
];

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

  // Check if dashboard hook already registered
  const exists = settings.hooks[event].some(group =>
    group.hooks?.some(h => h.command?.includes('dashboard-hook.sh'))
  );

  if (!exists) {
    settings.hooks[event].push({
      hooks: [{
        type: 'command',
        command: HOOK_COMMAND,
        async: true
      }]
    });
    added++;
    console.log(`  + Added hook for ${event}`);
  } else {
    console.log(`  = ${event} already registered`);
  }
}

// Write settings back (preserves all existing keys and hooks)
writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
console.log(`\nUpdated ${SETTINGS_PATH} (${added} hooks added)`);

// Copy hook script to ~/.claude/hooks/
const src = join(__dirname, HOOK_SCRIPT);
const dest = join(HOOKS_DIR, HOOK_SCRIPT);
copyFileSync(src, dest);
chmodSync(dest, 0o755);
console.log(`Installed ${dest}`);
console.log('\nDone! Start the dashboard with: npm start');

// CJS version of install-hooks-api.js for Electron main process use.
// The .js version (ESM) is used by the CLI; this .cjs version is used by Electron.
'use strict';

const { readFileSync, mkdirSync, existsSync, statSync, writeFileSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');
const { execSync } = require('child_process');
const {
  atomicWriteJSON, deployHookScript, configureClaudeHooks,
  removeAllClaudeHooks, configureCodexHooksToml,
  removeAllCodexHooksToml,
} = require('./install-hooks-core.cjs');

const ALL_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop',
  'TeammateIdle', 'TaskCompleted', 'PreCompact', 'SessionEnd',
];

const DENSITY_EVENTS = {
  high: ALL_EVENTS,
  medium: [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PermissionRequest', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop',
    'TaskCompleted', 'SessionEnd',
  ],
  low: ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd'],
};

// Codex CLI (>=0.130) natively supports only these 5 lifecycle hooks via
// [[hooks.X]] blocks. Stop / agent-turn-complete is delivered via the
// legacy `notify = "..."` config entry, not as a hooks block — listing it
// here previously made the installer write a block Codex silently ignores.
const CODEX_DENSITY_EVENTS = {
  high: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest'],
  medium: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest'],
  low: ['SessionStart', 'UserPromptSubmit', 'PermissionRequest'],
};

const HOOK_SOURCE = 'ai-agent-session-center';
const HOOK_PATTERN = 'dashboard-hook';

function formatBytes(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

async function installHooks({ density = 'medium', enabledClis = ['claude'], projectRoot, uninstall = false, onLog } = {}) {
  const log = onLog ?? console.log;
  const isWindows = process.platform === 'win32';

  if (!DENSITY_EVENTS[density]) throw new Error(`Invalid density: "${density}"`);

  const hooksDir = projectRoot ? join(projectRoot, 'hooks') : __dirname;
  const EVENTS = DENSITY_EVENTS[density];
  const CODEX_EVENTS = CODEX_DENSITY_EVENTS[density] || CODEX_DENSITY_EVENTS.medium;
  const HOOK_SCRIPT = isWindows ? 'dashboard-hook.ps1' : 'dashboard-hook.sh';
  const HOOKS_DEST_DIR = join(homedir(), '.claude', 'hooks');
  const HOOK_DEST = join(HOOKS_DEST_DIR, HOOK_SCRIPT);
  const HOOK_COMMAND = isWindows
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${HOOK_DEST}"`
    : '~/.claude/hooks/dashboard-hook.sh';
  const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
  const TOTAL_STEPS = uninstall ? 4 : 6;

  log(`[1/${TOTAL_STEPS}] Detecting platform...`);
  log(`Platform: ${process.platform} (${isWindows ? 'PowerShell' : 'Bash'} hook)`);
  log(`Home directory: ${homedir()}`);
  if (!uninstall) log(`Enabled CLIs: ${enabledClis.join(', ')} | Density: ${density} (${EVENTS.length} events)`);

  log(`[2/${TOTAL_STEPS}] Checking dependencies...`);
  if (!isWindows && !uninstall) {
    try { const v = execSync('jq --version', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'], timeout: 3000 }).trim(); log(`jq: ${v}`); }
    catch { log('jq: NOT FOUND -- hook will work but without enrichment'); }
    try { execSync('which curl', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'], timeout: 3000 }); log('curl: found'); }
    catch { log('curl: NOT FOUND -- HTTP fallback unavailable'); }
  }

  log(`[3/${TOTAL_STEPS}] Preparing directories...`);
  if (!existsSync(HOOKS_DEST_DIR)) mkdirSync(HOOKS_DEST_DIR, { recursive: true });
  const claudeDir = join(homedir(), '.claude');
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

  let settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    log(`Settings loaded: ${SETTINGS_PATH}`);
  } catch (err) {
    if (err.code === 'ENOENT') { settings = {}; log(`Creating new settings: ${SETTINGS_PATH}`); }
    else throw new Error(`Failed to read settings: ${err.message}`);
  }
  if (!settings.hooks) settings.hooks = {};

  if (uninstall) {
    log(`[4/${TOTAL_STEPS}] Removing hooks...`);
    const removed = removeAllClaudeHooks(settings, ALL_EVENTS, HOOK_PATTERN);
    let codexRemoved = 0;
    const codexConfigPath = join(homedir(), '.codex', 'config.toml');
    try {
      const toml = readFileSync(codexConfigPath, 'utf8');
      const cleaned = removeAllCodexHooksToml(toml, HOOK_PATTERN, HOOK_SOURCE);
      codexRemoved = cleaned.removed;
      if (codexRemoved > 0) writeFileSync(codexConfigPath, cleaned.toml);
    } catch { /* Codex config may not exist */ }
    atomicWriteJSON(SETTINGS_PATH, settings);
    log(`Uninstall complete -- ${removed} Claude hook(s), ${codexRemoved} Codex hook block(s) removed`);
    return { success: true, summary: { removed, codexRemoved } };
  }

  log(`[4/${TOTAL_STEPS}] Configuring hook events (density: ${density})...`);
  const result = configureClaudeHooks(settings, EVENTS, ALL_EVENTS, HOOK_COMMAND, HOOK_PATTERN, HOOK_SOURCE);
  atomicWriteJSON(SETTINGS_PATH, settings);
  log(`Settings saved: +${result.added} ~${result.updated} -${result.removed} =${result.unchanged}`);

  log(`[5/${TOTAL_STEPS}] Deploying hook scripts...`);
  const src = join(hooksDir, HOOK_SCRIPT);
  if (!existsSync(src)) throw new Error(`Hook script not found: ${src}`);
  deployHookScript(src, HOOK_DEST, isWindows);
  log(`Deployed ${HOOK_SCRIPT} -> ${HOOK_DEST} (${formatBytes(statSync(src).size)})`);

  const altScript = isWindows ? 'dashboard-hook.sh' : 'dashboard-hook.ps1';
  const altSrc = join(hooksDir, altScript);
  if (existsSync(altSrc)) { deployHookScript(altSrc, join(HOOKS_DEST_DIR, altScript), isWindows); log(`Also copied ${altScript}`); }


  if (enabledClis.includes('codex')) {
    const codexSrc = join(hooksDir, 'dashboard-hook-codex.sh');
    const codexDest = join(homedir(), '.codex', 'hooks', 'dashboard-hook.sh');
    if (existsSync(codexSrc)) {
      mkdirSync(join(homedir(), '.codex', 'hooks'), { recursive: true });
      deployHookScript(codexSrc, codexDest, false);
      log(`Deployed Codex hook -> ${codexDest}`);
    }
    const codexConfigPath = join(homedir(), '.codex', 'config.toml');
    try {
      let toml = ''; try { toml = readFileSync(codexConfigPath, 'utf8'); } catch {}
      const configured = configureCodexHooksToml(
        toml,
        CODEX_EVENTS,
        '~/.codex/hooks/dashboard-hook.sh',
        HOOK_PATTERN,
        HOOK_SOURCE,
      );
      mkdirSync(join(homedir(), '.codex'), { recursive: true });
      if (configured.toml !== toml) {
        writeFileSync(codexConfigPath, configured.toml);
        log(`Registered ${CODEX_EVENTS.length} Codex lifecycle hook events`);
      } else log('Codex hooks already registered');
    } catch (e) { log(`Codex: ${e.message}`); }
  }

  log(`[6/${TOTAL_STEPS}] Verifying...`);
  let verifyOk = true;
  if (!isWindows) {
    try { execSync(`test -x "${HOOK_DEST}"`, { stdio: 'ignore', timeout: 3000 }); log('Hook script is executable'); }
    catch { log('Hook script is NOT executable'); verifyOk = false; }
  }
  try {
    const check = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    const registered = Object.keys(check.hooks || {}).filter(e =>
      check.hooks[e]?.some(g => g.hooks?.some(h => h.command?.includes(HOOK_PATTERN)))
    );
    log(`Registered: ${registered.length}/${EVENTS.length} events`);
    if (registered.length !== EVENTS.length) verifyOk = false;
  } catch (err) { log(`Settings invalid: ${err.message}`); verifyOk = false; }

  log(verifyOk ? `Setup complete! (density: ${density}, ${EVENTS.length} events)` : 'Setup completed with warnings');
  return { success: verifyOk, summary: { ...result, density, eventCount: EVENTS.length } };
}

module.exports = { installHooks };

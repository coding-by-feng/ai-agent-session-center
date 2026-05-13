// install-hooks-api.js — Programmatic API for hook installation.
// Accepts onLog callback instead of writing to console.
// Throws Error instead of calling process.exit().
// Returns { success: boolean, summary: object }.

import { readFileSync, mkdirSync, existsSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import {
  atomicWriteJSON,
  deployHookScript,
  configureClaudeHooks,
  removeAllClaudeHooks,
  configureGeminiHooks,
  configureCodexHooksToml,
  removeAllCodexHooksToml,
} from './install-hooks-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// All possible hook events (Claude Code supports 14 lifecycle events)
const ALL_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop',
  'TeammateIdle', 'TaskCompleted', 'PreCompact', 'SessionEnd',
];

// Density levels: which events to register
const DENSITY_EVENTS = {
  high: ALL_EVENTS,
  medium: [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PermissionRequest', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop',
    'TaskCompleted', 'SessionEnd',
  ],
  low: [
    'SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd',
  ],
};

// Gemini events by density.
// BeforeTool/AfterTool must be in medium so sessions reach the "working"
// state (orange brightening); without them Gemini sits at idle/prompting only.
const GEMINI_DENSITY_EVENTS = {
  high: ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'SessionEnd', 'Notification'],
  medium: ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'SessionEnd', 'Notification'],
  low: ['SessionStart', 'AfterAgent', 'SessionEnd'],
};

// Codex CLI (>=0.130) natively supports only these 5 lifecycle hooks via
// [[hooks.X]] blocks. The Stop / agent-turn-complete signal is delivered
// through the legacy `notify = "..."` config entry, not as a hooks block.
// Listing Stop / PreCompact here previously caused the installer to write
// blocks Codex silently ignores.
const CODEX_DENSITY_EVENTS = {
  high: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest'],
  medium: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest'],
  low: ['SessionStart', 'UserPromptSubmit', 'PermissionRequest'],
};

const HOOK_SOURCE = 'ai-agent-session-center';
const HOOK_PATTERN = 'dashboard-hook';

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Install hooks programmatically.
 *
 * @param {object} options
 * @param {'high'|'medium'|'low'} [options.density='medium'] - Hook density level
 * @param {string[]} [options.enabledClis=['claude']] - CLIs to install hooks for
 * @param {string} [options.projectRoot] - Path to the project root (where hooks/ dir lives)
 * @param {boolean} [options.uninstall=false] - Uninstall mode
 * @param {(line: string) => void} [options.onLog] - Log callback (defaults to console.log)
 * @returns {Promise<{ success: boolean, summary: object }>}
 */
export async function installHooks({
  density = 'medium',
  enabledClis = ['claude'],
  projectRoot,
  uninstall = false,
  onLog,
} = {}) {
  const log = onLog ?? console.log;
  const isWindows = process.platform === 'win32';

  if (!DENSITY_EVENTS[density]) {
    throw new Error(`Invalid density: "${density}" (use: high, medium, low)`);
  }

  const hooksDir = projectRoot ? join(projectRoot, 'hooks') : __dirname;
  const EVENTS = DENSITY_EVENTS[density];
  const GEMINI_EVENTS = GEMINI_DENSITY_EVENTS[density] || GEMINI_DENSITY_EVENTS.medium;
  const CODEX_EVENTS = CODEX_DENSITY_EVENTS[density] || CODEX_DENSITY_EVENTS.medium;

  const HOOK_SCRIPT = isWindows ? 'dashboard-hook.ps1' : 'dashboard-hook.sh';
  const HOOKS_DEST_DIR = join(homedir(), '.claude', 'hooks');
  const HOOK_DEST = join(HOOKS_DEST_DIR, HOOK_SCRIPT);
  const HOOK_COMMAND = isWindows
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${HOOK_DEST}"`
    : '~/.claude/hooks/dashboard-hook.sh';
  const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
  const TOTAL_STEPS = uninstall ? 4 : 6;

  // ── STEP 1: Platform Detection ──
  log(`[1/${TOTAL_STEPS}] Detecting platform...`);
  log(`Platform: ${process.platform} (${isWindows ? 'PowerShell' : 'Bash'} hook)`);
  log(`Architecture: ${process.arch}`);
  log(`Node.js: ${process.version}`);
  log(`Home directory: ${homedir()}`);

  if (uninstall) {
    log(`Mode: UNINSTALL (removing all dashboard hooks)`);
  } else {
    log(`Enabled CLIs: ${enabledClis.join(', ')}`);
    log(`Density: ${density} -> ${EVENTS.length} of ${ALL_EVENTS.length} Claude events`);
  }

  // ── STEP 2: Dependency Check ──
  log(`[2/${TOTAL_STEPS}] Checking dependencies...`);

  if (!isWindows && !uninstall) {
    try {
      execSync('which jq', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const jqVersion = execSync('jq --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      log(`jq: ${jqVersion}`);
    } catch {
      log(`jq: NOT FOUND -- hook will work but without PID/TTY/tab enrichment`);
    }

    try {
      execSync('which curl', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      log(`curl: found`);
    } catch {
      log(`curl: NOT FOUND -- hook cannot send data to dashboard!`);
    }
  } else {
    log('Dependency check skipped');
  }

  // ── STEP 3: Prepare Directories & Read Settings ──
  log(`[3/${TOTAL_STEPS}] Preparing directories & reading settings...`);

  if (!existsSync(HOOKS_DEST_DIR)) {
    mkdirSync(HOOKS_DEST_DIR, { recursive: true });
  }

  const claudeDir = join(homedir(), '.claude');
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  let settings;
  try {
    const raw = readFileSync(SETTINGS_PATH, 'utf8');
    settings = JSON.parse(raw);
    log(`Settings file loaded: ${SETTINGS_PATH}`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      settings = {};
      log(`Creating new settings file: ${SETTINGS_PATH}`);
    } else {
      throw new Error(`Failed to read settings: ${err.message}`);
    }
  }

  if (!settings.hooks) settings.hooks = {};

  // ── UNINSTALL MODE ──
  if (uninstall) {
    log(`[4/${TOTAL_STEPS}] Removing dashboard hooks...`);
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

  // ── STEP 4: Configure Hook Events ──
  log(`[4/${TOTAL_STEPS}] Configuring hook events (density: ${density})...`);
  const result = configureClaudeHooks(settings, EVENTS, ALL_EVENTS, HOOK_COMMAND, HOOK_PATTERN, HOOK_SOURCE);
  atomicWriteJSON(SETTINGS_PATH, settings);
  log(`Settings saved: ${result.added} added, ${result.updated} updated, ${result.removed} removed, ${result.unchanged} unchanged`);

  // ── STEP 5: Deploy Hook Scripts ──
  log(`[5/${TOTAL_STEPS}] Deploying hook scripts...`);

  const src = join(hooksDir, HOOK_SCRIPT);
  if (!existsSync(src)) {
    throw new Error(`Hook script not found: ${src}. Make sure projectRoot is correct.`);
  }

  deployHookScript(src, HOOK_DEST, isWindows);
  const srcSize = statSync(src).size;
  log(`Deployed ${HOOK_SCRIPT} -> ${HOOK_DEST} (${formatBytes(srcSize)})`);

  // Deploy alternate platform hook (for reference)
  const altScript = isWindows ? 'dashboard-hook.sh' : 'dashboard-hook.ps1';
  const altSrc = join(hooksDir, altScript);
  if (existsSync(altSrc)) {
    const altDest = join(HOOKS_DEST_DIR, altScript);
    deployHookScript(altSrc, altDest, isWindows);
    log(`Also copied ${altScript} -> ${altDest}`);
  }

  // Deploy Gemini hook
  if (enabledClis.includes('gemini')) {
    const geminiSrc = join(hooksDir, 'dashboard-hook-gemini.sh');
    const geminiHooksDir = join(homedir(), '.gemini', 'hooks');
    const geminiDest = join(geminiHooksDir, 'dashboard-hook.sh');
    if (existsSync(geminiSrc)) {
      mkdirSync(geminiHooksDir, { recursive: true });
      deployHookScript(geminiSrc, geminiDest, false);
      log(`Deployed dashboard-hook-gemini.sh -> ${geminiDest}`);
    } else {
      log(`Gemini hook script not found: ${geminiSrc}`);
    }

    // Register in ~/.gemini/settings.json
    const geminiSettingsPath = join(homedir(), '.gemini', 'settings.json');
    try {
      let gs;
      try { gs = JSON.parse(readFileSync(geminiSettingsPath, 'utf8')); } catch { gs = {}; }
      const gChanged = configureGeminiHooks(gs, GEMINI_EVENTS, HOOK_SOURCE);
      if (gChanged) {
        mkdirSync(join(homedir(), '.gemini'), { recursive: true });
        atomicWriteJSON(geminiSettingsPath, gs);
        log(`Registered ${gChanged} Gemini hook events`);
      } else {
        log('Gemini hooks already registered');
      }
    } catch (e) {
      log(`Gemini hook registration: ${e.message}`);
    }
  }

  // Deploy Codex hook
  if (enabledClis.includes('codex')) {
    const codexSrc = join(hooksDir, 'dashboard-hook-codex.sh');
    const codexHooksDir = join(homedir(), '.codex', 'hooks');
    const codexDest = join(codexHooksDir, 'dashboard-hook.sh');
    if (existsSync(codexSrc)) {
      mkdirSync(codexHooksDir, { recursive: true });
      deployHookScript(codexSrc, codexDest, false);
      log(`Deployed dashboard-hook-codex.sh -> ${codexDest}`);
    } else {
      log(`Codex hook script not found: ${codexSrc}`);
    }

    // Register in ~/.codex/config.toml using lifecycle command hooks.
    const codexConfigPath = join(homedir(), '.codex', 'config.toml');
    try {
      let toml = '';
      try { toml = readFileSync(codexConfigPath, 'utf8'); } catch {}
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
      } else {
        log('Codex hooks already registered');
      }
    } catch (e) {
      log(`Codex hook registration: ${e.message}`);
    }
  }

  // ── STEP 6: Verify Installation ──
  log(`[6/${TOTAL_STEPS}] Verifying installation...`);

  let verifyOk = true;

  if (!isWindows) {
    try {
      execSync(`test -x "${HOOK_DEST}"`, { stdio: 'ignore' });
      log('Hook script is executable');
    } catch {
      log('Hook script is NOT executable');
      verifyOk = false;
    }
  }

  try {
    const check = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    const registeredEvents = Object.keys(check.hooks || {}).filter(event =>
      check.hooks[event]?.some(g => g.hooks?.some(h => h.command?.includes(HOOK_PATTERN)))
    );
    log(`Dashboard hooks registered: ${registeredEvents.length} event(s)`);
    if (registeredEvents.length !== EVENTS.length) {
      log(`Expected ${EVENTS.length} events but found ${registeredEvents.length}`);
      verifyOk = false;
    }
  } catch (err) {
    log(`Settings file invalid: ${err.message}`);
    verifyOk = false;
  }

  if (!existsSync(HOOK_DEST)) {
    log(`Claude hook file missing: ${HOOK_DEST}`);
    verifyOk = false;
  }

  if (!verifyOk) {
    log('Setup completed with warnings');
  } else {
    log(`Setup complete! (density: ${density}, ${EVENTS.length} events)`);
  }

  return {
    success: verifyOk,
    summary: {
      added: result.added,
      updated: result.updated,
      removed: result.removed,
      unchanged: result.unchanged,
      density,
      eventCount: EVENTS.length,
    },
  };
}

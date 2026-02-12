/**
 * @module hookInstaller
 * Auto-installs hook scripts for Claude Code, Gemini CLI, and Codex on server startup.
 * Copies dashboard-hook.sh to ~/.claude/hooks/, registers events in ~/.claude/settings.json
 * using atomic writes (temp file + rename), and supports density-aware event registration.
 */
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { copyFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';
import log from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Atomic JSON file write: writes to temp file, then renames (atomic on same filesystem)
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

// Helper: copy hook script if changed
function syncHookFile(src, dest, hooksDir, isWindows, label) {
  if (!existsSync(src)) return;
  try {
    let needsCopy = !existsSync(dest);
    if (!needsCopy) {
      const srcContent = readFileSync(src);
      const destContent = readFileSync(dest);
      needsCopy = !srcContent.equals(destContent);
    }
    if (needsCopy) {
      mkdirSync(hooksDir, { recursive: true });
      copyFileSync(src, dest);
      if (!isWindows) chmodSync(dest, 0o755);
      log.info('server', `Synced ${label} hook → ${dest}`);
    }
  } catch (e) {
    log.debug('server', `${label} hook file sync skipped: ${e.message}`);
  }
}

/**
 * Copies hook scripts and registers hooks for all enabled CLIs.
 * Runs on every startup so users never need to manually install hooks.
 *
 * @param {object} config - Server config object (from serverConfig.js)
 */
export function ensureHooksInstalled(config) {
  const isWindows = process.platform === 'win32';
  const hookPattern = 'dashboard-hook';
  const hookSource = 'ai-agent-session-center';

  // Read saved config
  let density = config.hookDensity || 'medium';
  let enabledClis = config.enabledClis || ['claude'];

  // Also check data/server-config.json for overrides
  try {
    const serverConfig = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'server-config.json'), 'utf8'));
    if (serverConfig.hookDensity) density = serverConfig.hookDensity;
    if (serverConfig.enabledClis) enabledClis = serverConfig.enabledClis;
  } catch {}

  // ── Claude Code hooks ──
  if (enabledClis.includes('claude')) {
    const hookName = isWindows ? 'dashboard-hook.ps1' : 'dashboard-hook.sh';
    const hookCommand = isWindows
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File "~/.claude/hooks/${hookName}"`
      : '~/.claude/hooks/dashboard-hook.sh';
    const src = join(__dirname, '..', 'hooks', hookName);
    const hooksDir = join(homedir(), '.claude', 'hooks');
    const dest = join(hooksDir, hookName);
    const settingsPath = join(homedir(), '.claude', 'settings.json');

    // Copy hook script
    syncHookFile(src, dest, hooksDir, isWindows, 'claude');

    // Register in settings.json
    const densityEvents = {
      high: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop', 'TeammateIdle', 'TaskCompleted', 'PreCompact', 'SessionEnd'],
      medium: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop', 'TaskCompleted', 'SessionEnd'],
      low: ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd'],
    };
    const events = densityEvents[density] || densityEvents.medium;

    try {
      let settings;
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { settings = {}; }
      if (!settings.hooks) settings.hooks = {};

      let changed = false;
      for (const event of events) {
        if (!settings.hooks[event]) settings.hooks[event] = [];
        const hasHook = settings.hooks[event].some(g =>
          g.hooks?.some(h => h.command?.includes(hookPattern))
        );
        if (!hasHook) {
          settings.hooks[event].push({
            _source: hookSource,
            hooks: [{ type: 'command', command: hookCommand, async: true }]
          });
          changed = true;
        }
      }
      if (changed) {
        mkdirSync(join(homedir(), '.claude'), { recursive: true });
        atomicWriteJSON(settingsPath, settings);
        log.info('server', `Registered ${events.length} Claude hook events (density: ${density})`);
      }
    } catch (e) {
      log.debug('server', `Claude hook registration skipped: ${e.message}`);
    }
  }

  // ── Gemini CLI hooks ──
  if (enabledClis.includes('gemini')) {
    const src = join(__dirname, '..', 'hooks', 'dashboard-hook-gemini.sh');
    const hooksDir = join(homedir(), '.gemini', 'hooks');
    const dest = join(hooksDir, 'dashboard-hook.sh');
    const settingsPath = join(homedir(), '.gemini', 'settings.json');

    syncHookFile(src, dest, hooksDir, false, 'gemini');

    // Gemini events mapped to density
    const geminiDensityEvents = {
      high: ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'SessionEnd', 'Notification'],
      medium: ['SessionStart', 'BeforeAgent', 'AfterAgent', 'SessionEnd', 'Notification'],
      low: ['SessionStart', 'AfterAgent', 'SessionEnd'],
    };
    const geminiEvents = geminiDensityEvents[density] || geminiDensityEvents.medium;

    try {
      let settings;
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { settings = {}; }
      if (!settings.hooks) settings.hooks = {};

      let changed = false;
      for (const event of geminiEvents) {
        if (!settings.hooks[event]) settings.hooks[event] = [];
        const hasHook = settings.hooks[event].some(g =>
          g.hooks?.some(h => h.command?.includes(hookPattern))
        );
        if (!hasHook) {
          settings.hooks[event].push({
            _source: hookSource,
            hooks: [{ type: 'command', command: `~/.gemini/hooks/dashboard-hook.sh ${event}` }]
          });
          changed = true;
        }
      }
      if (changed) {
        mkdirSync(join(homedir(), '.gemini'), { recursive: true });
        atomicWriteJSON(settingsPath, settings);
        log.info('server', `Registered ${geminiEvents.length} Gemini hook events (density: ${density})`);
      }
    } catch (e) {
      log.debug('server', `Gemini hook registration skipped: ${e.message}`);
    }
  }

  // ── Codex CLI hooks ──
  if (enabledClis.includes('codex')) {
    const src = join(__dirname, '..', 'hooks', 'dashboard-hook-codex.sh');
    const hooksDir = join(homedir(), '.codex', 'hooks');
    const dest = join(hooksDir, 'dashboard-hook.sh');
    const configPath = join(homedir(), '.codex', 'config.toml');

    syncHookFile(src, dest, hooksDir, false, 'codex');

    // Codex uses TOML config with a notify command
    try {
      let toml = '';
      try { toml = readFileSync(configPath, 'utf8'); } catch {}

      if (!toml.includes(hookPattern)) {
        mkdirSync(join(homedir(), '.codex'), { recursive: true });
        const commentLine = `# [${hookSource}] Dashboard hook — safe to remove with "npm run reset"`;
        const notifyLine = `notify = ["~/.codex/hooks/dashboard-hook.sh"]`;
        if (toml && !toml.endsWith('\n')) toml += '\n';
        toml += commentLine + '\n' + notifyLine + '\n';
        writeFileSync(configPath, toml);
        log.info('server', 'Registered Codex notify hook in ~/.codex/config.toml');
      }
    } catch (e) {
      log.debug('server', `Codex hook registration skipped: ${e.message}`);
    }
  }
}

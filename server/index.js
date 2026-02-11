// index.js — Express + WS server entry point
// Quick start: npm start → auto-installs hooks, starts server, opens browser
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { copyFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import hookRouter from './hookRouter.js';
import { handleConnection, broadcast } from './wsManager.js';
import { getAllSessions } from './sessionStore.js';
import apiRouter from './apiRouter.js';
import { startMqReader, stopMqReader } from './mqReader.js';
import log from './logger.js';
import { config } from './serverConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, '..', 'public')));
app.use('/api', apiRouter);
app.use('/api/hooks', hookRouter);
app.get('/api/sessions', (req, res) => {
  log.debug('api', 'GET /api/sessions');
  res.json(getAllSessions());
});

// Request logging middleware (debug mode only)
if (log.isDebug) {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      log.debug('http', `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  });
}

wss.on('connection', handleConnection);
wss.on('error', () => {}); // Suppress WSS re-emit; handled on HTTP server

// Port priority: --port flag > PORT env > config file > 3333
function resolvePort() {
  const portArgIdx = args.indexOf('--port');
  if (portArgIdx >= 0 && args[portArgIdx + 1]) {
    const p = parseInt(args[portArgIdx + 1], 10);
    if (p > 0) return p;
  }
  if (process.env.PORT) {
    const p = parseInt(process.env.PORT, 10);
    if (p > 0) return p;
  }
  return config.port || 3333;
}

const PORT = resolvePort();

function killPortProcess(port) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const pids = [...new Set(
        output.trim().split('\n')
          .map(line => line.trim().split(/\s+/).pop())
          .filter(Boolean)
      )];
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'pipe' }); } catch {}
      }
    } else {
      // macOS & Linux
      const output = execSync(`lsof -ti:${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const pids = output.trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try { process.kill(Number(pid), 'SIGTERM'); } catch {}
      }
    }
  } catch {
    // No process found on port — nothing to kill
  }
}

// ── Hook auto-install ──
// Copies hook scripts and registers hooks for all enabled CLIs
// Runs on every startup so users never need to manually install hooks
function ensureHooksInstalled() {
  const isWindows = process.platform === 'win32';
  const hookPattern = 'dashboard-hook';
  const hookSource = 'ai-agent-session-center';

  // Read saved config
  let density = 'medium';
  let enabledClis = ['claude'];
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
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
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
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
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

// ── Auto-open browser ──
function openBrowser(url) {
  if (noOpen) return;
  try {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    execSync(`${cmd} "${url}"`, { stdio: 'ignore', timeout: 5000 });
  } catch {
    // Browser open failed — not critical
  }
}

function onReady() {
  log.info('server', `AI Agent Session Center`);
  log.info('server', `Dashboard: http://localhost:${PORT}`);
  if (log.isDebug) {
    log.info('server', 'Debug mode ENABLED — verbose logging active');
  }

  // Auto-install hooks (copy script + register in settings.json)
  ensureHooksInstalled();

  // Start file-based message queue reader
  startMqReader();

  // Open browser after a brief delay (let server fully initialize)
  setTimeout(() => openBrowser(`http://localhost:${PORT}`), 300);
}

let retried = false;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !retried) {
    retried = true;
    log.info('server', `Port ${PORT} in use — killing existing process…`);
    killPortProcess(PORT);
    setTimeout(() => server.listen(PORT, onReady), 1000);
  } else {
    throw err;
  }
});

server.listen(PORT, onReady);

// Graceful shutdown
function gracefulShutdown(signal) {
  log.info('server', `Received ${signal}, shutting down...`);
  stopMqReader();
  server.close(() => {
    log.info('server', 'Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

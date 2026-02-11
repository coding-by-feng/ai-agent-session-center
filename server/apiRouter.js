// apiRouter.js — Express router for all API endpoints (no SQLite/database dependencies)
import { Router } from 'express';
import { findClaudeProcess, killSession, archiveSession, setSessionTitle, setSessionLabel, setSummary, getSession, detectSessionSource, createTerminalSession, deleteSessionFromMemory } from './sessionStore.js';
import { createTerminal, closeTerminal, getTerminals, listSshKeys, listTmuxSessions } from './sshManager.js';
import { getStats as getHookStats, resetStats as resetHookStats } from './hookStats.js';
import { getMqStats } from './mqReader.js';
import { execFile } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __apiDirname = dirname(fileURLToPath(import.meta.url));

const router = Router();

// Hook performance stats
router.get('/hook-stats', (req, res) => {
  res.json(getHookStats());
});

router.post('/hook-stats/reset', (req, res) => {
  resetHookStats();
  res.json({ ok: true });
});

// Full reset — broadcast to all connected browsers to clear their IndexedDB
router.post('/reset', async (req, res) => {
  const { broadcast } = await import('./wsManager.js');
  broadcast({ type: 'clearBrowserDb' });
  res.json({ ok: true, message: 'Browser DB clear signal sent' });
});

// MQ reader stats
router.get('/mq-stats', (req, res) => {
  res.json(getMqStats());
});

// ---- Hook Density Management ----

const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const INSTALL_HOOKS_SCRIPT = join(__apiDirname, '..', 'hooks', 'install-hooks.js');
const HOOK_PATTERN = 'dashboard-hook.';
const ALL_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop',
  'TeammateIdle', 'TaskCompleted', 'PreCompact', 'SessionEnd'
];
const DENSITY_EVENTS = {
  high: ALL_HOOK_EVENTS,
  medium: [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PermissionRequest', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop',
    'TaskCompleted', 'SessionEnd'
  ],
  low: ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd']
};

// Get current hooks status from ~/.claude/settings.json
router.get('/hooks/status', (req, res) => {
  try {
    let claudeSettings = {};
    try {
      claudeSettings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    } catch { /* file doesn't exist yet */ }

    const hooks = claudeSettings.hooks || {};
    const installedEvents = ALL_HOOK_EVENTS.filter(event =>
      hooks[event]?.some(group => group.hooks?.some(h => h.command?.includes(HOOK_PATTERN)))
    );

    // Infer density from installed events
    let density = 'off';
    if (installedEvents.length > 0) {
      if (installedEvents.length === DENSITY_EVENTS.high.length &&
          DENSITY_EVENTS.high.every(e => installedEvents.includes(e))) {
        density = 'high';
      } else if (installedEvents.length === DENSITY_EVENTS.medium.length &&
                 DENSITY_EVENTS.medium.every(e => installedEvents.includes(e))) {
        density = 'medium';
      } else if (installedEvents.length === DENSITY_EVENTS.low.length &&
                 DENSITY_EVENTS.low.every(e => installedEvents.includes(e))) {
        density = 'low';
      } else {
        density = 'custom';
      }
    }

    res.json({ installed: installedEvents.length > 0, density, events: installedEvents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Install hooks with specified density
router.post('/hooks/install', (req, res) => {
  const { density } = req.body;
  if (!density || !DENSITY_EVENTS[density]) {
    return res.status(400).json({ error: 'density must be one of: high, medium, low' });
  }

  // Run install-hooks.js with --density flag
  execFile('node', [INSTALL_HOOKS_SCRIPT, '--density', density], { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[hooks/install] Error:', err.message);
      return res.status(500).json({ error: err.message, stdout, stderr });
    }
    console.log('[hooks/install]', stdout);
    res.json({ ok: true, density, events: DENSITY_EVENTS[density], output: stdout });
  });
});

// Uninstall all dashboard hooks
router.post('/hooks/uninstall', (req, res) => {
  // Run install-hooks.js with --uninstall flag
  execFile('node', [INSTALL_HOOKS_SCRIPT, '--uninstall'], { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[hooks/uninstall] Error:', err.message);
      return res.status(500).json({ error: err.message, stdout, stderr });
    }
    console.log('[hooks/uninstall]', stdout);
    res.json({ ok: true, output: stdout });
  });
});

// ---- Session Control Endpoints ----

// Kill session process — sends SIGTERM, then SIGKILL after 3s if still alive
router.post('/sessions/:id/kill', (req, res) => {
  if (!req.body.confirm) {
    return res.status(400).json({ error: 'Must send {confirm: true} to kill a session' });
  }
  const sessionId = req.params.id;
  const mem = getSession(sessionId);
  const pid = findClaudeProcess(sessionId, mem?.projectPath);
  const source = detectSessionSource(sessionId);
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      // Follow up with SIGKILL after 3s if process is still alive
      setTimeout(() => {
        try {
          process.kill(pid, 0); // Check if still alive
          process.kill(pid, 'SIGKILL');
        } catch(e) { /* already dead — good */ }
      }, 3000);
    } catch (e) {
      return res.status(500).json({ error: `Failed to kill PID ${pid}: ${e.message}` });
    }
  }
  const session = killSession(sessionId);
  archiveSession(sessionId, true);
  // Close associated SSH terminal if present
  if (session && session.terminalId) {
    closeTerminal(session.terminalId);
  } else if (mem && mem.terminalId) {
    closeTerminal(mem.terminalId);
  }
  if (!session && !pid) {
    return res.status(404).json({ error: 'Session not found and no matching process' });
  }
  res.json({ ok: true, pid: pid || null, source });
});

// Permanently delete a session — removes from memory, broadcasts removal to clients
router.delete('/sessions/:id', async (req, res) => {
  const sessionId = req.params.id;
  const session = getSession(sessionId);
  // Close terminal if still active
  if (session && session.terminalId) {
    closeTerminal(session.terminalId);
  }
  const removed = deleteSessionFromMemory(sessionId);
  // Broadcast session_removed so all connected browsers remove the card
  try {
    const { broadcast } = await import('./wsManager.js');
    broadcast({ type: 'session_removed', sessionId });
  } catch (e) {}
  res.json({ ok: true, removed });
});

// Detect session source (vscode / terminal)
router.get('/sessions/:id/source', (req, res) => {
  const source = detectSessionSource(req.params.id);
  res.json({ source });
});



// Update session title (in-memory only, no DB write)
router.put('/sessions/:id/title', (req, res) => {
  const { title } = req.body;
  if (title === undefined) return res.status(400).json({ error: 'title is required' });
  setSessionTitle(req.params.id, title);
  res.json({ ok: true });
});

// Update session label (in-memory only, no DB write)
router.put('/sessions/:id/label', (req, res) => {
  const { label } = req.body;
  if (label === undefined) return res.status(400).json({ error: 'label is required' });
  setSessionLabel(req.params.id, label);
  res.json({ ok: true });
});

// Summarize session using Claude CLI
// The frontend sends { context, promptTemplate } from IndexedDB data.
// If custom_prompt is provided, use it directly as the prompt template.
router.post('/sessions/:id/summarize', async (req, res) => {
  const sessionId = req.params.id;
  const { context, promptTemplate: bodyPromptTemplate, custom_prompt: customPrompt } = req.body;

  if (!context) {
    return res.status(400).json({ error: 'context is required in request body (prepared from IndexedDB data)' });
  }

  // Determine prompt template: custom_prompt > bodyPromptTemplate > default
  const promptTemplate = customPrompt || bodyPromptTemplate || 'Summarize this Claude Code session in detail.';

  const summaryPrompt = `${promptTemplate}\n\n--- SESSION TRANSCRIPT ---\n${context}`;

  try {
    const summary = await new Promise((resolve, reject) => {
      const child = execFile('claude', ['-p', '--model', 'haiku'], {
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) return reject(error);
        resolve(stdout.trim());
      });
      child.stdin.write(summaryPrompt);
      child.stdin.end();
    });

    // Store summary in memory
    setSummary(sessionId, summary);
    archiveSession(sessionId, true);

    res.json({ ok: true, summary });
  } catch (err) {
    console.error('[apiRouter] Summarize error:', err.message);
    res.status(500).json({ error: `Summarize failed: ${err.message}` });
  }
});

// ── SSH Keys ──

router.get('/ssh-keys', (req, res) => {
  res.json({ keys: listSshKeys() });
});

// ── Tmux Sessions ──

router.post('/tmux-sessions', async (req, res) => {
  try {
    const { host, port, username, password, privateKeyPath, authMethod, passphrase } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const config = {
      host: host || 'localhost',
      port: port || 22,
      username,
      authMethod: authMethod || 'key',
      privateKeyPath,
      password,
      passphrase,
    };
    const sessions = await listTmuxSessions(config);
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Terminals ──

router.post('/terminals', async (req, res) => {
  try {
    const { host, port, username, password, privateKeyPath, authMethod, workingDir, command, apiKey, tmuxSession, useTmux, sessionTitle, label } = req.body;

    if (!username) return res.status(400).json({ error: 'username required' });
    const config = {
      host: host || 'localhost',
      port: port || 22,
      username,
      authMethod: authMethod || 'key',
      privateKeyPath,
      workingDir: workingDir || '~',
      command: command || 'claude',
      password,
    };

    // Tmux modes
    if (tmuxSession) config.tmuxSession = tmuxSession; // attach to existing
    if (useTmux) config.useTmux = true; // wrap in new tmux session
    if (sessionTitle) config.sessionTitle = sessionTitle;
    if (label) config.label = label;

    // Resolve API key from request body only (no DB lookup)
    if (apiKey) {
      config.apiKey = apiKey;
    }

    const terminalId = await createTerminal(config, null);
    // Create session card immediately so it appears in the dashboard
    await createTerminalSession(terminalId, config);
    res.json({ ok: true, terminalId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/terminals', (req, res) => {
  res.json({ terminals: getTerminals() });
});

router.delete('/terminals/:id', (req, res) => {
  closeTerminal(req.params.id);
  res.json({ ok: true });
});

export default router;

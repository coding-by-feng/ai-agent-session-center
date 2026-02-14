// @ts-check
// apiRouter.js — Express router for all API endpoints (no SQLite/database dependencies)
import { Router } from 'express';
import { findClaudeProcess, killSession, archiveSession, setSessionTitle, setSessionLabel, setSummary, getSession, detectSessionSource, createTerminalSession, deleteSessionFromMemory, resumeSession, reconnectSessionTerminal } from './sessionStore.js';
import { createTerminal, closeTerminal, getTerminals, listSshKeys, listTmuxSessions, writeToTerminal, attachToTmuxPane } from './sshManager.js';
import { getTeam, readTeamConfig } from './teamManager.js';
import { getStats as getHookStats, resetStats as resetHookStats } from './hookStats.js';
import { getMqStats } from './mqReader.js';
import { execFile } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { ALL_CLAUDE_HOOK_EVENTS, DENSITY_EVENTS, SESSION_STATUS, WS_TYPES } from './constants.js';
import log from './logger.js';

const __apiDirname = dirname(fileURLToPath(import.meta.url));

const router = Router();

// ---- Input Validation Helpers ----

const SHELL_META_RE = /[;|&$`\\!><()\n\r{}[\]]/;

function isValidString(val, maxLen = 1024) {
  return typeof val === 'string' && val.length <= maxLen;
}

function isValidPort(val) {
  const n = Number(val);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function isValidHost(val) {
  if (!isValidString(val, 255)) return false;
  // Reject shell metacharacters in hostnames
  return !SHELL_META_RE.test(val);
}

function isValidUsername(val) {
  if (!isValidString(val, 128)) return false;
  return /^[a-zA-Z0-9_.\-]+$/.test(val);
}

function isValidWorkingDir(val) {
  if (!isValidString(val, 1024)) return false;
  return !SHELL_META_RE.test(val.replace(/^~/, ''));
}

function isValidCommand(val) {
  if (!isValidString(val, 512)) return false;
  return !SHELL_META_RE.test(val);
}

// ---- Rate Limiting (in-memory, no external deps) ----

// Sliding window rate limiter: tracks request counts per key per second
const rateLimitBuckets = new Map(); // key -> { count, windowStart }

function isRateLimited(key, maxPerSecond) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.windowStart > 1000) {
    rateLimitBuckets.set(key, { count: 1, windowStart: now });
    return false;
  }
  bucket.count++;
  return bucket.count > maxPerSecond;
}

// Clean up stale rate limit buckets every 30s
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStart > 5000) {
      rateLimitBuckets.delete(key);
    }
  }
}, 30000);

// Concurrent request limiter for summarize endpoint
let activeSummarizeRequests = 0;
const MAX_CONCURRENT_SUMMARIZE = 2;

// Terminal creation cap
const MAX_TERMINALS = 10;

/**
 * Hook ingestion rate limit middleware (applied to hookRouter externally).
 * Limits to 100 requests/sec per IP.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function hookRateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (isRateLimited(`hook:${ip}`, 100)) {
    return res.status(429).json({ success: false, error: 'Hook rate limit exceeded (100/sec)' });
  }
  next();
}

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
  broadcast({ type: WS_TYPES.CLEAR_BROWSER_DB });
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

// Get current hooks status from ~/.claude/settings.json
router.get('/hooks/status', (req, res) => {
  try {
    let claudeSettings = {};
    try {
      claudeSettings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    } catch { /* file doesn't exist yet */ }

    const hooks = claudeSettings.hooks || {};
    const installedEvents = ALL_CLAUDE_HOOK_EVENTS.filter(event =>
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
      log.error('api', `hooks/install failed: ${err.message}`);
      return res.status(500).json({ success: false, error: err.message, stdout, stderr });
    }
    log.info('api', `hooks/install: ${stdout.trim()}`);
    res.json({ ok: true, density, events: DENSITY_EVENTS[density], output: stdout });
  });
});

// Uninstall all dashboard hooks
router.post('/hooks/uninstall', (req, res) => {
  // Run install-hooks.js with --uninstall flag
  execFile('node', [INSTALL_HOOKS_SCRIPT, '--uninstall'], { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      log.error('api', `hooks/uninstall failed: ${err.message}`);
      return res.status(500).json({ success: false, error: err.message, stdout, stderr });
    }
    log.info('api', `hooks/uninstall: ${stdout.trim()}`);
    res.json({ ok: true, output: stdout });
  });
});

// ---- Session Control Endpoints ----

// Resume a disconnected SSH session — tries `claude --resume <id>` first,
// falls back to `claude --continue` if the conversation wasn't persisted.
router.post('/sessions/:id/resume', async (req, res) => {
  const sessionId = req.params.id;

  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Build resume command: try exact session ID first, fall back to --continue
  const resumeCmd = `claude --resume ${sessionId} || claude --continue`;

  const allTerminals = getTerminals();
  const terminalExists = session.lastTerminalId && allTerminals.some(t => t.terminalId === session.lastTerminalId);

  if (terminalExists) {
    // Terminal still alive — send resume command to it
    const result = resumeSession(sessionId);
    if (result.error) return res.status(400).json({ error: result.error });

    writeToTerminal(result.terminalId, `${resumeCmd}\r`);

    const { broadcast } = await import('./wsManager.js');
    broadcast({ type: WS_TYPES.SESSION_UPDATE, session: result.session });

    return res.json({ ok: true, terminalId: result.terminalId });
  }

  // Terminal no longer exists — create a new one and run resume command
  const cfg = session.sshConfig;
  const isRemote = cfg && cfg.host && cfg.host !== 'localhost' && cfg.host !== '127.0.0.1';

  // For non-SSH (display-only) sessions, create a local terminal in the project directory
  if (!cfg || !cfg.username) {
    if (isRemote) {
      return res.status(400).json({ error: 'No SSH config stored for this session — cannot reconnect to remote host' });
    }
  }

  try {
    // Create terminal with command='' to skip auto-launch (the resume command
    // contains || which can't pass shell metacharacter validation).
    // We write the command ourselves after the shell initializes.
    const newConfig = cfg && cfg.username
      ? { ...cfg, command: '' }
      : { host: 'localhost', workingDir: session.projectPath || '~', command: '' };
    const newTerminalId = await createTerminal(newConfig, null);

    // Update the REAL session and register pendingResume (no duplicate session)
    const result = reconnectSessionTerminal(sessionId, newTerminalId);
    if (result.error) return res.status(500).json({ error: result.error });

    // Write the resume command after the shell has initialized.
    // For remote sessions, cd to workDir first.
    const delay = isRemote ? 600 : 200;
    setTimeout(() => {
      const prefix = isRemote && cfg.workingDir ? `cd '${cfg.workingDir}' && ` : '';
      writeToTerminal(newTerminalId, `${prefix}${resumeCmd}\r`);
    }, delay);

    const { broadcast } = await import('./wsManager.js');
    broadcast({ type: WS_TYPES.SESSION_UPDATE, session: result.session });

    res.json({ ok: true, terminalId: newTerminalId, newTerminal: true });
  } catch (err) {
    log.error('api', `Resume with new terminal failed: ${err.message}`);
    res.status(500).json({ error: `Failed to create new terminal: ${err.message}` });
  }
});

// Kill session process — sends SIGTERM, then SIGKILL after 3s if still alive
router.post('/sessions/:id/kill', (req, res) => {
  if (!req.body.confirm) {
    return res.status(400).json({ success: false, error: 'Must send {confirm: true} to kill a session' });
  }
  const sessionId = req.params.id;
  const mem = getSession(sessionId);
  if (!mem) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
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
    broadcast({ type: WS_TYPES.SESSION_REMOVED, sessionId });
  } catch (e) {
    log.warn('api', `Failed to broadcast session_removed: ${e.message}`);
  }
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
  if (title === undefined) return res.status(400).json({ success: false, error: 'title is required' });
  if (typeof title !== 'string' || title.length > 500) {
    return res.status(400).json({ success: false, error: 'title must be a string (max 500 chars)' });
  }
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

/**
 * Summarize session using Claude CLI.
 * The frontend sends { context, promptTemplate } from IndexedDB data.
 * If custom_prompt is provided, use it directly as the prompt template.
 * @type {import('express').RequestHandler<{id: string}, import('../types/api').SummarizeResponse, import('../types/api').SummarizeRequest>}
 */
router.post('/sessions/:id/summarize', async (req, res) => {
  // Rate limit: max 2 concurrent summarize requests
  if (activeSummarizeRequests >= MAX_CONCURRENT_SUMMARIZE) {
    return res.status(429).json({ success: false, error: 'Too many concurrent summarize requests (max 2)' });
  }
  activeSummarizeRequests++;

  const sessionId = req.params.id;
  const { context, promptTemplate: bodyPromptTemplate, custom_prompt: customPrompt } = req.body;

  if (!context) {
    activeSummarizeRequests--;
    return res.status(400).json({ success: false, error: 'context is required in request body (prepared from IndexedDB data)' });
  }
  if (typeof context !== 'string') {
    activeSummarizeRequests--;
    return res.status(400).json({ success: false, error: 'context must be a string' });
  }

  // Validate custom_prompt if provided (will be passed to claude CLI stdin, not to shell)
  if (customPrompt && typeof customPrompt !== 'string') {
    activeSummarizeRequests--;
    return res.status(400).json({ success: false, error: 'custom_prompt must be a string' });
  }
  if (customPrompt && customPrompt.length > 10000) {
    activeSummarizeRequests--;
    return res.status(400).json({ success: false, error: 'custom_prompt too long (max 10000 chars)' });
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

    activeSummarizeRequests--;
    res.json({ ok: true, summary });
  } catch (err) {
    activeSummarizeRequests--;
    log.error('api', `Summarize error: ${err.message}`);
    res.status(500).json({ success: false, error: `Summarize failed: ${err.message}` });
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

/** @type {import('express').RequestHandler<{}, import('../types/api').CreateTerminalResponse, import('../types/api').CreateTerminalRequest>} */
router.post('/terminals', async (req, res) => {
  // Rate limit: max 10 terminals total
  const currentTerminals = getTerminals();
  if (currentTerminals.length >= MAX_TERMINALS) {
    return res.status(429).json({ success: false, error: `Terminal limit reached (max ${MAX_TERMINALS})` });
  }

  try {
    const { host, port, username, password, privateKeyPath, authMethod, workingDir, command, apiKey, tmuxSession, useTmux, sessionTitle, label } = req.body;

    // Input validation
    if (!username) return res.status(400).json({ success: false, error: 'username required' });
    if (!isValidUsername(username)) {
      return res.status(400).json({ success: false, error: 'username contains invalid characters' });
    }
    if (host && !isValidHost(host)) {
      return res.status(400).json({ success: false, error: 'host contains invalid characters' });
    }
    if (port && !isValidPort(port)) {
      return res.status(400).json({ success: false, error: 'port must be 1-65535' });
    }
    if (workingDir && !isValidWorkingDir(workingDir)) {
      return res.status(400).json({ success: false, error: 'workingDir contains invalid characters' });
    }
    if (command && !isValidCommand(command)) {
      return res.status(400).json({ success: false, error: 'command contains invalid shell characters' });
    }
    if (tmuxSession && (typeof tmuxSession !== 'string' || !/^[a-zA-Z0-9_.\-]+$/.test(tmuxSession))) {
      return res.status(400).json({ success: false, error: 'tmuxSession must be alphanumeric, dash, underscore, or dot' });
    }
    if (sessionTitle && !isValidString(sessionTitle, 500)) {
      return res.status(400).json({ success: false, error: 'sessionTitle must be a string (max 500 chars)' });
    }

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
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/terminals', (req, res) => {
  res.json({ terminals: getTerminals() });
});

router.delete('/terminals/:id', (req, res) => {
  closeTerminal(req.params.id);
  res.json({ ok: true });
});

// ── Team Endpoints ──

// Get team config from ~/.claude/teams/{teamName}/config.json
router.get('/teams/:teamId/config', (req, res) => {
  const team = getTeam(req.params.teamId);
  if (!team) {
    return res.status(404).json({ error: 'Team not found' });
  }
  if (!team.teamName) {
    return res.status(404).json({ error: 'Team has no name — cannot locate config' });
  }
  const config = readTeamConfig(team.teamName);
  if (!config) {
    return res.json({ teamName: team.teamName, config: null });
  }
  res.json({ teamName: team.teamName, config });
});

// Attach to a team member's tmux pane terminal
router.post('/teams/:teamId/members/:sessionId/terminal', async (req, res) => {
  // Rate limit: max terminals
  const currentTerminals = getTerminals();
  if (currentTerminals.length >= MAX_TERMINALS) {
    return res.status(429).json({ success: false, error: `Terminal limit reached (max ${MAX_TERMINALS})` });
  }

  const { teamId, sessionId } = req.params;

  // Validate team exists
  const team = getTeam(teamId);
  if (!team) {
    return res.status(404).json({ error: 'Team not found' });
  }

  // Validate session belongs to this team
  const isMember = sessionId === team.parentSessionId || team.childSessionIds.includes(sessionId);
  if (!isMember) {
    return res.status(404).json({ error: 'Session is not a member of this team' });
  }

  // Get the member's session to find tmuxPaneId
  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const tmuxPaneId = session.tmuxPaneId;
  if (!tmuxPaneId) {
    return res.status(400).json({ error: 'Session does not have a tmux pane ID — member may not be running in tmux' });
  }

  try {
    const terminalId = await attachToTmuxPane(tmuxPaneId, null);
    res.json({ ok: true, terminalId, tmuxPaneId });
  } catch (err) {
    log.error('api', `Failed to attach to tmux pane ${tmuxPaneId}: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;

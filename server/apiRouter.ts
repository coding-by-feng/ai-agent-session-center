// apiRouter.ts — Express router for all API endpoints
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

// Express 5 types req.params as string | string[] and req.query similarly.
// Our routes always use single-value params. This helper safely extracts a string.
function str(val: unknown): string {
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return String(val[0] ?? '');
  return val != null ? String(val) : '';
}
import { findClaudeProcess, killSession, archiveSession, setSessionTitle, setSessionLabel, setSessionAccentColor, setSummary, getSession, detectSessionSource, createTerminalSession, deleteSessionFromMemory, resumeSession, reconnectSessionTerminal } from './sessionStore.js';
import { createTerminal, closeTerminal, getTerminals, listSshKeys, listTmuxSessions, writeToTerminal, writeWhenReady, attachToTmuxPane, consumePendingLink } from './sshManager.js';
import { getTeam, readTeamConfig } from './teamManager.js';
import { getStats as getHookStats, resetStats as resetHookStats } from './hookStats.js';
import * as db from './db.js';
import { getMqStats } from './mqReader.js';
import { execFile } from 'child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, dirname, extname, basename } from 'path';
import { homedir, userInfo } from 'os';
import { fileURLToPath } from 'url';
import { ALL_CLAUDE_HOOK_EVENTS, DENSITY_EVENTS, SESSION_STATUS, WS_TYPES } from './constants.js';
import log from './logger.js';
import type { TerminalConfig } from '../src/types/terminal.js';

const __apiDirname = dirname(fileURLToPath(import.meta.url));

const router = Router();

// ---- Last-used Username Persistence ----

let _lastUsedUsername: string | null = null;

function getDefaultUsername(): string | null {
  if (_lastUsedUsername) return _lastUsedUsername;
  try { return userInfo().username; } catch { return null; }
}

function saveLastUsername(username: string): void {
  if (username) _lastUsedUsername = username;
}

function isLocalHost(host: string): boolean {
  return !host || host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// ---- Zod Validation Schemas ----

/** Rejects shell metacharacters that could enable injection */
const SHELL_META_RE = /[;|&$`\\!><()\n\r{}[\]]/;

const noShellMeta = (maxLen: number) =>
  z.string().max(maxLen).refine(s => !SHELL_META_RE.test(s), 'contains invalid shell characters');

const noShellMetaWorkDir = z.string().max(1024).refine(
  s => !SHELL_META_RE.test(s.replace(/^~/, '')),
  'contains invalid shell characters',
);

const usernameSchema = z.string().max(128).regex(/^[a-zA-Z0-9_.\-]+$/, 'username contains invalid characters');

const authMethodSchema = z.enum(['key', 'password']).optional();

const terminalCreateSchema = z.object({
  host: noShellMeta(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: usernameSchema.optional(),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  authMethod: authMethodSchema,
  workingDir: noShellMetaWorkDir.optional(),
  command: noShellMeta(512).optional(),
  apiKey: z.string().optional(),
  tmuxSession: z.string().regex(/^[a-zA-Z0-9_.\-]+$/, 'must be alphanumeric, dash, underscore, or dot').optional(),
  useTmux: z.boolean().optional(),
  sessionTitle: z.string().max(500).optional(),
  label: z.string().optional(),
});

const tmuxSessionsSchema = z.object({
  host: z.string().optional(),
  port: z.number().optional(),
  username: usernameSchema.optional(),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  authMethod: authMethodSchema,
});

const hookInstallSchema = z.object({
  density: z.enum(['high', 'medium', 'low']),
});

const killSessionSchema = z.object({
  confirm: z.literal(true),
});

const titleSchema = z.object({
  title: z.string().max(500),
});

const labelSchema = z.object({
  label: z.string(),
});

const accentColorSchema = z.object({
  color: z.string().min(1).max(50),
});

const summarizeSchema = z.object({
  context: z.string().min(1),
  promptTemplate: z.string().optional(),
  custom_prompt: z.string().max(10000).optional(),
});

const noteSchema = z.object({
  text: z.string().min(1).max(10000),
});

/** Helper: validate body with a Zod schema, send 400 on failure */
function validateBody<T>(schema: z.ZodType<T>, body: unknown, res: Response): T | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    const msg = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    res.status(400).json({ success: false, error: msg });
    return null;
  }
  return result.data;
}

// ---- Rate Limiting (in-memory, no external deps) ----

interface RateLimitBucket {
  count: number;
  windowStart: number;
}

// Sliding window rate limiter: tracks request counts per key per second
const rateLimitBuckets = new Map<string, RateLimitBucket>();

function isRateLimited(key: string, maxPerSecond: number): boolean {
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
 */
export function hookRateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(`hook:${ip}`, 100)) {
    res.status(429).json({ success: false, error: 'Hook rate limit exceeded (100/sec)' });
    return;
  }
  next();
}

// Hook performance stats
router.get('/hook-stats', (_req: Request, res: Response) => {
  res.json(getHookStats());
});

router.post('/hook-stats/reset', (_req: Request, res: Response) => {
  resetHookStats();
  res.json({ ok: true });
});

// Full reset — broadcast to all connected browsers to clear their IndexedDB
router.post('/reset', async (_req: Request, res: Response) => {
  const { broadcast } = await import('./wsManager.js');
  broadcast({ type: WS_TYPES.CLEAR_BROWSER_DB });
  res.json({ ok: true, message: 'Browser DB clear signal sent' });
});

// MQ reader stats
router.get('/mq-stats', (_req: Request, res: Response) => {
  res.json(getMqStats());
});

// ---- Hook Density Management ----

const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const INSTALL_HOOKS_SCRIPT = join(__apiDirname, '..', 'hooks', 'install-hooks.js');
const HOOK_PATTERN = 'dashboard-hook.';

// Get current hooks status from ~/.claude/settings.json
router.get('/hooks/status', (_req: Request, res: Response) => {
  try {
    let claudeSettings: Record<string, unknown> = {};
    try {
      claudeSettings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    } catch { /* file doesn't exist yet */ }

    const hooks = (claudeSettings.hooks || {}) as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Install hooks with specified density
router.post('/hooks/install', (req: Request, res: Response) => {
  const body = validateBody(hookInstallSchema, req.body, res);
  if (!body) return;
  const { density } = body;

  // Run install-hooks.js with --density flag
  execFile('node', [INSTALL_HOOKS_SCRIPT, '--density', density], { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      log.error('api', `hooks/install failed: ${err.message}`);
      res.status(500).json({ success: false, error: err.message, stdout, stderr });
      return;
    }
    log.info('api', `hooks/install: ${stdout.trim()}`);
    res.json({ ok: true, density, events: DENSITY_EVENTS[density as keyof typeof DENSITY_EVENTS], output: stdout });
  });
});

// Uninstall all dashboard hooks
router.post('/hooks/uninstall', (_req: Request, res: Response) => {
  // Run install-hooks.js with --uninstall flag
  execFile('node', [INSTALL_HOOKS_SCRIPT, '--uninstall'], { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      log.error('api', `hooks/uninstall failed: ${err.message}`);
      res.status(500).json({ success: false, error: err.message, stdout, stderr });
      return;
    }
    log.info('api', `hooks/uninstall: ${stdout.trim()}`);
    res.json({ ok: true, output: stdout });
  });
});

// ---- Session Control Endpoints ----

// Resume a disconnected SSH session — tries `claude --resume <id>` first,
// falls back to `claude --continue` if the conversation wasn't persisted.
router.post('/sessions/:id/resume', async (req: Request, res: Response) => {
  const sessionId = str(req.params.id);

  const session = getSession(sessionId);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

  // Build resume command: try exact session ID first, fall back to --continue
  const resumeCmd = `claude --resume ${sessionId} || claude --continue`;

  const allTerminals = getTerminals();
  const terminalExists = session.lastTerminalId && allTerminals.some(t => t.terminalId === session.lastTerminalId);

  if (terminalExists) {
    // Terminal still alive — send resume command to it
    const result = resumeSession(sessionId);
    if ('error' in result) { res.status(400).json({ error: result.error }); return; }

    writeToTerminal(result.terminalId, `${resumeCmd}\r`);

    const { broadcast } = await import('./wsManager.js');
    broadcast({ type: WS_TYPES.SESSION_UPDATE, session: result.session });

    res.json({ ok: true, terminalId: result.terminalId });
    return;
  }

  // Terminal no longer exists — create a new one and run resume command
  const cfg = session.sshConfig;
  const isRemote = cfg && cfg.host && cfg.host !== 'localhost' && cfg.host !== '127.0.0.1';

  // For non-SSH (display-only) sessions, create a local terminal in the project directory
  if (!cfg || !cfg.username) {
    if (isRemote) {
      res.status(400).json({ error: 'No SSH config stored for this session — cannot reconnect to remote host' });
      return;
    }
  }

  try {
    // Create terminal with command='' to skip auto-launch (the resume command
    // contains || which can't pass shell metacharacter validation).
    // We write the command ourselves after the shell initializes.
    const newConfig: TerminalConfig = cfg && cfg.username
      ? { ...cfg, workingDir: cfg.workingDir || '~', command: '' }
      : { host: 'localhost', workingDir: session.projectPath || '~', command: '' };
    const newTerminalId = await createTerminal(newConfig, null);

    // Immediately consume the pendingLink that createTerminal registered.
    // The resume flow uses pendingResume (not pendingLinks) for session matching.
    // If we leave the pendingLink alive, ANY other Claude session in the same
    // working directory could match it via Priority 2 (tryLinkByWorkDir),
    // stealing the terminal and creating a duplicate card.
    consumePendingLink(newConfig.workingDir || session.projectPath || '');

    // Update the REAL session and register pendingResume (no duplicate session)
    const result = reconnectSessionTerminal(sessionId, newTerminalId);
    if ('error' in result) { res.status(500).json({ error: result.error }); return; }

    // Write the resume command once the shell is ready (prompt detected).
    // For remote sessions, export AGENT_MANAGER_TERMINAL_ID (SSH doesn't
    // forward env vars) and cd to workDir first.
    let prefix = '';
    if (isRemote) {
      prefix += `export AGENT_MANAGER_TERMINAL_ID='${newTerminalId}' && `;
      if (cfg?.workingDir) prefix += `cd '${cfg.workingDir}' && `;
    }
    writeWhenReady(newTerminalId, `${prefix}${resumeCmd}\r`);

    const { broadcast } = await import('./wsManager.js');
    broadcast({ type: WS_TYPES.SESSION_UPDATE, session: result.session });

    res.json({ ok: true, terminalId: newTerminalId, newTerminal: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('api', `Resume with new terminal failed: ${msg}`);
    res.status(500).json({ error: `Failed to create new terminal: ${msg}` });
  }
});

// Reconnect an ended SSH session's terminal — creates a new PTY and links it
// to the existing session. Used by the RECONNECT button in the detail panel.
router.post('/sessions/:id/reconnect-terminal', async (req: Request, res: Response) => {
  const sessionId = str(req.params.id);
  const session = getSession(sessionId);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (session.source !== 'ssh') { res.status(400).json({ error: 'Reconnect only available for SSH sessions' }); return; }

  const cfg = session.sshConfig;
  if (!cfg) {
    res.status(400).json({ error: 'No SSH config stored for this session' });
    return;
  }

  try {
    const newConfig: TerminalConfig = { ...cfg, workingDir: cfg.workingDir || '~', command: 'claude' };
    const newTerminalId = await createTerminal(newConfig, null);
    consumePendingLink(newConfig.workingDir || session.projectPath || '');

    const result = reconnectSessionTerminal(sessionId, newTerminalId);
    if ('error' in result) { res.status(500).json({ error: result.error }); return; }

    const { broadcast } = await import('./wsManager.js');
    broadcast({ type: WS_TYPES.SESSION_UPDATE, session: result.session });

    res.json({ ok: true, terminalId: newTerminalId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('api', `Reconnect terminal failed: ${msg}`);
    res.status(500).json({ error: `Failed to reconnect terminal: ${msg}` });
  }
});

// Kill session process — sends SIGTERM, then SIGKILL after 3s if still alive
router.post('/sessions/:id/kill', (req: Request, res: Response) => {
  const body = validateBody(killSessionSchema, req.body, res);
  if (!body) return;
  const sessionId = str(req.params.id);
  const mem = getSession(sessionId);
  if (!mem) {
    res.status(404).json({ success: false, error: 'Session not found' });
    return;
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
        } catch { /* already dead — good */ }
      }, 3000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: `Failed to kill PID ${pid}: ${msg}` });
      return;
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
    res.status(404).json({ error: 'Session not found and no matching process' });
    return;
  }
  res.json({ ok: true, pid: pid || null, source });
});

// Permanently delete a session — removes from memory, broadcasts removal to clients
router.delete('/sessions/:id', async (req: Request, res: Response) => {
  const sessionId = str(req.params.id);
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
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn('api', `Failed to broadcast session_removed: ${msg}`);
  }
  res.json({ ok: true, removed });
});

// Detect session source (vscode / terminal)
router.get('/sessions/:id/source', (req: Request, res: Response) => {
  const source = detectSessionSource(str(req.params.id));
  res.json({ source });
});

// Update session title (in-memory only, no DB write)
router.put('/sessions/:id/title', (req: Request, res: Response) => {
  const body = validateBody(titleSchema, req.body, res);
  if (!body) return;
  setSessionTitle(str(req.params.id), body.title);
  res.json({ ok: true });
});

// Update session label (in-memory only, no DB write)
router.put('/sessions/:id/label', (req: Request, res: Response) => {
  const body = validateBody(labelSchema, req.body, res);
  if (!body) return;
  setSessionLabel(str(req.params.id), body.label);
  res.json({ ok: true });
});

// Update session accent color
router.put('/sessions/:id/accent-color', (req: Request, res: Response) => {
  const body = validateBody(accentColorSchema, req.body, res);
  if (!body) return;
  setSessionAccentColor(str(req.params.id), body.color);
  res.json({ ok: true });
});

/**
 * Summarize session using Claude CLI.
 * The frontend sends { context, promptTemplate } from IndexedDB data.
 * If custom_prompt is provided, use it directly as the prompt template.
 */
router.post('/sessions/:id/summarize', async (req: Request, res: Response) => {
  // Rate limit: max 2 concurrent summarize requests
  if (activeSummarizeRequests >= MAX_CONCURRENT_SUMMARIZE) {
    res.status(429).json({ success: false, error: 'Too many concurrent summarize requests (max 2)' });
    return;
  }
  activeSummarizeRequests++;

  const sessionId = str(req.params.id);
  const body = validateBody(summarizeSchema, req.body, res);
  if (!body) {
    activeSummarizeRequests--;
    return;
  }
  const { context, promptTemplate: bodyPromptTemplate, custom_prompt: customPrompt } = body;

  // Determine prompt template: custom_prompt > bodyPromptTemplate > default
  const promptTemplate = customPrompt || bodyPromptTemplate || 'Summarize this Claude Code session in detail.';

  const summaryPrompt = `${promptTemplate}\n\n--- SESSION TRANSCRIPT ---\n${context}`;

  try {
    const summary = await new Promise<string>((resolve, reject) => {
      const child = execFile('claude', ['-p', '--model', 'haiku'], {
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      }, (error, stdout) => {
        if (error) return reject(error);
        resolve(stdout.trim());
      });
      child.stdin!.write(summaryPrompt);
      child.stdin!.end();
    });

    // Store summary in memory
    setSummary(sessionId, summary);
    archiveSession(sessionId, true);

    activeSummarizeRequests--;
    res.json({ ok: true, summary });
  } catch (err: unknown) {
    activeSummarizeRequests--;
    const msg = err instanceof Error ? err.message : String(err);
    log.error('api', `Summarize error: ${msg}`);
    res.status(500).json({ success: false, error: `Summarize failed: ${msg}` });
  }
});

// ── SSH Keys ──

router.get('/ssh-keys', (_req: Request, res: Response) => {
  res.json({ keys: listSshKeys() });
});

// ── Tmux Sessions ──

router.post('/tmux-sessions', async (req: Request, res: Response) => {
  const body = validateBody(tmuxSessionsSchema, req.body, res);
  if (!body) return;
  try {
    const resolvedHost = body.host || 'localhost';
    const username = body.username || getDefaultUsername() || (isLocalHost(resolvedHost) ? 'local' : null);
    if (!username) { res.status(400).json({ error: 'username required' }); return; }
    const config: TerminalConfig = {
      host: resolvedHost,
      port: body.port || 22,
      username,
      authMethod: body.authMethod || 'key',
      privateKeyPath: body.privateKeyPath,
      workingDir: '~',
      command: '',
      password: body.password,
    };
    const sessions = await listTmuxSessions(config);
    res.json({ sessions });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── Terminals ──

router.post('/terminals', async (req: Request, res: Response) => {
  // Rate limit: max 10 terminals total
  const currentTerminals = getTerminals();
  if (currentTerminals.length >= MAX_TERMINALS) {
    res.status(429).json({ success: false, error: `Terminal limit reached (max ${MAX_TERMINALS})` });
    return;
  }

  const body = validateBody(terminalCreateSchema, req.body, res);
  if (!body) return;

  try {
    const resolvedHost = body.host || 'localhost';
    const username = body.username || getDefaultUsername() || (isLocalHost(resolvedHost) ? 'local' : null);
    if (!username) {
      res.status(400).json({ success: false, error: 'username required — set it once in "+ NEW SESSION" and it will be reused' });
      return;
    }
    saveLastUsername(username);

    const config: TerminalConfig = {
      host: resolvedHost,
      port: body.port || 22,
      username,
      authMethod: body.authMethod || 'key',
      privateKeyPath: body.privateKeyPath,
      workingDir: body.workingDir || '~',
      command: body.command || 'claude',
      password: body.password,
    };

    // Tmux modes
    if (body.tmuxSession) config.tmuxSession = body.tmuxSession;
    if (body.useTmux) config.useTmux = true;
    if (body.sessionTitle) config.sessionTitle = body.sessionTitle;
    if (body.label) config.label = body.label;

    // Resolve API key from request body only (no DB lookup)
    if (body.apiKey) {
      config.apiKey = body.apiKey;
    }

    const terminalId = await createTerminal(config, null);
    // Create session card immediately so it appears in the dashboard
    await createTerminalSession(terminalId, config);
    res.json({ ok: true, terminalId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

router.get('/terminals', (_req: Request, res: Response) => {
  res.json({ terminals: getTerminals() });
});

router.delete('/terminals/:id', (req: Request, res: Response) => {
  closeTerminal(str(req.params.id));
  res.json({ ok: true });
});

// Write data to a terminal's PTY (used by queue prompt send)
router.post('/terminals/:id/write', (req: Request, res: Response) => {
  const terminalId = str(req.params.id);
  const { data } = req.body || {};
  if (!data || typeof data !== 'string') {
    res.status(400).json({ error: 'Missing or invalid "data" field' });
    return;
  }
  const terminals = getTerminals();
  const exists = terminals.some((t) => t.terminalId === terminalId);
  if (!exists) {
    res.status(404).json({ error: 'Terminal not found' });
    return;
  }
  writeToTerminal(terminalId, data);
  res.json({ ok: true });
});

// ── Team Endpoints ──

// Get team config from ~/.claude/teams/{teamName}/config.json
router.get('/teams/:teamId/config', (req: Request, res: Response) => {
  const team = getTeam(str(req.params.teamId));
  if (!team) {
    res.status(404).json({ error: 'Team not found' });
    return;
  }
  if (!team.teamName) {
    res.status(404).json({ error: 'Team has no name — cannot locate config' });
    return;
  }
  const config = readTeamConfig(team.teamName);
  if (!config) {
    res.json({ teamName: team.teamName, config: null });
    return;
  }
  res.json({ teamName: team.teamName, config });
});

// Attach to a team member's tmux pane terminal
router.post('/teams/:teamId/members/:sessionId/terminal', async (req: Request, res: Response) => {
  // Rate limit: max terminals
  const currentTerminals = getTerminals();
  if (currentTerminals.length >= MAX_TERMINALS) {
    res.status(429).json({ success: false, error: `Terminal limit reached (max ${MAX_TERMINALS})` });
    return;
  }

  const teamId = str(req.params.teamId);
  const sessionId = str(req.params.sessionId);

  // Validate team exists
  const team = getTeam(teamId);
  if (!team) {
    res.status(404).json({ error: 'Team not found' });
    return;
  }

  // Validate session belongs to this team
  const isMember = sessionId === team.parentSessionId || team.childSessionIds.includes(sessionId);
  if (!isMember) {
    res.status(404).json({ error: 'Session is not a member of this team' });
    return;
  }

  // Get the member's session to find tmuxPaneId
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const tmuxPaneId = session.tmuxPaneId;
  if (!tmuxPaneId) {
    res.status(400).json({ error: 'Session does not have a tmux pane ID — member may not be running in tmux' });
    return;
  }

  try {
    const terminalId = await attachToTmuxPane(tmuxPaneId, null);
    res.json({ ok: true, terminalId, tmuxPaneId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('api', `Failed to attach to tmux pane ${tmuxPaneId}: ${msg}`);
    res.status(500).json({ success: false, error: msg });
  }
});

// ---- Session History & DB endpoints (SQLite) ----

// Search/list sessions from DB (used by history panel, replaces IndexedDB reads)
router.get('/db/sessions', (req: Request, res: Response) => {
  const { query, project, status, dateFrom, dateTo, archived, sortBy, sortDir, page, pageSize } = req.query;
  const result = db.searchSessions({
    query: (query as string) || undefined,
    project: (project as string) || undefined,
    status: (status as string) || undefined,
    dateFrom: dateFrom ? Number(dateFrom) : undefined,
    dateTo: dateTo ? Number(dateTo) : undefined,
    archived: (archived as string) || undefined,
    sortBy: ((sortBy as string) || 'started_at') as 'started_at' | 'last_activity_at' | 'project_name' | 'status',
    sortDir: ((sortDir as string) || 'desc') as 'asc' | 'desc',
    page: page ? Number(page) : 1,
    pageSize: pageSize ? Number(pageSize) : 50,
  });
  res.json(result);
});

// Get single session detail with all child records
router.get('/db/sessions/:id', (req: Request, res: Response) => {
  const detail = db.getSessionDetail(str(req.params.id));
  if (!detail) { res.status(404).json({ error: 'Session not found' }); return; }
  res.json(detail);
});

// Delete session from DB (cascade)
router.delete('/db/sessions/:id', (req: Request, res: Response) => {
  db.deleteSessionCascade(str(req.params.id));
  res.json({ ok: true });
});

// Get distinct projects
router.get('/db/projects', (_req: Request, res: Response) => {
  res.json(db.getDistinctProjects());
});

// Full-text search across prompts and responses
router.get('/db/search', (req: Request, res: Response) => {
  const { query, type, page, pageSize } = req.query;
  res.json(db.fullTextSearch({
    query: (query as string) || '',
    type: (type as string) || 'all',
    page: page ? Number(page) : 1,
    pageSize: pageSize ? Number(pageSize) : 50,
  }));
});

// ---- Notes (server-side, shared across all clients) ----

router.get('/db/sessions/:id/notes', (req: Request, res: Response) => {
  res.json(db.getNotes(str(req.params.id)));
});

router.post('/db/sessions/:id/notes', (req: Request, res: Response) => {
  const body = validateBody(noteSchema, req.body, res);
  if (!body) return;
  const note = db.addNote(str(req.params.id), body.text.trim());
  res.json(note);
});

router.delete('/db/notes/:id', (req: Request, res: Response) => {
  db.deleteNote(Number(str(req.params.id)));
  res.json({ ok: true });
});

// ---- Analytics (server-side, shared across all clients) ----

router.get('/db/analytics/summary', (_req: Request, res: Response) => {
  res.json(db.getSummaryStats());
});

router.get('/db/analytics/tools', (_req: Request, res: Response) => {
  res.json(db.getToolBreakdown());
});

router.get('/db/analytics/projects', (_req: Request, res: Response) => {
  res.json(db.getActiveProjects());
});

router.get('/db/analytics/heatmap', (_req: Request, res: Response) => {
  res.json(db.getHeatmap());
});

// Legacy endpoint (kept for backward compatibility)
router.get('/sessions/history', (req: Request, res: Response) => {
  const projectPath = str(req.query.projectPath);
  if (projectPath) {
    if (projectPath.length > 1024) {
      res.status(400).json({ error: 'Invalid projectPath' });
      return;
    }
    res.json(db.getSessionsByProjectPath(projectPath));
    return;
  }
  res.json(db.getAllPersistedSessions());
});

// ---- Known Claude Code projects (from ~/.claude/projects/) ----

/**
 * Decode a Claude Code project directory name back to a real filesystem path.
 * Encoding: leading `-` = `/`, `--` = `.`, other `-` = `/` (but ambiguous
 * when folder names contain hyphens like `agent-manager`).
 * We resolve ambiguity by greedily matching against the actual filesystem.
 */
function decodeProjectDir(encoded: string): string | null {
  if (!encoded.startsWith('-')) return null;

  // Replace `--` with a placeholder for `.` before splitting
  const DOT = '\x00';
  const prepared = encoded.slice(1).replace(/--/g, DOT);
  const parts = prepared.split('-').map((p) => p.replaceAll(DOT, '.'));

  // Greedily resolve: try longest segment match against filesystem first
  function resolve(current: string, idx: number): string | null {
    if (idx >= parts.length) return current;
    for (let end = parts.length; end > idx; end--) {
      const candidate = parts.slice(idx, end).join('-');
      const fullPath = join(current, candidate);
      if (existsSync(fullPath)) {
        const result = resolve(fullPath, end);
        if (result !== null) return result;
      }
    }
    return null;
  }

  return resolve('/', 0);
}

router.get('/known-projects', (_req: Request, res: Response) => {
  try {
    const projectsDir = join(homedir(), '.claude', 'projects');
    const entries = readdirSync(projectsDir, { withFileTypes: true });
    const paths: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.includes('worktrees')) continue;

      const decoded = decodeProjectDir(entry.name);
      if (decoded && decoded !== '/') {
        paths.push(decoded);
      }
    }

    paths.sort();
    res.json({ paths });
  } catch {
    res.json({ paths: [] });
  }
});

// ---- File Browser (Project Tab) ----

/** Allowed text extensions for file preview (binary files are rejected). */
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.js', '.ts', '.tsx', '.jsx', '.css', '.scss',
  '.html', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.h',
  '.sql', '.graphql', '.prisma', '.env', '.env.example', '.env.local',
  '.gitignore', '.dockerignore', '.editorconfig', '.eslintrc',
  '.prettierrc', '.babelrc', '.nvmrc',
  '.csv', '.tsv', '.log', '.diff', '.patch',
  '.svelte', '.vue', '.astro', '.mdx',
]);

/** Names that are always considered text (no extension). */
const TEXT_NAMES = new Set([
  'Dockerfile', 'Makefile', 'Gemfile', 'Rakefile', 'Procfile',
  'LICENSE', 'CHANGELOG', 'README', 'CLAUDE.md',
  '.gitignore', '.dockerignore', '.editorconfig',
]);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

/** Directories to skip when listing. */
const HIDDEN_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '__pycache__', '.venv',
  'venv', 'dist', 'build', '.cache', '.turbo', 'coverage', '.svelte-kit',
]);

function isTextFile(name: string): boolean {
  if (TEXT_NAMES.has(name)) return true;
  const ext = extname(name).toLowerCase();
  return ext === '' || TEXT_EXTENSIONS.has(ext);
}

/** Resolve and validate a requested path is within the project root. */
function resolveProjectPath(projectRoot: string, relPath: string): string | null {
  // Prevent traversal: normalise, then ensure it's within root
  const resolved = join(projectRoot, relPath);
  const normalised = join(resolved); // removes .., . etc
  if (!normalised.startsWith(projectRoot)) return null;
  return normalised;
}

const filePathSchema = z.object({
  path: z.string().max(1024).default('/'),
});

/** GET /api/files/list?root=<projectPath>&path=<relative> — list directory contents */
router.get('/files/list', (req: Request, res: Response) => {
  const root = str(req.query.root);
  if (!root) { res.status(400).json({ error: 'root query param required' }); return; }

  const body = filePathSchema.safeParse({ path: str(req.query.path) || '/' });
  if (!body.success) { res.status(400).json({ error: 'Invalid path' }); return; }

  const relPath = body.data.path;
  const fullPath = resolveProjectPath(root, relPath);
  if (!fullPath) { res.status(400).json({ error: 'Path outside project root' }); return; }

  try {
    if (!existsSync(fullPath)) { res.status(404).json({ error: 'Directory not found' }); return; }

    const stat = statSync(fullPath);
    if (!stat.isDirectory()) { res.status(400).json({ error: 'Not a directory' }); return; }

    const entries = readdirSync(fullPath, { withFileTypes: true });
    const items: Array<{ name: string; type: 'dir' | 'file'; size?: number }> = [];

    for (const entry of entries) {
      // Skip hidden dirs (but show hidden files like .env)
      if (entry.isDirectory() && HIDDEN_DIRS.has(entry.name)) continue;
      // Skip dot-prefixed directories (e.g. .git) but show dot files
      if (entry.isDirectory() && entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        items.push({ name: entry.name, type: 'dir' });
      } else {
        try {
          const fileStat = statSync(join(fullPath, entry.name));
          items.push({ name: entry.name, type: 'file', size: fileStat.size });
        } catch {
          items.push({ name: entry.name, type: 'file' });
        }
      }
    }

    // Sort: directories first, then files, both alphabetical
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    res.json({ path: relPath, items });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/files/read?root=<projectPath>&path=<relative> — read a file */
router.get('/files/read', (req: Request, res: Response) => {
  const root = str(req.query.root);
  if (!root) { res.status(400).json({ error: 'root query param required' }); return; }

  const body = filePathSchema.safeParse({ path: str(req.query.path) });
  if (!body.success) { res.status(400).json({ error: 'Invalid path' }); return; }

  const relPath = body.data.path;
  const fullPath = resolveProjectPath(root, relPath);
  if (!fullPath) { res.status(400).json({ error: 'Path outside project root' }); return; }

  try {
    if (!existsSync(fullPath)) { res.status(404).json({ error: 'File not found' }); return; }

    const stat = statSync(fullPath);
    if (stat.isDirectory()) { res.status(400).json({ error: 'Path is a directory, not a file' }); return; }
    if (stat.size > MAX_FILE_SIZE) { res.status(413).json({ error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, max 2 MB)` }); return; }

    const name = basename(fullPath);
    if (!isTextFile(name)) {
      res.json({ path: relPath, binary: true, size: stat.size, name });
      return;
    }

    const content = readFileSync(fullPath, 'utf8');
    const ext = extname(name).toLowerCase().replace('.', '') || 'text';
    res.json({ path: relPath, content, ext, size: stat.size, name });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;

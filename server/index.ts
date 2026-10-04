// index.ts — Express + WS server entry point (thin orchestrator)
// Quick start: npm start -> auto-installs hooks, starts server, opens browser
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execFile } from 'child_process';
import hookRouter from './hookRouter.js';
import { handleConnection, stopHeartbeat, broadcast } from './wsManager.js';
import { getAllSessions, loadSnapshot, saveSnapshot, startPeriodicSave, stopPeriodicSave, startPlanUsage, stopPlanUsage, getSessionsForRespawn, reconnectSessionTerminal } from './sessionStore.js';
import { createTerminal, consumePendingLink, writeWhenReady } from './sshManager.js';
import { WS_TYPES } from './constants.js';
import { closeDb, markStaleSessionsEnded } from './db.js';
import apiRouter, { hookRateLimitMiddleware } from './apiRouter.js';
import { createResourceRouter, resourceErrorHandler } from './resourceRouter.js';
import { startMqReader, stopMqReader, getMqOffset } from './mqReader.js';
import log from './logger.js';
import { config } from './serverConfig.js';
import { reconstructPermissionFlags } from './config.js';
import { ensureHooksInstalled } from './hookInstaller.js';
import { resolvePort, killPortProcess } from './portManager.js';
import { getLocalIP } from './networkInfo.js';
import { isLoopbackAddress } from './presenceManager.js';
import {
  isPasswordEnabled, verifyPassword, createToken, validateToken,
  removeToken, parseCookieToken, extractToken, authMiddleware,
  startTokenCleanup, stopTokenCleanup, checkLoginRateLimit,
  recordLoginAttempt, clearLoginAttempts, refreshToken, getTokenTTL,
  localhostOnlyMiddleware, TOKEN_TTL_SECONDS,
} from './authManager.js';
import { startNoteMediaSweeper } from './noteMedia.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Auto-open browser
function openBrowser(url: string, noOpen: boolean): void {
  if (noOpen) return;
  if (process.env.ELECTRON) return; // Electron hosts its own window — never open a system browser
  try {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    execFile(cmd, [url], { timeout: 5000 }, () => { /* ignore errors */ });
  } catch {
    // Browser open failed -- not critical
  }
}

// Shutdown function set inside startServer, callable by Electron before quit
let _shutdownFn: (() => Promise<void>) | null = null;
/** Gracefully shut down the server (save snapshot, close DB, stop timers).
 *  Called by Electron before app.quit() to guarantee state is saved. */
export async function shutdownServer(): Promise<void> {
  if (_shutdownFn) await _shutdownFn();
}

export function startServer(port?: number): Promise<number> {
  const args = process.argv.slice(2);
  const noOpen = args.includes('--no-open');

  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 }); // 512KB max WS message (supports large terminal pastes)

  app.use(express.json({ limit: '50mb' }));

  // -- Security headers --
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // HSTS when behind TLS terminating proxy
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    // CSP: connect-src is 'self' (covers ws:/wss: same-origin) plus the one CDN
    // the app still fetches from. jsDelivr is required by troika-three-text's
    // unicode-font-resolver in the 3D scene.
    //
    // The huggingface.co / *.hf.co / cas-bridge.xethub.hf.co hosts were dropped
    // in Aug 2026 along with the local Kokoro voice: they existed solely to
    // fetch that model's weights, and leaving them would grant the renderer
    // network access to third-party origins nothing reaches any more.
    //
    // 'wasm-unsafe-eval' is DELIBERATELY kept. It was introduced for the ONNX
    // runtime the local voice compiled, but a `WebAssembly` reference survives
    // in the built client bundle, so removing it risks a runtime failure that
    // no test here would catch — Chromium refuses the module with "Compiling or
    // instantiating WebAssembly module violates ... 'unsafe-eval' is not an
    // allowed source". It permits WebAssembly compilation only; it does NOT
    // enable eval() of JavaScript strings, so it remains far narrower than
    // 'unsafe-eval'. Verify the real consumer before removing it.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: blob:; font-src 'self' data: https://cdn.jsdelivr.net; worker-src 'self' blob:; frame-src 'self' blob:",
    );
    next();
  });

  // -- Auth endpoints (no auth required) --
  app.get('/api/auth/status', (req, res) => {
    const passwordRequired = isPasswordEnabled();
    const token = parseCookieToken(req.headers.cookie);
    const authenticated = passwordRequired ? validateToken(token) : true;
    res.json({ passwordRequired, authenticated });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!isPasswordEnabled()) {
      res.json({ success: true });
      return;
    }

    // Rate limit: 5 attempts per 15 minutes per IP
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const lockoutSeconds = checkLoginRateLimit(ip);
    if (lockoutSeconds > 0) {
      res.status(429).json({
        error: `Too many login attempts. Try again in ${Math.ceil(lockoutSeconds / 60)} minute(s).`,
        retryAfter: lockoutSeconds,
      });
      return;
    }

    const { password } = req.body || {};
    if (!password || typeof password !== 'string') {
      res.status(400).json({ error: 'Password is required' });
      return;
    }
    if (!verifyPassword(password, config.passwordHash ?? '')) {
      recordLoginAttempt(ip);
      log.warn('auth', `Failed login attempt from IP ${ip}`);
      res.status(401).json({ error: 'Wrong password' });
      return;
    }

    clearLoginAttempts(ip);
    log.warn('auth', `Successful login from IP ${ip}`);
    const token = createToken();
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const secureSuffix = isSecure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `auth_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_TTL_SECONDS}${secureSuffix}`);
    res.json({ success: true, expiresIn: TOKEN_TTL_SECONDS });
  });

  app.post('/api/auth/refresh', (req, res) => {
    if (!isPasswordEnabled()) {
      res.json({ success: true });
      return;
    }
    const oldToken = parseCookieToken(req.headers.cookie) ?? extractToken(req);
    const newToken = refreshToken(oldToken);
    if (!newToken) {
      res.status(401).json({ error: 'Token expired or invalid — please login again' });
      return;
    }
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const secureSuffix = isSecure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `auth_token=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_TTL_SECONDS}${secureSuffix}`);
    res.json({ success: true, expiresIn: TOKEN_TTL_SECONDS });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = parseCookieToken(req.headers.cookie);
    removeToken(token ?? '');
    res.setHeader('Set-Cookie', 'auth_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ success: true });
  });

  // -- Static files (Vite-built React SPA) --
  const clientDir = join(__dirname, '..', 'dist', 'client');
  app.use(express.static(clientDir));

  // -- Hook endpoints (localhost only -- CLI hooks must work without login but are restricted to loopback) --
  app.use('/api/hooks', localhostOnlyMiddleware, hookRateLimitMiddleware, hookRouter);

  // -- Agent Resources (RESOURCES tab) --
  // Read-only catalog of ~/.claude, ~/.codex, ~/.agents and project resources.
  // Mounted before the generic /api router so it owns its prefix; the router
  // itself answers loopback requests only (404 for every other device).
  app.use('/api/resources', authMiddleware, createResourceRouter({
    sessionProjectPaths: () =>
      Object.values(getAllSessions()).map((s) => s.projectPath).filter(Boolean),
  }));
  // The global express.json() above parses bodies before the router runs, so a
  // malformed body never reaches the router's own handler — without this it
  // falls through to Express's default page, stack trace included.
  app.use('/api/resources', resourceErrorHandler);

  // -- Protected API routes --
  app.use('/api', authMiddleware, apiRouter);
  app.get('/api/sessions', authMiddleware, (_req, res) => {
    log.debug('api', 'GET /api/sessions');
    res.json(getAllSessions());
  });

  // Request logging middleware (debug mode only) — strip tokens from logged URLs
  if (log.isDebug) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const sanitizedUrl = req.originalUrl.replace(/token=[^&]+/, 'token=***');
        log.debug('http', `${req.method} ${sanitizedUrl} ${res.statusCode} ${Date.now() - start}ms`);
      });
      next();
    });
  }

  // -- SPA fallback: serve index.html for all non-API routes (React Router) --
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(join(clientDir, 'index.html'));
  });

  // -- WebSocket with origin validation + auth --
  wss.on('connection', (ws, req) => {
    // Origin validation: only allow same-host connections to prevent CSWSH
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          log.warn('ws', `Rejected WebSocket from foreign origin: ${origin} (expected host: ${host})`);
          ws.close(4003, 'Forbidden: origin mismatch');
          return;
        }
      } catch {
        log.warn('ws', `Rejected WebSocket with invalid origin: ${origin}`);
        ws.close(4003, 'Forbidden: invalid origin');
        return;
      }
    }

    // Same two-dimensional gate as authMiddleware — this socket carries every
    // session's live content plus terminal write, so leaving it open when the
    // HTTP side is closed would defeat the whole thing.
    const wsAddress = req.socket?.remoteAddress ?? '';
    const wsIsRemote = !isLoopbackAddress(wsAddress);
    if (isPasswordEnabled()) {
      // Prefer cookie-based auth (avoids token in URL query string)
      const token = parseCookieToken(req.headers.cookie) ?? extractToken(req);
      if (!validateToken(token)) {
        log.debug('auth', 'Rejected unauthorized WebSocket connection');
        ws.close(4001, 'Unauthorized');
        return;
      }
    } else if (wsIsRemote) {
      // No password configured: loopback still connects freely (the desktop
      // app), but a remote device is refused. 4003 "Forbidden" rather than
      // 4001 "Unauthorized" — 4001 means "your token was bad" and would send
      // the client to a login screen that cannot help it.
      log.warn('auth', `Blocked remote WebSocket (no password configured) from ${wsAddress}`);
      ws.close(4003, 'Forbidden: set a password to allow remote devices');
      return;
    }
    // Identity travels on the upgrade URL rather than a post-connect handshake:
    // `handleConnection` sends the snapshot and registers presence immediately,
    // so an async hello would race its own first broadcast.
    let clientId = '';
    let label = '';
    try {
      const params = new URL(req.url ?? '', 'http://localhost').searchParams;
      clientId = (params.get('clientId') ?? '').slice(0, 128);
      label = (params.get('label') ?? '').slice(0, 200);
    } catch {
      /* malformed URL — connect as an unidentified client */
    }
    handleConnection(ws, {
      clientId,
      label,
      address: req.socket.remoteAddress ?? '',
    });
  });

  wss.on('error', (err) => {
    log.warn('ws', `WebSocket server error: ${err.message}`);
  });

  const PORT = port ?? resolvePort(args, config);

  /**
   * After snapshot restore, respawn PTY terminals for SSH sessions that
   * were active before the server went down. Each session gets a new terminal
   * linked via reconnectSessionTerminal + a `claude --resume` command.
   */
  async function respawnSshTerminals(): Promise<void> {
    const toRespawn = getSessionsForRespawn();
    if (toRespawn.length === 0) return;
    log.info('server', `Auto-respawning ${toRespawn.length} SSH terminal(s) from previous session...`);

    for (const { sessionId, session } of toRespawn) {
      const MAX_RETRIES = 3;
      const RETRY_DELAYS = [0, 3000, 10000]; // immediate, 3s, 10s
      let succeeded = false;

      for (let attempt = 0; attempt < MAX_RETRIES && !succeeded; attempt++) {
        if (attempt > 0) {
          log.info('server', `Retry ${attempt}/${MAX_RETRIES - 1} for session ${sessionId.slice(0, 8)} in ${RETRY_DELAYS[attempt] / 1000}s...`);
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        }
        try {
          const cfg = session.sshConfig!;
          const isRemote = cfg.host && cfg.host !== 'localhost' && cfg.host !== '127.0.0.1';

          // command='' skips auto-launch; we write the resume command ourselves
          const newConfig = {
            host: cfg.host || 'localhost',
            port: cfg.port,
            username: cfg.username,
            authMethod: cfg.authMethod,
            privateKeyPath: cfg.privateKeyPath,
            workingDir: cfg.workingDir || session.projectPath || '~',
            command: '',
          };
          const newTerminalId = await createTerminal(newConfig, null);
          consumePendingLink(newConfig.workingDir);

          const result = reconnectSessionTerminal(sessionId, newTerminalId);
          if ('error' in result) {
            log.warn('server', `Respawn reconnect failed for ${sessionId.slice(0, 8)}: ${result.error}`);
            continue;
          }

          // Build resume command preserving original flags (same logic as /sessions/:id/resume)
          // Terminal IDs (term-xxx) are agent-manager internal IDs, not Claude conversation IDs.
          // claude --resume only works with real Claude session IDs, so fall back to --continue.
          const originalCmd = session.startupCommand || session.sshCommand || session.sshConfig?.command || '';
          const isClaude = !originalCmd || /(?:^|\/)claude(?:\s|$)/.test(originalCmd);
          const isClaudeSessionId = !sessionId.startsWith('term-');
          const safeId = sessionId.replace(/'/g, "'\\''");
          let resumeCmd: string;
          if (isClaude) {
            let baseCmd = (originalCmd || 'claude')
              .replace(/^(\S*\/)claude/, 'claude')
              .replace(/\s+--(?:resume\s+'[^']*'|resume\s+\S+|continue)\b/g, '').trim();
            // Reconstruct permission flags from permissionMode if not already in command
            baseCmd = reconstructPermissionFlags(baseCmd, session.permissionMode);
            resumeCmd = isClaudeSessionId
              ? `${baseCmd} --resume '${safeId}' || ${baseCmd} --continue`
              : `${baseCmd} --continue`;
          } else {
            resumeCmd = originalCmd;
          }
          let prefix = '';
          if (isRemote) {
            prefix += `export AGENT_MANAGER_TERMINAL_ID='${newTerminalId}' && `;
            if (cfg.workingDir) prefix += `cd '${cfg.workingDir}' && `;
          }
          writeWhenReady(newTerminalId, `${prefix}${resumeCmd}\r`);

          broadcast({ type: WS_TYPES.SESSION_UPDATE, session: result.session });
          log.info('server', `Respawned terminal for session ${sessionId.slice(0, 8)} → ${newTerminalId.slice(0, 12)}`);
          succeeded = true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('server', `Failed to respawn terminal for session ${sessionId.slice(0, 8)} (attempt ${attempt + 1}): ${msg}`);
        }
      }

      if (!succeeded) {
        log.error('server', `All ${MAX_RETRIES} respawn attempts failed for session ${sessionId.slice(0, 8)} — session left in idle state`);
      }
    }
  }

  function onReady(): void {
    const localIP = getLocalIP();
    log.info('server', 'AI Agent Session Center');
    log.info('server', `Local:   http://localhost:${PORT}`);
    if (localIP) {
      log.info('server', `Network: http://${localIP}:${PORT}`);
    }
    if (isPasswordEnabled()) {
      log.info('server', 'Password protection ENABLED -- login required (1h token TTL)');
    } else {
      // Bound to all interfaces with no password: remote clients are now
      // REFUSED rather than served (authMiddleware + the WS gate), so this is
      // an informational notice, not the former "DANGEROUS / anyone has full
      // access" alarm — which stopped being true once the gate landed and
      // would now train the reader to ignore a real warning.
      const bindAddr = (server.address() as { address?: string } | null)?.address;
      if (bindAddr === '0.0.0.0' || bindAddr === '::') {
        log.info('server', '------------------------------------------------------------');
        log.info('server', 'No password set -- remote devices are BLOCKED (403 / ws 4003).');
        log.info('server', 'This machine (localhost) has full access as usual.');
        log.info('server', 'To use the dashboard from a phone, run `npm run set-password`.');
        log.info('server', '------------------------------------------------------------');
      }
    }
    if (log.isDebug) {
      log.info('server', 'Debug mode ENABLED -- verbose logging active');
    }

    // Auto-install hooks (copy script + register in settings.json)
    ensureHooksInstalled(config);

    // Heal stale "live" rows from a previous run (frozen status + runaway
    // duration in History). Must run before loadSnapshot so any session that
    // actually resumes this run re-persists with its real live status.
    const healed = markStaleSessionsEnded();
    if (healed > 0) log.info('db', `Marked ${healed} stale session(s) as ended on startup`);

    // Restore sessions from snapshot (before starting MQ reader)
    const snapshotResult = loadSnapshot();

    // Start file-based message queue reader (resume from snapshot offset if available)
    startMqReader(snapshotResult ? { resumeOffset: snapshotResult.mqOffset } : undefined);

    // Start periodic snapshot saving (every 10s)
    startPeriodicSave(getMqOffset);

    // Keep each CLI's plan limits (the usage chip in the session header) current
    startPlanUsage();

    // Start auth token cleanup (every hour)
    startTokenCleanup();

    // Sweep note uploads no note references (every hour). Editing a note can
    // orphan its media instantly, so this is what bounds note-media/ growth.
    startNoteMediaSweeper();

    // Auto-respawn SSH terminals for sessions that survived restart.
    //
    // DISABLED BY DEFAULT. The dashboard's RestorePicker (client-side
    // useWorkspaceAutoLoad → importSnapshot) is the authoritative restore
    // path: it always issues POST /api/sessions/clear-all *first*, which
    // SIGHUP-kills whatever this respawn launched. So in the normal
    // Electron/browser flow a server-side respawn here is pure waste, and it
    // actively causes the bugs the restart audit found — every session is
    // resumed twice, the picker's "Resume nothing" can't be honored, the
    // retry loop leaks orphan PTYs and steals pending workDir links during the
    // concurrent client import, and ephemeral fork popups get `--continue`'d
    // into hijacking their origin's conversation.
    //
    // Headless deployments (a standalone server that no dashboard client will
    // ever connect to) can opt back in with AASC_SERVER_AUTORESPAWN=1.
    if (snapshotResult) {
      if (process.env.AASC_SERVER_AUTORESPAWN === '1') {
        setTimeout(() => respawnSshTerminals(), 500);
      } else {
        log.info('server', 'Previous SSH session(s) loaded idle — resume them from the dashboard (set AASC_SERVER_AUTORESPAWN=1 to auto-resume headlessly)');
      }
    }

    // Open browser after a brief delay (let server fully initialize)
    setTimeout(() => openBrowser(`http://localhost:${PORT}`, noOpen), 300);
  }

  // Graceful shutdown — save state, close resources, then exit.
  // Returns a promise so Electron can await full cleanup before quitting.
  let shutdownComplete = false;
  function gracefulShutdown(signal: string): Promise<void> {
    if (shutdownComplete) return Promise.resolve();
    shutdownComplete = true;
    log.info('server', `Received ${signal}, shutting down...`);
    stopPeriodicSave();
    stopPlanUsage();
    stopHeartbeat();
    stopMqReader();
    stopTokenCleanup();
    // Save final snapshot before exiting
    try { saveSnapshot(getMqOffset()); } catch { /* best effort */ }
    try { closeDb(); } catch { /* best effort */ }
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Force resolve after 2s if server.close() hangs (open connections)
      setTimeout(() => resolve(), 2000);
    });
  }

  // Expose shutdown for Electron to call directly (avoids SIGTERM race)
  _shutdownFn = () => gracefulShutdown('electron-quit');

  process.on('SIGTERM', () => { gracefulShutdown('SIGTERM').then(() => process.exit(0)); });
  process.on('SIGINT', () => { gracefulShutdown('SIGINT').then(() => process.exit(0)); });

  // Global error handlers -- log and continue (don't crash on transient errors)
  process.on('uncaughtException', (err: Error) => {
    log.error('server', `Uncaught exception: ${err.message}`);
    log.error('server', err.stack || '');
    // Exit on truly fatal errors (e.g., out of memory)
    if (err.message?.includes('out of memory') || err.message?.includes('ENOMEM')) {
      process.exit(1);
    }
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log.error('server', `Unhandled rejection: ${msg}`);
    if (reason instanceof Error && reason.stack) {
      log.error('server', reason.stack);
    }
  });

  return new Promise<number>((resolve, reject) => {
    let retried = false;
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && !retried) {
        retried = true;
        log.info('server', `Port ${PORT} in use -- killing existing process...`);
        killPortProcess(PORT);
        setTimeout(() => server.listen(PORT, () => {
          onReady();
          resolve(PORT);
        }), 1000);
      } else {
        reject(err);
      }
    });

    server.listen(PORT, () => {
      onReady();
      resolve(PORT);
    });
  });
}

// Auto-start when run directly (not imported by Electron)
if (process.env.ELECTRON !== '1') {
  startServer().catch(console.error);
}

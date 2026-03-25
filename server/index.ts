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
import { getAllSessions, loadSnapshot, saveSnapshot, startPeriodicSave, stopPeriodicSave, getSessionsForRespawn, reconnectSessionTerminal } from './sessionStore.js';
import { createTerminal, consumePendingLink, writeWhenReady } from './sshManager.js';
import { WS_TYPES } from './constants.js';
import { closeDb } from './db.js';
import apiRouter, { hookRateLimitMiddleware } from './apiRouter.js';
import { startMqReader, stopMqReader, getMqOffset } from './mqReader.js';
import log from './logger.js';
import { config } from './serverConfig.js';
import { ensureHooksInstalled } from './hookInstaller.js';
import { resolvePort, killPortProcess } from './portManager.js';
import { networkInterfaces } from 'os';
import {
  isPasswordEnabled, verifyPassword, createToken, validateToken,
  removeToken, parseCookieToken, extractToken, authMiddleware,
  startTokenCleanup, stopTokenCleanup, checkLoginRateLimit,
  recordLoginAttempt, clearLoginAttempts, refreshToken, getTokenTTL,
  localhostOnlyMiddleware, TOKEN_TTL_SECONDS,
} from './authManager.js';

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

function getLocalIP(): string | null {
  const nets = networkInterfaces();
  // Prefer en0 (Wi-Fi on macOS) for the most useful LAN address
  const preferred = ['en0', 'en1', 'eth0', 'wlan0'];
  for (const name of preferred) {
    if (nets[name]) {
      for (const cfg of nets[name]!) {
        if (cfg.family === 'IPv4' && !cfg.internal) return cfg.address;
      }
    }
  }
  // Fallback to first non-internal IPv4
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) return cfg.address;
    }
  }
  return null;
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
    // CSP: restrict connect-src to self (covers ws:/wss: same-origin)
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: blob:; font-src 'self' data: https://cdn.jsdelivr.net; worker-src 'self' blob:; frame-src 'self' blob:",
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

    if (isPasswordEnabled()) {
      // Prefer cookie-based auth (avoids token in URL query string)
      const token = parseCookieToken(req.headers.cookie) ?? extractToken(req);
      if (!validateToken(token)) {
        log.debug('auth', 'Rejected unauthorized WebSocket connection');
        ws.close(4001, 'Unauthorized');
        return;
      }
    }
    handleConnection(ws);
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
            // Reconstruct --dangerously-skip-permissions if permissionMode indicates it
            if (session.permissionMode
                && !baseCmd.includes('--dangerously-skip-permissions')
                && /bypass|dangerously|skip/i.test(session.permissionMode)) {
              baseCmd += ' --dangerously-skip-permissions';
            }
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
      // Warn/block if binding to all interfaces without password
      const bindAddr = (server.address() as { address?: string } | null)?.address;
      if (bindAddr === '0.0.0.0' || bindAddr === '::') {
        log.error('server', '------------------------------------------------------------');
        log.error('server', 'SECURITY: Server is publicly accessible WITHOUT a password!');
        log.error('server', 'This is DANGEROUS. Anyone on the network has full access.');
        log.error('server', 'Run `npm run setup` to set a password.');
        log.error('server', '------------------------------------------------------------');
      }
    }
    if (log.isDebug) {
      log.info('server', 'Debug mode ENABLED -- verbose logging active');
    }

    // Auto-install hooks (copy script + register in settings.json)
    ensureHooksInstalled(config);

    // Restore sessions from snapshot (before starting MQ reader)
    const snapshotResult = loadSnapshot();

    // Start file-based message queue reader (resume from snapshot offset if available)
    startMqReader(snapshotResult ? { resumeOffset: snapshotResult.mqOffset } : undefined);

    // Start periodic snapshot saving (every 10s)
    startPeriodicSave(getMqOffset);

    // Start auth token cleanup (every hour)
    startTokenCleanup();

    // Auto-respawn SSH terminals for sessions that survived restart
    if (snapshotResult) {
      setTimeout(() => respawnSshTerminals(), 500);
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

// index.ts — Express + WS server entry point (thin orchestrator)
// Quick start: npm start -> auto-installs hooks, starts server, opens browser
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import hookRouter from './hookRouter.js';
import { handleConnection, stopHeartbeat } from './wsManager.js';
import { getAllSessions, loadSnapshot, saveSnapshot, startPeriodicSave, stopPeriodicSave } from './sessionStore.js';
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
const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '10mb' }));

// -- Security headers --
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // CSP: allow self + inline styles (needed for xterm/three.js) + WebSocket
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: https://cdn.jsdelivr.net; img-src 'self' data: blob:; font-src 'self' data: https://cdn.jsdelivr.net; worker-src 'self' blob:",
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
    res.status(401).json({ error: 'Wrong password' });
    return;
  }

  clearLoginAttempts(ip);
  const token = createToken();
  res.setHeader('Set-Cookie', `auth_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_TTL_SECONDS}`);
  res.json({ success: true, token, expiresIn: TOKEN_TTL_SECONDS });
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
  res.setHeader('Set-Cookie', `auth_token=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_TTL_SECONDS}`);
  res.json({ success: true, token: newToken, expiresIn: TOKEN_TTL_SECONDS });
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

// -- SPA fallback: serve index.html for all non-API routes (React Router) --
app.get('/{*splat}', (_req, res) => {
  res.sendFile(join(clientDir, 'index.html'));
});

// -- WebSocket with auth validation --
wss.on('connection', (ws, req) => {
  if (isPasswordEnabled()) {
    const token = extractToken(req);
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

const PORT = resolvePort(args, config);

// Auto-open browser
function openBrowser(url: string): void {
  if (noOpen) return;
  try {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    execSync(`${cmd} "${url}"`, { stdio: 'ignore', timeout: 5000 });
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
    // Warn if binding to all interfaces without password
    const bindAddr = (server.address() as { address?: string } | null)?.address;
    if (bindAddr === '0.0.0.0' || bindAddr === '::') {
      log.warn('server', '⚠ WARNING: Server is publicly accessible WITHOUT a password!');
      log.warn('server', '  Run `npm run setup` to set a password before exposing to the internet.');
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

  // Open browser after a brief delay (let server fully initialize)
  setTimeout(() => openBrowser(`http://localhost:${PORT}`), 300);
}

let retried = false;
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && !retried) {
    retried = true;
    log.info('server', `Port ${PORT} in use -- killing existing process...`);
    killPortProcess(PORT);
    setTimeout(() => server.listen(PORT, onReady), 1000);
  } else {
    throw err;
  }
});

server.listen(PORT, onReady);

// Graceful shutdown — save state and exit immediately
function gracefulShutdown(signal: string): void {
  log.info('server', `Received ${signal}, shutting down...`);
  stopPeriodicSave();
  stopHeartbeat();
  stopMqReader();
  stopTokenCleanup();
  // Save final snapshot before exiting
  try { saveSnapshot(getMqOffset()); } catch { /* best effort */ }
  try { closeDb(); } catch { /* best effort */ }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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

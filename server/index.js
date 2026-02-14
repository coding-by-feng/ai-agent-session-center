// index.js — Express + WS server entry point (thin orchestrator)
// Quick start: npm start → auto-installs hooks, starts server, opens browser
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import hookRouter from './hookRouter.js';
import { handleConnection, stopHeartbeat } from './wsManager.js';
import { getAllSessions, loadSnapshot, saveSnapshot, startPeriodicSave, stopPeriodicSave } from './sessionStore.js';
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
  startTokenCleanup, stopTokenCleanup,
} from './authManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '10mb' }));

// ── Auth endpoints (no auth required) ──
app.get('/api/auth/status', (req, res) => {
  const passwordRequired = isPasswordEnabled();
  const token = parseCookieToken(req.headers.cookie);
  const authenticated = passwordRequired ? validateToken(token) : true;
  res.json({ passwordRequired, authenticated });
});

app.post('/api/auth/login', (req, res) => {
  if (!isPasswordEnabled()) {
    return res.json({ success: true });
  }
  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password is required' });
  }
  if (!verifyPassword(password, config.passwordHash)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = createToken();
  res.setHeader('Set-Cookie', `auth_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${24 * 60 * 60}`);
  res.json({ success: true, token });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookieToken(req.headers.cookie);
  removeToken(token);
  res.setHeader('Set-Cookie', 'auth_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ success: true });
});

// ── Static files (always served — login page is part of SPA) ──
app.use(express.static(join(__dirname, '..', 'public')));

// ── Hook endpoints (no auth — CLI hooks must work without login) ──
app.use('/api/hooks', hookRateLimitMiddleware, hookRouter);

// ── Protected API routes ──
app.use('/api', authMiddleware, apiRouter);
app.get('/api/sessions', authMiddleware, (req, res) => {
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

// ── WebSocket with auth validation ──
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

function getLocalIP() {
  const nets = networkInterfaces();
  // Prefer en0 (Wi-Fi on macOS) for the most useful LAN address
  const preferred = ['en0', 'en1', 'eth0', 'wlan0'];
  for (const name of preferred) {
    if (nets[name]) {
      for (const cfg of nets[name]) {
        if (cfg.family === 'IPv4' && !cfg.internal) return cfg.address;
      }
    }
  }
  // Fallback to first non-internal IPv4
  for (const iface of Object.values(nets)) {
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) return cfg.address;
    }
  }
  return null;
}

function onReady() {
  const localIP = getLocalIP();
  log.info('server', `AI Agent Session Center`);
  log.info('server', `Local:   http://localhost:${PORT}`);
  if (localIP) {
    log.info('server', `Network: http://${localIP}:${PORT}`);
  }
  if (isPasswordEnabled()) {
    log.info('server', 'Password protection ENABLED — login required');
  }
  if (log.isDebug) {
    log.info('server', 'Debug mode ENABLED — verbose logging active');
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
  stopPeriodicSave();
  stopHeartbeat();
  stopMqReader();
  stopTokenCleanup();
  // Save final snapshot before exiting
  saveSnapshot(getMqOffset());
  server.close(() => {
    log.info('server', 'Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Global error handlers — log and continue (don't crash on transient errors)
process.on('uncaughtException', (err) => {
  log.error('server', `Uncaught exception: ${err.message}`);
  log.error('server', err.stack || '');
  // Exit on truly fatal errors (e.g., out of memory)
  if (err.message?.includes('out of memory') || err.message?.includes('ENOMEM')) {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log.error('server', `Unhandled rejection: ${msg}`);
  if (reason instanceof Error && reason.stack) {
    log.error('server', reason.stack);
  }
});

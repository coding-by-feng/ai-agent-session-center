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
import { getAllSessions } from './sessionStore.js';
import apiRouter, { hookRateLimitMiddleware } from './apiRouter.js';
import { startMqReader, stopMqReader } from './mqReader.js';
import log from './logger.js';
import { config } from './serverConfig.js';
import { ensureHooksInstalled } from './hookInstaller.js';
import { resolvePort, killPortProcess } from './portManager.js';
import { networkInterfaces } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, '..', 'public')));
app.use('/api', apiRouter);
app.use('/api/hooks', hookRateLimitMiddleware, hookRouter);
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
  if (log.isDebug) {
    log.info('server', 'Debug mode ENABLED — verbose logging active');
  }

  // Auto-install hooks (copy script + register in settings.json)
  ensureHooksInstalled(config);

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
  stopHeartbeat();
  stopMqReader();
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

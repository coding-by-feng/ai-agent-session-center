// index.js — Express + WS server, port 3333
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import hookRouter from './hookRouter.js';
import { handleConnection, broadcast } from './wsManager.js';
import { getAllSessions } from './sessionStore.js';
import apiRouter from './apiRouter.js';
import { startMqReader, stopMqReader } from './mqReader.js';
import log from './logger.js';
import { config } from './serverConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

const PORT = config.port || 3333;

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

function onReady() {
  log.info('server', `Claude Session Center`);
  log.info('server', `Dashboard: http://localhost:${PORT}`);
  if (log.isDebug) {
    log.info('server', 'Debug mode ENABLED — verbose logging active');
  }

  // Start file-based message queue reader
  startMqReader();
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

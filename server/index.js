// index.js — Express + WS server, port 3333
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import hookRouter from './hookRouter.js';
import { handleConnection, broadcast } from './wsManager.js';
import { getAllSessions } from './sessionStore.js';
import db from './db.js';
import apiRouter from './apiRouter.js';
import { startImport } from './importer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));
app.use('/api', apiRouter);
app.use('/api/hooks', hookRouter);
app.get('/api/sessions', (req, res) => res.json(getAllSessions()));

wss.on('connection', handleConnection);

const PORT = 3333;
server.listen(PORT, () => {
  console.log(`\n  Claude Session Command Center`);
  console.log(`  Dashboard: http://localhost:${PORT}\n`);

  // Start background JSONL import
  startImport().catch(err => {
    console.error('Import error:', err.message);
  });

  // Duration alert checking — every 10 seconds
  setInterval(() => {
    try {
      const alerts = db.prepare(
        'SELECT * FROM duration_alerts WHERE enabled = 1 AND triggered_at IS NULL'
      ).all();
      const currentSessions = getAllSessions();
      for (const alert of alerts) {
        const session = currentSessions[alert.session_id];
        if (!session) continue;
        const elapsed = Date.now() - session.startedAt;
        if (elapsed >= alert.threshold_ms) {
          db.prepare('UPDATE duration_alerts SET triggered_at = ? WHERE id = ?').run(Date.now(), alert.id);
          broadcast({
            type: 'duration_alert',
            sessionId: alert.session_id,
            projectName: session.projectName,
            thresholdMs: alert.threshold_ms,
            elapsedMs: elapsed
          });
        }
      }
    } catch(e) {
      console.error('[alerts] Error checking duration alerts:', e.message);
    }
  }, 10000);
});

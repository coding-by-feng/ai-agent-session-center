// apiRouter.js — Express router for all API endpoints
import { Router } from 'express';
import { searchSessions, getSessionDetail, getDistinctProjects, getTimeline, fullTextSearch } from './queryEngine.js';
import { getToolUsageBreakdown, getDurationTrends, getActiveProjects, getDailyHeatmap, getSummaryStats } from './analytics.js';
import { startImport, getImportStatus } from './importer.js';
import { findClaudeProcess, killSession, archiveSession, setSessionTitle } from './sessionStore.js';
import db from './db.js';

const router = Router();

// Session endpoints
router.get('/sessions/history', (req, res) => {
  const result = searchSessions(req.query);
  res.json(result);
});

router.get('/sessions/:id/detail', (req, res) => {
  const result = getSessionDetail(req.params.id);
  res.json(result);
});

// Full-text search
router.get('/search', (req, res) => {
  const result = fullTextSearch({
    query: req.query.q,
    type: req.query.type,
    page: req.query.page,
    pageSize: req.query.pageSize
  });
  res.json(result);
});

// Analytics endpoints
router.get('/analytics/summary', (req, res) => {
  const { dateFrom, dateTo } = req.query;
  const result = getSummaryStats({ dateFrom, dateTo });
  res.json(result);
});

router.get('/analytics/tools', (req, res) => {
  const result = getToolUsageBreakdown(req.query);
  res.json(result);
});

router.get('/analytics/duration-trends', (req, res) => {
  const result = getDurationTrends(req.query);
  res.json(result);
});

router.get('/analytics/projects', (req, res) => {
  const result = getActiveProjects(req.query);
  res.json(result);
});

router.get('/analytics/heatmap', (req, res) => {
  const result = getDailyHeatmap(req.query);
  res.json(result);
});

// Timeline
router.get('/timeline', (req, res) => {
  const result = getTimeline(req.query);
  res.json(result);
});

// Projects
router.get('/projects', (req, res) => {
  const projects = getDistinctProjects();
  res.json({ projects });
});

// Import endpoints
router.post('/import/trigger', (req, res) => {
  startImport();
  res.json({ status: 'started' });
});

router.get('/import/status', (req, res) => {
  const result = getImportStatus();
  res.json(result);
});

// ---- Settings Endpoints ----

router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM user_settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  res.json({ settings });
});

router.put('/settings', (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key is required' });
  db.prepare('INSERT OR REPLACE INTO user_settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, String(value), Date.now());
  res.json({ ok: true });
});

router.put('/settings/bulk', (req, res) => {
  const { settings } = req.body;
  if (!settings) return res.status(400).json({ error: 'settings object is required' });
  const stmt = db.prepare('INSERT OR REPLACE INTO user_settings (key, value, updated_at) VALUES (?, ?, ?)');
  const now = Date.now();
  for (const [key, value] of Object.entries(settings)) {
    stmt.run(key, String(value), now);
  }
  res.json({ ok: true });
});

// ---- Session Control Endpoints ----

// Kill session process
router.post('/sessions/:id/kill', (req, res) => {
  if (!req.body.confirm) {
    return res.status(400).json({ error: 'Must send {confirm: true} to kill a session' });
  }
  const sessionId = req.params.id;
  const pid = findClaudeProcess(sessionId);
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      return res.status(500).json({ error: `Failed to kill PID ${pid}: ${e.message}` });
    }
  }
  const session = killSession(sessionId);
  archiveSession(sessionId, true);
  if (!session && !pid) {
    return res.status(404).json({ error: 'Session not found and no matching process' });
  }
  res.json({ ok: true, pid: pid || null });
});

// Archive/unarchive session
router.post('/sessions/:id/archive', (req, res) => {
  const archived = req.body.archived !== undefined ? req.body.archived : true;
  const session = archiveSession(req.params.id, archived);
  res.json({ ok: true, archived: archived ? 1 : 0 });
});

// Update session title
router.put('/sessions/:id/title', (req, res) => {
  const { title } = req.body;
  if (title === undefined) return res.status(400).json({ error: 'title is required' });
  setSessionTitle(req.params.id, title);
  res.json({ ok: true });
});

// Export session as JSON download
router.get('/sessions/:id/export', (req, res) => {
  const data = getSessionDetail(req.params.id);
  if (!data) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="session-${req.params.id}.json"`);
  res.json(data);
});

// Notes - list
router.get('/sessions/:id/notes', (req, res) => {
  const notes = db.prepare('SELECT * FROM session_notes WHERE session_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ notes });
});

// Notes - create
router.post('/sessions/:id/notes', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Note text is required' });
  }
  const now = Date.now();
  const result = db.prepare('INSERT INTO session_notes (session_id, text, created_at, updated_at) VALUES (?, ?, ?, ?)').run(req.params.id, text.trim(), now, now);
  res.json({ ok: true, note: { id: result.lastInsertRowid, session_id: req.params.id, text: text.trim(), created_at: now } });
});

// Notes - delete
router.delete('/sessions/:id/notes/:noteId', (req, res) => {
  db.prepare('DELETE FROM session_notes WHERE id = ? AND session_id = ?').run(req.params.noteId, req.params.id);
  res.json({ ok: true });
});

// Alerts - list
router.get('/sessions/:id/alerts', (req, res) => {
  const alerts = db.prepare('SELECT * FROM duration_alerts WHERE session_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ alerts });
});

// Alerts - create
router.post('/sessions/:id/alerts', (req, res) => {
  const { threshold_ms } = req.body;
  if (!threshold_ms || threshold_ms < 1) {
    return res.status(400).json({ error: 'threshold_ms must be a positive number' });
  }
  const now = Date.now();
  const result = db.prepare('INSERT INTO duration_alerts (session_id, threshold_ms, enabled, created_at) VALUES (?, ?, 1, ?)').run(req.params.id, threshold_ms, now);
  res.json({ ok: true, alert: { id: result.lastInsertRowid, session_id: req.params.id, threshold_ms, enabled: 1, created_at: now } });
});

// Alerts - delete
router.delete('/sessions/:id/alerts/:alertId', (req, res) => {
  db.prepare('DELETE FROM duration_alerts WHERE id = ? AND session_id = ?').run(req.params.alertId, req.params.id);
  res.json({ ok: true });
});

export default router;

// apiRouter.js — Express router for all API endpoints
import { Router } from 'express';
import { searchSessions, getSessionDetail, getDistinctProjects, getTimeline, fullTextSearch } from './queryEngine.js';
import { getToolUsageBreakdown, getDurationTrends, getActiveProjects, getDailyHeatmap, getSummaryStats } from './analytics.js';
import { startImport, getImportStatus } from './importer.js';
import { findClaudeProcess, killSession, archiveSession, setSessionTitle, setSummary, getSession, detectSessionSource, setSessionCharacterModel, setSessionAccentColor } from './sessionStore.js';
import { execFile, execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
  const mem = getSession(sessionId);
  const pid = findClaudeProcess(sessionId, mem?.projectPath);
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

// Detect session source (vscode / terminal)
router.get('/sessions/:id/source', (req, res) => {
  const source = detectSessionSource(req.params.id);
  res.json({ source });
});

// Send prompt to running Claude session by typing into its terminal
router.post('/sessions/:id/prompt', async (req, res) => {
  const sessionId = req.params.id;
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // Get the session's project path for process matching
  const memSession = getSession(sessionId);
  const dbRow = !memSession ? db.prepare('SELECT project_path FROM sessions WHERE id = ?').get(sessionId) : null;
  const projectPath = memSession?.projectPath || dbRow?.project_path;

  // Find the running Claude process for this session (matches by cwd)
  const pid = findClaudeProcess(sessionId, projectPath);
  if (!pid) {
    return res.status(404).json({ error: 'No running Claude process found for this session', fallback: 'clipboard' });
  }

  const promptText = prompt.trim();
  const tmpFile = join(tmpdir(), `claude-prompt-${Date.now()}.txt`);
  try {
    writeFileSync(tmpFile, promptText, 'utf-8');
  } catch(e) {
    return res.status(500).json({ error: 'Failed to create temp file' });
  }

  try {
    const platform = process.platform;

    if (platform === 'darwin') {
      // ---- macOS ----
      const tty = getProcessTty(pid);

      // Strategy 1: iTerm2 (best — uses write text, no focus needed)
      if (tty) {
        const ttyPath = tty.startsWith('/dev/') ? tty : `/dev/tty${tty}`;
        try {
          const result = await runShellScript('osascript', ['-e', [
            `set promptText to read POSIX file "${tmpFile}"`,
            'tell application "iTerm2"',
            '  repeat with w in windows',
            '    repeat with t in tabs of w',
            '      repeat with s in sessions of t',
            `        if tty of s is "${ttyPath}" then`,
            '          tell s to write text promptText',
            '          return "ok"',
            '        end if',
            '      end repeat',
            '    end repeat',
            '  end repeat',
            'end tell',
            'return "not_found"'
          ].join('\n')]);
          if (result.trim() === 'ok') {
            return res.json({ ok: true, method: 'iterm2' });
          }
        } catch(e) { /* iTerm2 not available */ }

        // Strategy 2: Terminal.app (paste via clipboard)
        try {
          const result = await runShellScript('osascript', ['-e', [
            `set promptText to read POSIX file "${tmpFile}"`,
            'tell application "Terminal"',
            '  repeat with w in windows',
            '    repeat with t in tabs of w',
            `      if tty of t is "${ttyPath}" then`,
            '        set frontmost of w to true',
            '        set selected tab of w to t',
            '        activate',
            '        delay 0.3',
            '        set savedClip to ""',
            '        try',
            '          set savedClip to the clipboard as text',
            '        end try',
            '        set the clipboard to promptText',
            '        tell application "System Events"',
            '          tell process "Terminal"',
            '            keystroke "v" using command down',
            '            delay 0.1',
            '            keystroke return',
            '          end tell',
            '        end tell',
            '        delay 0.3',
            '        set the clipboard to savedClip',
            '        return "ok"',
            '      end if',
            '    end repeat',
            '  end repeat',
            'end tell',
            'return "not_found"'
          ].join('\n')]);
          if (result.trim() === 'ok') {
            return res.json({ ok: true, method: 'terminal' });
          }
        } catch(e) { /* Terminal.app not available */ }
      }

      // Strategy 3: VS Code session (no TTY) — activate VS Code, paste into Claude chat
      if (!tty || isVSCodeProcess(pid)) {
        try {
          await runShellScript('osascript', ['-e', [
            `set promptText to read POSIX file "${tmpFile}"`,
            'set savedClip to ""',
            'try',
            '  set savedClip to the clipboard as text',
            'end try',
            'set the clipboard to promptText',
            'tell application "Visual Studio Code"',
            '  activate',
            'end tell',
            'delay 0.5',
            // After activate, VS Code is the frontmost process — use that
            'tell application "System Events"',
            '  tell (first process whose frontmost is true)',
            '    keystroke "v" using command down',
            '    delay 0.2',
            '    keystroke return',
            '  end tell',
            'end tell',
            'delay 0.3',
            'set the clipboard to savedClip',
          ].join('\n')]);
          return res.json({ ok: true, method: 'vscode' });
        } catch(e) {
          console.error('[apiRouter] VS Code AppleScript error:', e.message);
        }
      }

      return res.status(404).json({
        error: 'Could not find terminal or VS Code session.',
        fallback: 'clipboard'
      });

    } else if (platform === 'linux') {
      // ---- Linux: xdotool (X11) or wtype (Wayland) ----
      // Try xdotool first (X11)
      try {
        // Find window by PID
        const wid = await runShellScript('xdotool', ['search', '--pid', String(pid)]);
        const windowId = wid.trim().split('\n')[0];
        if (windowId) {
          await runShellScript('xdotool', ['windowactivate', '--sync', windowId]);
          await runShellScript('xdotool', ['type', '--delay', '5', '--clearmodifiers', '--file', tmpFile]);
          await runShellScript('xdotool', ['key', 'Return']);
          return res.json({ ok: true, method: 'xdotool' });
        }
      } catch(e) { /* xdotool not available */ }

      // Try xclip to set clipboard + xdotool paste
      try {
        await runShellScript('bash', ['-c', `xclip -selection clipboard < "${tmpFile}"`]);
        const wid = await runShellScript('xdotool', ['search', '--pid', String(pid)]);
        const windowId = wid.trim().split('\n')[0];
        if (windowId) {
          await runShellScript('xdotool', ['windowactivate', '--sync', windowId]);
          await runShellScript('xdotool', ['key', 'ctrl+shift+v']);
          await runShellScript('xdotool', ['key', 'Return']);
          return res.json({ ok: true, method: 'xdotool-paste' });
        }
      } catch(e) { /* fallthrough */ }

      return res.status(404).json({
        error: 'Could not send prompt. Install xdotool: sudo apt install xdotool',
        fallback: 'clipboard'
      });

    } else if (platform === 'win32') {
      // ---- Windows: PowerShell SendKeys ----
      try {
        const psScript = `
          Add-Type -AssemblyName Microsoft.VisualBasic
          Add-Type -AssemblyName System.Windows.Forms
          $promptText = [IO.File]::ReadAllText('${tmpFile.replace(/\\/g, '\\\\')}')
          $proc = Get-Process -Id ${pid} -ErrorAction Stop
          if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
            [Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id)
            Start-Sleep -Milliseconds 300
            [System.Windows.Forms.SendKeys]::SendWait($promptText)
            Start-Sleep -Milliseconds 100
            [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
            Write-Output "ok"
          } else {
            Write-Output "no_window"
          }
        `;
        const result = await runShellScript('powershell', ['-NoProfile', '-Command', psScript]);
        if (result.trim() === 'ok') {
          return res.json({ ok: true, method: 'powershell' });
        }
      } catch(e) { /* PowerShell not available or failed */ }

      // Try Windows Terminal via clipboard
      try {
        const psClip = `
          $promptText = [IO.File]::ReadAllText('${tmpFile.replace(/\\/g, '\\\\')}')
          Set-Clipboard -Value $promptText
          $proc = Get-Process -Id ${pid} -ErrorAction Stop
          [Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id)
          Start-Sleep -Milliseconds 300
          Add-Type -AssemblyName System.Windows.Forms
          [System.Windows.Forms.SendKeys]::SendWait('^v')
          Start-Sleep -Milliseconds 100
          [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
          Write-Output "ok"
        `;
        const result = await runShellScript('powershell', ['-NoProfile', '-Command', psClip]);
        if (result.trim() === 'ok') {
          return res.json({ ok: true, method: 'powershell-paste' });
        }
      } catch(e) { /* fallthrough */ }

      return res.status(404).json({
        error: 'Could not find terminal window for this session.',
        fallback: 'clipboard'
      });

    } else {
      return res.status(400).json({
        error: `Unsupported platform: ${platform}`,
        fallback: 'clipboard'
      });
    }
  } finally {
    try { unlinkSync(tmpFile); } catch(e) {}
  }
});

// Helper: check if a PID is a VS Code-spawned Claude process
function isVSCodeProcess(pid) {
  try {
    const cmd = execSync(`ps -o args= -p ${pid}`, { encoding: 'utf-8', timeout: 3000 }).trim();
    return cmd.includes('.vscode') || cmd.includes('stream-json') || cmd.includes('--no-chrome');
  } catch(e) { return false; }
}

// Helper: get TTY for a process (Unix only)
function getProcessTty(pid) {
  try {
    const tty = execSync(`ps -o tty= -p ${pid}`, { encoding: 'utf-8', timeout: 3000 }).trim();
    return (tty && tty !== '??') ? tty : null;
  } catch(e) {
    return null;
  }
}

// Helper: run a shell command and return stdout
function runShellScript(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

// Open session project in VS Code
router.post('/sessions/:id/open-editor', (req, res) => {
  const sessionId = req.params.id;
  let projectPath;
  const memSession = getSession(sessionId);
  if (memSession) {
    projectPath = memSession.projectPath;
  } else {
    const row = db.prepare('SELECT project_path FROM sessions WHERE id = ?').get(sessionId);
    projectPath = row?.project_path;
  }
  if (!projectPath) {
    return res.status(404).json({ error: 'No project path for this session' });
  }
  // Cross-platform: open project in VS Code
  const platform = process.platform;
  let cmd, args;
  if (platform === 'darwin') {
    cmd = 'open'; args = ['-a', 'Visual Studio Code', projectPath];
  } else if (platform === 'win32') {
    cmd = 'cmd'; args = ['/c', 'code', projectPath];
  } else {
    cmd = 'code'; args = [projectPath];
  }
  execFile(cmd, args, { timeout: 5000 }, (err) => {
    if (err) {
      console.error('[apiRouter] open-editor error:', err.message);
      return res.status(500).json({ error: `Failed to open editor: ${err.message}` });
    }
    res.json({ ok: true });
  });
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

// Update session character model
router.put('/sessions/:id/character-model', (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: 'model is required' });
  setSessionCharacterModel(req.params.id, model);
  res.json({ ok: true });
});

// Update session accent color
router.put('/sessions/:id/accent-color', (req, res) => {
  const { color } = req.body;
  if (!color) return res.status(400).json({ error: 'color is required' });
  setSessionAccentColor(req.params.id, color);
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

// Summarize & archive session using Claude CLI
router.post('/sessions/:id/summarize', async (req, res) => {
  const sessionId = req.params.id;
  const data = getSessionDetail(sessionId);
  if (!data) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Build context string from session data
  const { session, prompts, responses, tool_calls } = data;
  const durationMin = session.ended_at
    ? Math.round((session.ended_at - session.started_at) / 60000)
    : Math.round((Date.now() - session.started_at) / 60000);

  let context = `Session: ${session.project_name || 'Unknown'} | Model: ${session.model || 'Unknown'} | Duration: ${durationMin} min\n\n`;
  context += `=== PROMPTS & RESPONSES ===\n`;

  // Interleave prompts, responses, and tool calls chronologically
  const allItems = [
    ...prompts.map(p => ({ type: 'user', text: p.text, ts: p.timestamp })),
    ...responses.map(r => ({ type: 'claude', text: r.text_excerpt || r.full_text || '', ts: r.timestamp })),
    ...tool_calls.map(t => ({ type: 'tool', text: `${t.tool_name}: ${t.tool_input_summary || ''}`, ts: t.timestamp }))
  ].sort((a, b) => a.ts - b.ts);

  for (const item of allItems) {
    if (item.type === 'user') context += `[User] ${item.text}\n`;
    else if (item.type === 'claude') context += `[Claude] ${item.text}\n`;
    else context += `[Tool] ${item.text}\n`;
  }

  // Truncate context to avoid exceeding CLI limits (~100k chars)
  if (context.length > 100000) {
    context = context.substring(0, 100000) + '\n... (truncated)';
  }

  const summaryPrompt = `Summarize this Claude Code session in 3-5 bullet points. Focus on what was accomplished, key decisions, and any issues encountered. Be concise.\n\n${context}`;

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

    // Store summary and archive
    setSummary(sessionId, summary);
    archiveSession(sessionId, true);

    res.json({ ok: true, summary });
  } catch (err) {
    console.error('[apiRouter] Summarize error:', err.message);
    res.status(500).json({ error: `Summarize failed: ${err.message}` });
  }
});

// Get stored summary
router.get('/sessions/:id/summary', (req, res) => {
  const row = db.prepare('SELECT summary FROM sessions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Session not found' });
  res.json({ summary: row.summary || null });
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

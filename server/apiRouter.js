// apiRouter.js — Express router for all API endpoints
import { Router } from 'express';
import { searchSessions, getSessionDetail, getDistinctProjects, getTimeline, fullTextSearch } from './queryEngine.js';
import { getToolUsageBreakdown, getDurationTrends, getActiveProjects, getDailyHeatmap, getSummaryStats } from './analytics.js';
import { startImport, getImportStatus } from './importer.js';
import { findClaudeProcess, killSession, archiveSession, setSessionTitle, setSummary, getSession, detectSessionSource, setSessionCharacterModel, setSessionAccentColor, updateQueueCount, createTerminalSession } from './sessionStore.js';
import { broadcast } from './wsManager.js';
import { createTerminal, closeTerminal, getTerminals, listSshKeys, listTmuxSessions } from './sshManager.js';
import { getStats as getHookStats, resetStats as resetHookStats } from './hookStats.js';
import { getMqStats } from './mqReader.js';
import { execFile, execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import db from './db.js';

const __apiDirname = dirname(fileURLToPath(import.meta.url));

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

// Hook performance stats
router.get('/hook-stats', (req, res) => {
  res.json(getHookStats());
});

router.post('/hook-stats/reset', (req, res) => {
  resetHookStats();
  res.json({ ok: true });
});

// MQ reader stats
router.get('/mq-stats', (req, res) => {
  res.json(getMqStats());
});

// ---- Hook Density Management ----

const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const INSTALL_HOOKS_SCRIPT = join(__apiDirname, '..', 'hooks', 'install-hooks.js');
const HOOK_PATTERN = 'dashboard-hook.';
const ALL_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Stop', 'Notification', 'SubagentStart', 'SubagentStop', 'SessionEnd'
];
const DENSITY_EVENTS = {
  high: ALL_HOOK_EVENTS,
  medium: ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop', 'SessionEnd'],
  low: ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']
};

// Get current hooks status from ~/.claude/settings.json
router.get('/hooks/status', (req, res) => {
  try {
    let claudeSettings = {};
    try {
      claudeSettings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    } catch { /* file doesn't exist yet */ }

    const hooks = claudeSettings.hooks || {};
    const installedEvents = ALL_HOOK_EVENTS.filter(event =>
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Install hooks with specified density
router.post('/hooks/install', (req, res) => {
  const { density } = req.body;
  if (!density || !DENSITY_EVENTS[density]) {
    return res.status(400).json({ error: 'density must be one of: high, medium, low' });
  }

  // Save density preference to dashboard settings
  db.prepare('INSERT OR REPLACE INTO user_settings (key, value, updated_at) VALUES (?, ?, ?)').run('hookDensity', density, Date.now());

  // Run install-hooks.js with --density flag
  execFile('node', [INSTALL_HOOKS_SCRIPT, '--density', density], { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[hooks/install] Error:', err.message);
      return res.status(500).json({ error: err.message, stdout, stderr });
    }
    console.log('[hooks/install]', stdout);
    res.json({ ok: true, density, events: DENSITY_EVENTS[density], output: stdout });
  });
});

// Uninstall all dashboard hooks
router.post('/hooks/uninstall', (req, res) => {
  // Save density as 'off'
  db.prepare('INSERT OR REPLACE INTO user_settings (key, value, updated_at) VALUES (?, ?, ?)').run('hookDensity', 'off', Date.now());

  // Run install-hooks.js with --uninstall flag
  execFile('node', [INSTALL_HOOKS_SCRIPT, '--uninstall'], { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[hooks/uninstall] Error:', err.message);
      return res.status(500).json({ error: err.message, stdout, stderr });
    }
    console.log('[hooks/uninstall]', stdout);
    res.json({ ok: true, output: stdout });
  });
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

// Kill session process — sends SIGTERM, then SIGKILL after 3s if still alive
router.post('/sessions/:id/kill', (req, res) => {
  if (!req.body.confirm) {
    return res.status(400).json({ error: 'Must send {confirm: true} to kill a session' });
  }
  const sessionId = req.params.id;
  const mem = getSession(sessionId);
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
        } catch(e) { /* already dead — good */ }
      }, 3000);
    } catch (e) {
      return res.status(500).json({ error: `Failed to kill PID ${pid}: ${e.message}` });
    }
  }
  const session = killSession(sessionId);
  archiveSession(sessionId, true);
  if (!session && !pid) {
    return res.status(404).json({ error: 'Session not found and no matching process' });
  }
  res.json({ ok: true, pid: pid || null, source });
});

// Detect session source (vscode / terminal)
router.get('/sessions/:id/source', (req, res) => {
  const source = detectSessionSource(req.params.id);
  res.json({ source });
});

// Helper: get TTY for a process (Unix only)
function getProcessTty(pid) {
  try {
    const tty = execSync(`ps -o tty= -p ${pid}`, { encoding: 'utf-8', timeout: 3000 }).trim();
    return (tty && tty !== '??') ? tty : null;
  } catch(e) {
    return null;
  }
}

// Resolve terminal app name from $TERM_PROGRAM env var (no process tree walk needed)
function resolveTermAppFromEnv(termProgram) {
  if (!termProgram) return null;
  const tp = termProgram.toLowerCase();
  if (tp === 'iterm.app' || tp === 'iterm2') return 'iTerm2';
  if (tp === 'apple_terminal') return 'Terminal';
  if (tp === 'ghostty') return 'Ghostty';
  if (tp === 'kitty') return 'Kitty';
  if (tp === 'warpterminal' || tp === 'warp') return 'Warp';
  if (tp === 'alacritty') return 'Alacritty';
  if (tp === 'hyper') return 'Hyper';
  if (tp === 'wezterm') return 'WezTerm';
  if (tp === 'tabby') return 'Tabby';
  if (tp === 'vscode') return 'Visual Studio Code';
  if (tp === 'tmux') return 'tmux';
  return null;
}

// Helper: detect which terminal app owns a process (macOS only) — fallback when TERM_PROGRAM isn't available
function detectTerminalApp(pid) {
  if (process.platform !== 'darwin') return null;
  console.log(`[detectTermApp] walking process tree from pid=${pid}`);
  try {
    let current = pid;
    for (let i = 0; i < 10; i++) {
      const ppid = execSync(`ps -o ppid= -p ${current}`, { encoding: 'utf-8', timeout: 3000 }).trim();
      if (!ppid || ppid === '0' || ppid === '1') {
        console.log(`[detectTermApp] reached root (ppid=${ppid}), no terminal app found`);
        break;
      }
      const cmd = execSync(`ps -o comm= -p ${ppid}`, { encoding: 'utf-8', timeout: 3000 }).trim();
      console.log(`[detectTermApp] ${current} → parent ${ppid} = "${cmd}"`);
      const lower = cmd.toLowerCase();
      const match =
        lower.includes('ghostty') ? 'Ghostty' :
        (lower.includes('iterm2') || lower.includes('iterm')) ? 'iTerm2' :
        (lower.includes('terminal') && !lower.includes('node')) ? 'Terminal' :
        lower.includes('alacritty') ? 'Alacritty' :
        lower.includes('kitty') ? 'Kitty' :
        lower.includes('warp') ? 'Warp' :
        lower.includes('hyper') ? 'Hyper' :
        lower.includes('wezterm') ? 'WezTerm' :
        lower.includes('tabby') ? 'Tabby' :
        (lower.includes('code') || lower.includes('electron')) ? 'Visual Studio Code' :
        lower.includes('idea') ? 'IntelliJ IDEA' :
        lower.includes('webstorm') ? 'WebStorm' :
        lower.includes('pycharm') ? 'PyCharm' :
        lower.includes('goland') ? 'GoLand' :
        lower.includes('clion') ? 'CLion' :
        lower.includes('rider') ? 'Rider' :
        lower.includes('phpstorm') ? 'PhpStorm' :
        lower.includes('rubymine') ? 'RubyMine' :
        lower.includes('datagrip') ? 'DataGrip' :
        lower.includes('fleet') ? 'Fleet' :
        lower.includes('jetbrains') ? 'JetBrains' :
        null;
      if (match) {
        console.log(`[detectTermApp] ✓ FOUND: "${match}" at pid=${ppid}`);
        return match;
      }
      current = ppid;
    }
  } catch(e) {
    console.log(`[detectTermApp] error: ${e.message?.split('\n')[0]}`);
  }
  return null;
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

// Open and FOCUS the exact window/tab where the Claude session is running.
// For terminal sessions: find the TTY, locate the terminal tab, activate it.
// For VS Code sessions: activate the VS Code window whose title contains the project name.
// For JetBrains sessions: activate the IDE window whose title contains the project name.
router.post('/sessions/:id/open-editor', async (req, res) => {
  const sessionId = req.params.id;
  const memSession = getSession(sessionId);
  const dbRow = !memSession ? db.prepare('SELECT project_path, project_name FROM sessions WHERE id = ?').get(sessionId) : null;
  const projectPath = memSession?.projectPath || dbRow?.project_path;
  const projectName = memSession?.projectName || dbRow?.project_name || projectPath?.split('/').pop() || '';

  // Gather cached tab info from session
  const tabInfo = {
    tty: memSession?.ttyPath || null,
    tabId: memSession?.tabId || null,
    termProgram: memSession?.termProgram || null,
    vscodePid: memSession?.vscodePid || null,
    windowId: memSession?.windowId || null,
    tmux: memSession?.tmux || null,
    kittyPid: memSession?.kittyPid || null,
  };

  console.log(`[open-editor] ──────────────────────────────────────`);
  console.log(`[open-editor] sessionId:    ${sessionId}`);
  console.log(`[open-editor] projectName:  ${projectName}`);
  console.log(`[open-editor] projectPath:  ${projectPath}`);
  console.log(`[open-editor] fromMemory:   ${!!memSession}  fromDB: ${!!dbRow}`);
  const tabStr = Object.entries(tabInfo).filter(([,v]) => v).map(([k,v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
  if (tabStr) console.log(`[open-editor] tabInfo:      ${tabStr}`);

  if (!projectPath) {
    console.log(`[open-editor] ABORT: no project path`);
    return res.status(404).json({ error: 'No project path for this session' });
  }

  const source = detectSessionSource(sessionId);
  const pid = findClaudeProcess(sessionId, projectPath);
  const cachedTty = memSession?.ttyPath || null;
  const platform = process.platform;

  console.log(`[open-editor] source:       ${source}`);
  console.log(`[open-editor] pid:          ${pid || 'NOT FOUND'}`);
  console.log(`[open-editor] cachedTty:    ${cachedTty || 'none'}`);
  console.log(`[open-editor] platform:     ${platform}`);

  try {
    let result;
    if (platform === 'darwin') {
      result = await focusSessionMacOS(sessionId, source, pid, projectPath, projectName, tabInfo);
    } else if (platform === 'linux') {
      result = await focusSessionLinux(pid, projectPath, source, projectName);
    } else if (platform === 'win32') {
      result = await focusSessionWindows(pid, projectPath, source, projectName);
    } else {
      return res.status(400).json({ error: `Unsupported platform: ${platform}` });
    }
    console.log(`[open-editor] RESULT:       ${JSON.stringify(result)}`);
    console.log(`[open-editor] ──────────────────────────────────────`);
    return res.json(result);
  } catch (err) {
    console.error(`[open-editor] ERROR:        ${err.message}`);
    console.log(`[open-editor] ──────────────────────────────────────`);
    return res.status(500).json({ error: err.message });
  }
});

// ---- macOS: focus the exact window/tab for a session ----
async function focusSessionMacOS(sessionId, source, pid, projectPath, projectName, tabInfo) {
  // === Terminal sessions: find and activate the exact tab ===
  if (source === 'terminal') {
    const tty = tabInfo.tty || (pid ? getProcessTty(pid) : null);
    const ttyPath = tty ? (tty.startsWith('/dev/') ? tty : `/dev/${tty}`) : null;
    // Resolve terminal app: from hook env (term_program) or process tree walk
    const termFromEnv = resolveTermAppFromEnv(tabInfo.termProgram);
    const termApp = termFromEnv || (pid ? detectTerminalApp(pid) : null);
    console.log(`[open-editor] TERMINAL: pid=${pid || 'none'} tty=${ttyPath || 'NONE'} termApp=${termApp || 'unknown'} tabId=${tabInfo.tabId || 'none'} (term_program=${tabInfo.termProgram || '-'})`);

    // Pre-refresh: set the tab title to "Claude: project" via OSC escape before matching.
    // Claude Code overwrites tab titles with task descriptions (e.g. "⠐ Reading file").
    // OSC 0 sets both icon name + window title; OSC 1/2 are icon name and window title separately.
    if (ttyPath && projectName) {
      try {
        const oscTitle = `\x1b]0;Claude: ${projectName}\x07`;
        writeFileSync(ttyPath, oscTitle);
        // Write again after a short gap — if Claude Code writes output between our writes,
        // the second write ensures the title sticks.
        await new Promise(r => setTimeout(r, 50));
        writeFileSync(ttyPath, oscTitle);
        console.log(`[open-editor] refreshed tab title to "Claude: ${projectName}" via ${ttyPath}`);
        await new Promise(r => setTimeout(r, 250));
      } catch (e) { console.log(`[open-editor] title refresh failed: ${e.message}`); }
    }

    // iTerm2: match by ITERM_SESSION_ID → TTY → tab title ("Claude: project" / project name / unique "Claude")
    if (termApp === 'iTerm2' || (!termApp && ttyPath)) {
      // Step 1: session ID or TTY (most precise)
      try {
        const itermSessionId = tabInfo.tabId && !tabInfo.tabId.includes(':') ? tabInfo.tabId : null;
        const matchField = itermSessionId ? 'unique ID' : 'tty';
        const matchValue = itermSessionId || ttyPath;
        const matchExpr = itermSessionId
          ? `if unique ID of s is "${itermSessionId}" then`
          : `if tty of s is "${matchValue}" then`;
        console.log(`[open-editor] trying iTerm2 by ${matchField}=${matchValue}`);
        const r = await runShellScript('osascript', ['-e', [
          'tell application "iTerm2"',
          '  repeat with w in windows',
          '    repeat with t in tabs of w',
          '      repeat with s in sessions of t',
          `        ${matchExpr}`,
          '          select w',
          '          tell t to select',
          '          activate',
          '          return "ok"',
          '        end if',
          '      end repeat',
          '    end repeat',
          '  end repeat',
          'end tell',
          'return "not_found"'
        ].join('\n')]);
        console.log(`[open-editor] iTerm2 result: "${r.trim()}" (matched by ${matchField})`);
        if (r.trim() === 'ok') return { ok: true, editor: 'iTerm2', method: matchField === 'unique ID' ? 'session_id' : 'tty' };
      } catch (e) { console.log(`[open-editor] iTerm2 session/tty error: ${e.message?.split('\n')[0]}`); }

      // Step 2: match by tab title — "Claude: project" > project name > unique "Claude"
      if (termApp === 'iTerm2') {
        try {
          const escapedProject = projectName.replace(/"/g, '\\"');
          console.log(`[open-editor] trying iTerm2 tab title match for "${projectName}"`);
          const r = await runShellScript('osascript', ['-e', [
            'tell application "iTerm2"',
            `  set targetName to "${escapedProject}"`,
            '  set claudeTab to missing value',
            '  set claudeWindow to missing value',
            '  set claudeTabTitle to ""',
            '  set claudeCount to 0',
            '  set allNames to ""',
            '  repeat with w in windows',
            '    repeat with t in tabs of w',
            '      set tabName to name of current session of t',
            '      set allNames to allNames & tabName & "||"',
            // Best: "Claude: project"
            '      if tabName contains ("Claude: " & targetName) then',
            '        select w',
            '        tell t to select',
            '        activate',
            '        return "ok_tab||" & tabName & "||" & allNames',
            '      end if',
            // Good: project name in tab
            '      if tabName contains targetName then',
            '        select w',
            '        tell t to select',
            '        activate',
            '        return "ok_tab||" & tabName & "||" & allNames',
            '      end if',
            // Track "Claude" tabs for single-match fallback
            '      if tabName contains "Claude" then',
            '        set claudeTab to t',
            '        set claudeWindow to w',
            '        set claudeTabTitle to tabName',
            '        set claudeCount to claudeCount + 1',
            '      end if',
            '    end repeat',
            '  end repeat',
            // Fallback: unique Claude tab
            '  if claudeCount is 1 and claudeTab is not missing value then',
            '    select claudeWindow',
            '    tell claudeTab to select',
            '    activate',
            '    return "ok_claude||" & claudeTabTitle & "||" & allNames',
            '  end if',
            '  return "no_match||" & allNames',
            'end tell',
          ].join('\n')]);
          const trimmed = r.trim();
          const parts = trimmed.split('||').filter(Boolean);
          const status = parts[0];
          if (status === 'ok_tab' || status === 'ok_claude') {
            const method = status === 'ok_tab' ? 'tab_match' : 'tab_claude_match';
            console.log(`[open-editor] iTerm2: clicked tab "${parts[1]}" (${status})`);
            return { ok: true, editor: 'iTerm2', method };
          }
          const allTabs = parts.slice(1);
          console.log(`[open-editor] iTerm2: no tab title matched "${projectName}"`);
          if (allTabs.length) console.log(`[open-editor] iTerm2: all tabs: [${allTabs.map(t => `"${t}"`).join(', ')}]`);
        } catch (e) { console.log(`[open-editor] iTerm2 tab title error: ${e.message?.split('\n')[0]}`); }
      }
    }

    // Terminal.app: match by TTY → tab title ("Claude: project" / project name / unique "Claude")
    if ((termApp === 'Terminal' || !termApp) && ttyPath) {
      // Step 1: TTY match
      try {
        console.log(`[open-editor] trying Terminal.app with tty=${ttyPath}`);
        const r = await runShellScript('osascript', ['-e', [
          'tell application "Terminal"',
          '  repeat with w in windows',
          '    repeat with t in tabs of w',
          `      if tty of t is "${ttyPath}" then`,
          '        set frontmost of w to true',
          '        set selected tab of w to t',
          '        activate',
          '        return "ok"',
          '      end if',
          '    end repeat',
          '  end repeat',
          'end tell',
          'return "not_found"'
        ].join('\n')]);
        console.log(`[open-editor] Terminal.app result: "${r.trim()}"`);
        if (r.trim() === 'ok') return { ok: true, editor: 'Terminal', method: 'tty' };
      } catch (e) { console.log(`[open-editor] Terminal.app tty error: ${e.message?.split('\n')[0]}`); }

      // Step 2: match by tab custom title or process name
      if (termApp === 'Terminal') {
        try {
          const escapedProject = projectName.replace(/"/g, '\\"');
          console.log(`[open-editor] trying Terminal.app tab title match for "${projectName}"`);
          const r = await runShellScript('osascript', ['-e', [
            'tell application "Terminal"',
            `  set targetName to "${escapedProject}"`,
            '  set claudeTab to missing value',
            '  set claudeWindow to missing value',
            '  set claudeCount to 0',
            '  set allNames to ""',
            '  repeat with w in windows',
            '    repeat with t in tabs of w',
            '      set tabName to custom title of t',
            '      if tabName is "" then set tabName to name of w',
            '      set allNames to allNames & tabName & "||"',
            '      if tabName contains ("Claude: " & targetName) then',
            '        set frontmost of w to true',
            '        set selected tab of w to t',
            '        activate',
            '        return "ok_tab||" & tabName & "||" & allNames',
            '      end if',
            '      if tabName contains targetName then',
            '        set frontmost of w to true',
            '        set selected tab of w to t',
            '        activate',
            '        return "ok_tab||" & tabName & "||" & allNames',
            '      end if',
            '      if tabName contains "Claude" then',
            '        set claudeTab to t',
            '        set claudeWindow to w',
            '        set claudeCount to claudeCount + 1',
            '      end if',
            '    end repeat',
            '  end repeat',
            '  if claudeCount is 1 and claudeTab is not missing value then',
            '    set frontmost of claudeWindow to true',
            '    set selected tab of claudeWindow to claudeTab',
            '    activate',
            '    return "ok_claude||" & allNames',
            '  end if',
            '  return "no_match||" & allNames',
            'end tell',
          ].join('\n')]);
          const trimmed = r.trim();
          const parts = trimmed.split('||').filter(Boolean);
          const status = parts[0];
          if (status === 'ok_tab' || status === 'ok_claude') {
            console.log(`[open-editor] Terminal.app: matched tab by title (${status})`);
            return { ok: true, editor: 'Terminal', method: status === 'ok_tab' ? 'tab_match' : 'tab_claude_match' };
          }
          console.log(`[open-editor] Terminal.app: no tab title matched "${projectName}"`);
        } catch (e) { console.log(`[open-editor] Terminal.app tab title error: ${e.message?.split('\n')[0]}`); }
      }
    }

    // Kitty: use kitty @ focus-window if kitty_pid is known
    if (termApp === 'Kitty' && tabInfo.kittyPid) {
      try {
        console.log(`[open-editor] trying Kitty focus via kitty @`);
        await runShellScript('kitty', ['@', '--to', `unix:/tmp/kitty-${tabInfo.kittyPid}`, 'focus-window']);
        return { ok: true, editor: 'Kitty', method: 'kitty_remote' };
      } catch (e) { console.log(`[open-editor] Kitty remote error: ${e.message?.split('\n')[0]}`); }
    }

    // tmux: select the exact pane if we have tmux info
    if (tabInfo.tmux && tabInfo.tmux.pane) {
      try {
        const tmuxSocket = tabInfo.tmux.session.split(',')[0]; // e.g. "/tmp/tmux-501/default"
        console.log(`[open-editor] trying tmux select-pane: pane=${tabInfo.tmux.pane} socket=${tmuxSocket}`);
        await runShellScript('tmux', ['-S', tmuxSocket, 'select-pane', '-t', tabInfo.tmux.pane]);
        await runShellScript('tmux', ['-S', tmuxSocket, 'select-window', '-t', tabInfo.tmux.pane]);
        // Also activate the terminal app hosting tmux
        if (termApp) {
          await runShellScript('osascript', ['-e', `tell application "${termApp}" to activate`]);
        }
        return { ok: true, editor: termApp || 'tmux', method: 'tmux_pane' };
      } catch (e) { console.log(`[open-editor] tmux error: ${e.message?.split('\n')[0]}`); }
    }

    // WezTerm: use wezterm cli to focus the pane
    if (termApp === 'WezTerm' && tabInfo.tabId?.startsWith('wezterm:')) {
      const paneId = tabInfo.tabId.replace('wezterm:', '');
      try {
        console.log(`[open-editor] trying WezTerm CLI: pane=${paneId}`);
        await runShellScript('wezterm', ['cli', 'activate-pane', '--pane-id', paneId]);
        await runShellScript('osascript', ['-e', 'tell application "WezTerm" to activate']);
        return { ok: true, editor: 'WezTerm', method: 'wezterm_cli' };
      } catch (e) { console.log(`[open-editor] WezTerm CLI error: ${e.message?.split('\n')[0]}`); }
    }

    // Any other terminal app: use System Events to match tabs then windows by project name
    if (termApp) {
      const procName = termApp;
      const escapedProject = projectName.replace(/"/g, '\\"');
      const escapedTty = ttyPath ? ttyPath.replace(/"/g, '\\"').replace(/.*\//, '') : '';

      // Strategy A: Find and click the exact TAB via accessibility (AXTabGroup → radio buttons/tabs)
      // This handles the case where the correct tab exists but isn't active.
      // Match priority: 1) "Claude: project" (set by hook), 2) project name, 3) "Claude" keyword (if unique)
      try {
        console.log(`[open-editor] trying System Events TAB match for "${procName}" project="${projectName}"`);
        const r = await runShellScript('osascript', ['-e', [
          'tell application "System Events"',
          `  if not (exists process "${procName}") then return "not_running"`,
          `  tell process "${procName}"`,
          `    set targetName to "${escapedProject}"`,
          '    set tabInfo to ""',
          '    set claudeTabRef to missing value',
          '    set claudeTabWindow to missing value',
          '    set claudeTabTitle to ""',
          '    set claudeTabCount to 0',
          //
          // Scan all tab groups: collect tab titles, match by project name or "Claude"
          '    repeat with w in windows',
          '      try',
          '        repeat with tg in tab groups of w',
          '          repeat with rb in radio buttons of tg',
          '            set tabTitle to name of rb',
          '            set tabInfo to tabInfo & tabTitle & "||"',
          // Best match: tab title contains "Claude: project" (set by our hook on SessionStart)
          `            if tabTitle contains ("Claude: " & targetName) then`,
          '              click rb',
          '              perform action "AXRaise" of w',
          '              set frontmost to true',
          '              return "ok_tab||" & tabTitle & "||" & tabInfo',
          '            end if',
          // Good match: tab title contains the project name
          '            if tabTitle contains targetName then',
          '              click rb',
          '              perform action "AXRaise" of w',
          '              set frontmost to true',
          '              return "ok_tab||" & tabTitle & "||" & tabInfo',
          '            end if',
          // Track "Claude" tabs for fallback (only click if exactly one)
          '            if tabTitle contains "Claude" then',
          '              set claudeTabRef to rb',
          '              set claudeTabWindow to w',
          '              set claudeTabTitle to tabTitle',
          '              set claudeTabCount to claudeTabCount + 1',
          '            end if',
          '          end repeat',
          '        end repeat',
          '      end try',
          // Also check toolbar buttons (some terminals use toolbars for tabs)
          '      try',
          '        repeat with tb in toolbars of w',
          '          repeat with btn in buttons of tb',
          '            set tabTitle to name of btn',
          '            set tabInfo to tabInfo & tabTitle & "||"',
          `            if tabTitle contains ("Claude: " & targetName) then`,
          '              click btn',
          '              perform action "AXRaise" of w',
          '              set frontmost to true',
          '              return "ok_tab||" & tabTitle & "||" & tabInfo',
          '            end if',
          '            if tabTitle contains targetName then',
          '              click btn',
          '              perform action "AXRaise" of w',
          '              set frontmost to true',
          '              return "ok_tab||" & tabTitle & "||" & tabInfo',
          '            end if',
          '            if tabTitle contains "Claude" then',
          '              set claudeTabRef to btn',
          '              set claudeTabWindow to w',
          '              set claudeTabTitle to tabTitle',
          '              set claudeTabCount to claudeTabCount + 1',
          '            end if',
          '          end repeat',
          '        end repeat',
          '      end try',
          '    end repeat',
          //
          // Fallback: if exactly one "Claude" tab found, click it
          '    if claudeTabCount is 1 and claudeTabRef is not missing value then',
          '      click claudeTabRef',
          '      perform action "AXRaise" of claudeTabWindow',
          '      set frontmost to true',
          '      return "ok_claude||" & claudeTabTitle & "||" & tabInfo',
          '    end if',
          //
          // TTY fallback
          ...(escapedTty ? [
          `    set ttyName to "${escapedTty}"`,
          '    repeat with w in windows',
          '      try',
          '        repeat with tg in tab groups of w',
          '          repeat with rb in radio buttons of tg',
          '            if name of rb contains ttyName then',
          '              click rb',
          '              perform action "AXRaise" of w',
          '              set frontmost to true',
          '              return "ok_tab_tty||" & name of rb & "||" & tabInfo',
          '            end if',
          '          end repeat',
          '        end repeat',
          '      end try',
          '    end repeat',
          ] : []),
          '    return "no_tab||" & tabInfo',
          '  end tell',
          'end tell',
        ].join('\n')]);
        const trimmed = r.trim();
        if (trimmed !== 'not_running') {
          const parts = trimmed.split('||').filter(Boolean);
          const status = parts[0];
          if (status === 'ok_tab' || status === 'ok_tab_tty' || status === 'ok_claude') {
            const method = status === 'ok_tab' ? 'tab_match' : status === 'ok_claude' ? 'tab_claude_match' : 'tab_tty_match';
            console.log(`[open-editor] TERMINAL: clicked tab "${parts[1]}" in ${procName} (${status})`);
            const allTabs = parts.slice(2);
            if (allTabs.length) console.log(`[open-editor] TERMINAL: all tabs: [${allTabs.map(t => `"${t}"`).join(', ')}]`);
            // Explicitly activate the terminal app to bring it to the foreground.
            // set frontmost to true via System Events isn't always sufficient when
            // another app (e.g. the browser showing the dashboard) has focus.
            try { await runShellScript('osascript', ['-e', `tell application "${procName}" to activate`]); } catch(e) {}
            return { ok: true, editor: termApp, method };
          }
          const allTabs = parts.slice(1);
          if (allTabs.length) {
            console.log(`[open-editor] TERMINAL: no tab matched "${projectName}" or unique "Claude" in ${procName}`);
            console.log(`[open-editor] TERMINAL: all tabs: [${allTabs.map(t => `"${t}"`).join(', ')}]`);
          } else {
            console.log(`[open-editor] TERMINAL: no tabs found via AX in ${procName} (may not expose tab groups)`);
          }
        }
      } catch (e) { console.log(`[open-editor] System Events tab match error: ${e.message?.split('\n')[0]}`); }

      // Retry once: re-write tab title and try tab match again.
      // Claude Code may have overwritten the title between our pre-refresh and the search.
      if (ttyPath && projectName) {
        try {
          console.log(`[open-editor] RETRY: re-writing tab title and trying tab match again`);
          writeFileSync(ttyPath, `\x1b]0;Claude: ${projectName}\x07`);
          await new Promise(r => setTimeout(r, 300));
          const r = await runShellScript('osascript', ['-e', [
            'tell application "System Events"',
            `  if not (exists process "${procName}") then return "not_running"`,
            `  tell process "${procName}"`,
            '    repeat with w in windows',
            '      try',
            '        repeat with tg in tab groups of w',
            '          repeat with rb in radio buttons of tg',
            `            if name of rb contains "Claude: ${escapedProject}" then`,
            '              click rb',
            '              perform action "AXRaise" of w',
            '              set frontmost to true',
            '              return "ok_retry"',
            '            end if',
            '          end repeat',
            '        end repeat',
            '      end try',
            '    end repeat',
            '    return "no_match"',
            '  end tell',
            'end tell',
          ].join('\n')]);
          if (r.trim() === 'ok_retry') {
            console.log(`[open-editor] TERMINAL: RETRY succeeded — clicked tab in ${procName}`);
            try { await runShellScript('osascript', ['-e', `tell application "${procName}" to activate`]); } catch(e) {}
            return { ok: true, editor: termApp, method: 'tab_match_retry' };
          }
          console.log(`[open-editor] TERMINAL: RETRY also failed`);
        } catch (e) { console.log(`[open-editor] RETRY error: ${e.message?.split('\n')[0]}`); }
      }

      // Strategy B: Fall back to window title matching (works when correct tab is already active)
      try {
        console.log(`[open-editor] trying System Events WINDOW match for "${procName}" project="${projectName}"`);
        const r = await runShellScript('osascript', ['-e', [
          'tell application "System Events"',
          `  if not (exists process "${procName}") then return "not_running"`,
          `  tell process "${procName}"`,
          '    set allTitles to ""',
          '    repeat with w in windows',
          '      set allTitles to allTitles & name of w & "||"',
          '    end repeat',
          `    set targetName to "${escapedProject}"`,
          '    repeat with w in windows',
          '      if name of w contains targetName then',
          '        perform action "AXRaise" of w',
          '        set frontmost to true',
          '        return "ok||" & name of w & "||" & allTitles',
          '      end if',
          '    end repeat',
          ...(escapedTty ? [
          `    set ttyName to "${escapedTty}"`,
          '    repeat with w in windows',
          '      if name of w contains ttyName then',
          '        perform action "AXRaise" of w',
          '        set frontmost to true',
          '        return "ok_tty||" & name of w & "||" & allTitles',
          '      end if',
          '    end repeat',
          ] : []),
          '    if (count of windows) > 0 then',
          '      perform action "AXRaise" of (first window)',
          '    end if',
          '    set frontmost to true',
          '    return "no_match||" & allTitles',
          '  end tell',
          'end tell',
        ].join('\n')]);
        const trimmed = r.trim();
        if (trimmed !== 'not_running') {
          const parts = trimmed.split('||').filter(Boolean);
          const status = parts[0];
          // Activate the app to bring it to foreground
          try { await runShellScript('osascript', ['-e', `tell application "${procName}" to activate`]); } catch(e) {}
          if (status === 'ok') {
            console.log(`[open-editor] TERMINAL: matched window "${parts[1]}" by project name in ${procName}`);
            return { ok: true, editor: termApp, method: 'window_match' };
          } else if (status === 'ok_tty') {
            console.log(`[open-editor] TERMINAL: matched window "${parts[1]}" by tty in ${procName}`);
            return { ok: true, editor: termApp, method: 'window_tty_match' };
          } else {
            console.log(`[open-editor] TERMINAL: no window matched "${projectName}" in ${procName}, activated first window`);
            console.log(`[open-editor] TERMINAL: all windows: [${parts.slice(1).map(w => `"${w}"`).join(', ')}]`);
            return { ok: true, editor: termApp, method: 'activate' };
          }
        }
      } catch (e) { console.log(`[open-editor] System Events window match error: ${e.message?.split('\n')[0]}`); }

      // Last resort for known terminal: just activate the app
      try {
        console.log(`[open-editor] last resort: activating terminal app: ${termApp}`);
        await runShellScript('osascript', ['-e', `tell application "${termApp}" to activate`]);
        return { ok: true, editor: termApp, method: 'activate' };
      } catch (e) { console.log(`[open-editor] ${termApp} activate error: ${e.message?.split('\n')[0]}`); }
    }

    console.log(`[open-editor] TERMINAL: all strategies exhausted, falling through`);
  }

  // === VS Code / JetBrains sessions: use System Events (Electron apps don't support AppleScript `windows`) ===
  if (source === 'vscode' || source === 'jetbrains') {
    // Build list of process names to try
    let processNames;
    if (source === 'vscode') {
      processNames = ['Code', 'Code - Insiders', 'Cursor'];
    } else {
      const jbApp = pid ? detectTerminalApp(pid) : null;
      processNames = jbApp ? [jbApp] : [
        'WebStorm', 'IntelliJ IDEA', 'PyCharm', 'GoLand', 'CLion',
        'Rider', 'PhpStorm', 'RubyMine', 'DataGrip', 'Fleet'
      ];
    }
    console.log(`[open-editor] ${source.toUpperCase()}: trying processes=[${processNames.join(', ')}] projectName="${projectName}"`);

    const escapedProject = projectName.replace(/"/g, '\\"');
    for (const procName of processNames) {
      try {
        // Step 1: Find and raise the correct window (by project name or "Claude" keyword)
        const r = await runShellScript('osascript', ['-e', [
          'tell application "System Events"',
          `  if not (exists process "${procName}") then return "not_running"`,
          `  tell process "${procName}"`,
          '    set allTitles to ""',
          '    set claudeWinRef to missing value',
          '    set claudeWinTitle to ""',
          '    set claudeWinCount to 0',
          '    repeat with w in windows',
          '      set wTitle to name of w',
          '      set allTitles to allTitles & wTitle & "||"',
          `      if wTitle contains ("Claude: " & "${escapedProject}") then`,
          '        perform action "AXRaise" of w',
          '        set frontmost to true',
          '        return "ok||" & wTitle & "||" & allTitles',
          '      end if',
          `      if wTitle contains "${escapedProject}" then`,
          '        perform action "AXRaise" of w',
          '        set frontmost to true',
          '        return "ok||" & wTitle & "||" & allTitles',
          '      end if',
          '      if wTitle contains "Claude" then',
          '        set claudeWinRef to w',
          '        set claudeWinTitle to wTitle',
          '        set claudeWinCount to claudeWinCount + 1',
          '      end if',
          '    end repeat',
          '    if claudeWinCount is 1 and claudeWinRef is not missing value then',
          '      perform action "AXRaise" of claudeWinRef',
          '      set frontmost to true',
          '      return "ok_claude||" & claudeWinTitle & "||" & allTitles',
          '    end if',
          '    set frontmost to true',
          '    return "no_match||" & allTitles',
          '  end tell',
          'end tell',
        ].join('\n')]);
        const trimmed = r.trim();
        if (trimmed === 'not_running') {
          console.log(`[open-editor] ${source.toUpperCase()}: process "${procName}" not running`);
          continue;
        }
        const parts = trimmed.split('||').filter(Boolean);
        const status = parts[0];
        if (status === 'ok' || status === 'ok_claude') {
          const matchedWindow = parts[1] || '';
          const allWindows = parts.slice(2);
          const method = status === 'ok_claude' ? 'window_claude_match' : 'window_match';
          console.log(`[open-editor] ${source.toUpperCase()}: MATCHED window "${matchedWindow}" (process="${procName}", ${status})`);
          console.log(`[open-editor] ${source.toUpperCase()}: all windows: [${allWindows.map(w => `"${w}"`).join(', ')}]`);

          // Step 2: Focus the terminal panel via keyboard shortcut.
          // VS Code (Electron) and JetBrains (Java/Swing) don't expose internal terminal
          // tabs via macOS accessibility API, so AX search won't work. Instead, send a
          // keyboard shortcut to open/focus the terminal panel within the IDE.
          try {
            if (source === 'vscode') {
              console.log(`[open-editor] ${source.toUpperCase()}: sending Ctrl+\` to focus terminal panel`);
              await runShellScript('osascript', ['-e', [
                'tell application "System Events"',
                `  tell process "${procName}"`,
                '    keystroke "`" using control down',
                '  end tell',
                'end tell',
              ].join('\n')]);
            } else {
              console.log(`[open-editor] ${source.toUpperCase()}: sending Alt+F12 to focus terminal tool window`);
              await runShellScript('osascript', ['-e', [
                'tell application "System Events"',
                `  tell process "${procName}"`,
                '    key code 111 using option down',
                '  end tell',
                'end tell',
              ].join('\n')]);
            }
          } catch (e) {
            console.log(`[open-editor] ${source.toUpperCase()}: keyboard shortcut error: ${e.message?.split('\n')[0]}`);
          }

          return { ok: true, editor: source === 'vscode' ? 'VS Code' : procName, method: method + '+term_focus' };
        } else {
          const allWindows = parts.slice(1);
          console.log(`[open-editor] ${source.toUpperCase()}: no window matched "${projectName}" in process "${procName}"`);
          console.log(`[open-editor] ${source.toUpperCase()}: all windows: [${allWindows.map(w => `"${w}"`).join(', ')}]`);
          return { ok: true, editor: source === 'vscode' ? 'VS Code' : procName, method: 'activate' };
        }
      } catch (e) {
        console.log(`[open-editor] ${source.toUpperCase()}: "${procName}" error: ${e.message?.split('\n')[0]}`);
      }
    }
    console.log(`[open-editor] ${source.toUpperCase()}: no running process found, falling through`);
  }

  // === Fallback: open the project folder in the appropriate editor ===
  console.log(`[open-editor] FALLBACK: source=${source} projectPath=${projectPath}`);
  return fallbackOpenEditor(source, projectPath);
}

// ---- Linux: focus session window by PID or title via xdotool ----
async function focusSessionLinux(pid, projectPath, source, projectName) {
  // Helper: after activating a VS Code/JetBrains window, focus the terminal panel
  async function focusTerminalPanel(windowId) {
    if (source === 'vscode') {
      try {
        console.log(`[open-editor] Linux: sending Ctrl+\` to focus VS Code terminal panel`);
        await runShellScript('xdotool', ['key', '--window', windowId, '--delay', '100', 'ctrl+grave']);
      } catch {}
    } else if (source === 'jetbrains') {
      try {
        console.log(`[open-editor] Linux: sending Alt+F12 to focus JetBrains terminal`);
        await runShellScript('xdotool', ['key', '--window', windowId, '--delay', '100', 'alt+F12']);
      } catch {}
    }
  }

  // Strategy 1: find window by PID
  if (pid) {
    try {
      const wid = await runShellScript('xdotool', ['search', '--pid', String(pid)]);
      const windowId = wid.trim().split('\n')[0];
      if (windowId) {
        await runShellScript('xdotool', ['windowactivate', '--sync', windowId]);
        await focusTerminalPanel(windowId);
        return { ok: true, method: 'xdotool_pid' };
      }
    } catch {}
  }

  // Strategy 2: find window by title "Claude: project"
  if (projectName) {
    try {
      console.log(`[open-editor] Linux: trying xdotool --name "Claude: ${projectName}"`);
      const wid = await runShellScript('xdotool', ['search', '--name', `Claude: ${projectName}`]);
      const windowId = wid.trim().split('\n')[0];
      if (windowId) {
        await runShellScript('xdotool', ['windowactivate', '--sync', windowId]);
        await focusTerminalPanel(windowId);
        return { ok: true, method: 'xdotool_title' };
      }
    } catch {}

    // Strategy 3: find window by project name in title
    try {
      console.log(`[open-editor] Linux: trying xdotool --name "${projectName}"`);
      const wid = await runShellScript('xdotool', ['search', '--name', projectName]);
      const windowId = wid.trim().split('\n')[0];
      if (windowId) {
        await runShellScript('xdotool', ['windowactivate', '--sync', windowId]);
        await focusTerminalPanel(windowId);
        return { ok: true, method: 'xdotool_project' };
      }
    } catch {}

    // Strategy 4: find any window with "Claude" in title (if unique)
    try {
      const wid = await runShellScript('xdotool', ['search', '--name', 'Claude']);
      const windowIds = wid.trim().split('\n').filter(Boolean);
      if (windowIds.length === 1) {
        console.log(`[open-editor] Linux: unique "Claude" window found`);
        await runShellScript('xdotool', ['windowactivate', '--sync', windowIds[0]]);
        await focusTerminalPanel(windowIds[0]);
        return { ok: true, method: 'xdotool_claude' };
      } else if (windowIds.length > 1) {
        console.log(`[open-editor] Linux: ${windowIds.length} "Claude" windows — ambiguous, skipping`);
      }
    } catch {}
  }

  // Fallback: open in editor
  return fallbackOpenEditor(source, projectPath);
}

// ---- Windows: focus session window by PID or title via PowerShell ----
async function focusSessionWindows(pid, projectPath, source, projectName) {
  // Helper: after activating a VS Code/JetBrains window, focus the terminal panel via SendKeys
  async function focusTerminalPanel() {
    if (source === 'vscode') {
      try {
        console.log(`[open-editor] Windows: sending Ctrl+\` to focus VS Code terminal panel`);
        // SendKeys: ^ = Ctrl, ` needs to be sent directly
        await runShellScript('powershell', ['-NoProfile', '-Command',
          'Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 300; [System.Windows.Forms.SendKeys]::SendWait("^``")']);
      } catch {}
    } else if (source === 'jetbrains') {
      try {
        console.log(`[open-editor] Windows: sending Alt+F12 to focus JetBrains terminal`);
        await runShellScript('powershell', ['-NoProfile', '-Command',
          'Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 300; [System.Windows.Forms.SendKeys]::SendWait("%{F12}")']);
      } catch {}
    }
  }

  // Strategy 1: activate by PID (parent process = terminal/IDE)
  if (pid) {
    try {
      const psScript = `
        Add-Type -AssemblyName Microsoft.VisualBasic
        $proc = Get-Process -Id ${pid} -ErrorAction Stop
        $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid").ParentProcessId
        if ($parent) {
          $parentProc = Get-Process -Id $parent -ErrorAction SilentlyContinue
          if ($parentProc -and $parentProc.MainWindowHandle -ne [IntPtr]::Zero) {
            [Microsoft.VisualBasic.Interaction]::AppActivate($parentProc.Id)
            Write-Output "ok"
          } elseif ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
            [Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id)
            Write-Output "ok"
          } else {
            Write-Output "no_window"
          }
        } else {
          Write-Output "no_parent"
        }
      `;
      const r = await runShellScript('powershell', ['-NoProfile', '-Command', psScript]);
      if (r.trim() === 'ok') {
        await focusTerminalPanel();
        return { ok: true, method: 'powershell_activate' };
      }
    } catch {}
  }

  // Strategy 2: find window by title "Claude: project" or project name or unique "Claude"
  if (projectName) {
    const escapedName = projectName.replace(/'/g, "''");
    try {
      console.log(`[open-editor] Windows: trying window title match for "${projectName}"`);
      const psScript = `
        Add-Type -AssemblyName Microsoft.VisualBasic
        $allProcs = Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle }
        $allTitles = $allProcs | ForEach-Object { $_.MainWindowTitle }
        # Best: "Claude: project"
        $match = $allProcs | Where-Object { $_.MainWindowTitle -like "*Claude: ${escapedName}*" } | Select-Object -First 1
        if ($match) {
          [Microsoft.VisualBasic.Interaction]::AppActivate($match.Id)
          Write-Output "ok_claude_project"
          return
        }
        # Good: project name
        $match = $allProcs | Where-Object { $_.MainWindowTitle -like "*${escapedName}*" } | Select-Object -First 1
        if ($match) {
          [Microsoft.VisualBasic.Interaction]::AppActivate($match.Id)
          Write-Output "ok_project"
          return
        }
        # Fallback: unique "Claude" window
        $claudeMatches = $allProcs | Where-Object { $_.MainWindowTitle -like "*Claude*" }
        if ($claudeMatches.Count -eq 1) {
          [Microsoft.VisualBasic.Interaction]::AppActivate($claudeMatches[0].Id)
          Write-Output "ok_claude"
          return
        }
        Write-Output "no_match"
      `;
      const r = await runShellScript('powershell', ['-NoProfile', '-Command', psScript]);
      const result = r.trim();
      if (result.startsWith('ok')) {
        console.log(`[open-editor] Windows: window title match result: ${result}`);
        await focusTerminalPanel();
        return { ok: true, method: `powershell_${result}` };
      }
    } catch {}
  }

  return fallbackOpenEditor(source, projectPath);
}

// Fallback: open the project in the editor by CLI or OS mechanism
async function fallbackOpenEditor(source, projectPath) {
  if (source === 'jetbrains') {
    const jbCli = findJetBrainsCli();
    if (jbCli) {
      try {
        await runShellScript(jbCli.cli, [jbCli.openArg || 'open', projectPath].filter(Boolean));
        return { ok: true, editor: jbCli.name, method: 'cli_fallback' };
      } catch {}
    }
  }
  if (source === 'vscode' || source === 'unknown') {
    if (process.platform === 'darwin') {
      try {
        await runShellScript('open', [`vscode://file${projectPath}`]);
        return { ok: true, editor: 'VS Code', method: 'uri_fallback' };
      } catch {}
    }
    const codeCli = findCodeCli();
    if (codeCli) {
      try {
        await runShellScript(codeCli, [projectPath]);
        return { ok: true, editor: 'VS Code', method: 'cli_fallback' };
      } catch {}
    }
  }
  // Last resort: OS open
  if (process.platform === 'darwin') {
    await runShellScript('open', [projectPath]);
  } else if (process.platform === 'win32') {
    await runShellScript('cmd', ['/c', 'start', '', projectPath]);
  } else {
    await runShellScript('xdg-open', [projectPath]);
  }
  return { ok: true, method: 'os_open_fallback' };
}

// Resolve VS Code CLI path
function findCodeCli() {
  const candidates = process.platform === 'darwin'
    ? ['/usr/local/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code']
    : process.platform === 'win32'
      ? [process.env.LOCALAPPDATA + '\\Programs\\Microsoft VS Code\\bin\\code.cmd']
      : ['/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code'];
  for (const p of candidates) {
    try { execSync(`test -x "${p}"`, { timeout: 1000 }); return p; } catch {}
  }
  try {
    return execSync('which code 2>/dev/null || where code 2>nul', { encoding: 'utf-8', timeout: 2000 }).trim().split('\n')[0];
  } catch { return null; }
}

// Resolve JetBrains CLI path — tries common CLI launchers
function findJetBrainsCli() {
  const ides = [
    { name: 'IntelliJ IDEA', cmds: ['idea'] },
    { name: 'WebStorm', cmds: ['webstorm'] },
    { name: 'PyCharm', cmds: ['pycharm'] },
    { name: 'GoLand', cmds: ['goland'] },
    { name: 'CLion', cmds: ['clion'] },
    { name: 'Rider', cmds: ['rider'] },
    { name: 'PhpStorm', cmds: ['phpstorm'] },
    { name: 'RubyMine', cmds: ['rubymine'] },
    { name: 'DataGrip', cmds: ['datagrip'] },
    { name: 'Fleet', cmds: ['fleet'] },
  ];
  for (const ide of ides) {
    for (const cmd of ide.cmds) {
      try {
        const path = execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf-8', timeout: 2000 }).trim();
        if (path) return { cli: path, name: ide.name, openArg: null };
      } catch {}
    }
  }
  return null;
}

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

  // Get the summary prompt template (custom_prompt > prompt_id > default)
  const { prompt_id: promptId, custom_prompt: customPrompt } = req.body;
  let promptTemplate;
  if (customPrompt) {
    promptTemplate = customPrompt;
  } else if (promptId) {
    const row = db.prepare('SELECT prompt FROM summary_prompts WHERE id = ?').get(promptId);
    promptTemplate = row?.prompt;
  }
  if (!promptTemplate) {
    const row = db.prepare('SELECT prompt FROM summary_prompts WHERE is_default = 1 LIMIT 1').get();
    promptTemplate = row?.prompt || 'Summarize this Claude Code session in detail.';
  }

  const summaryPrompt = `${promptTemplate}\n\n--- SESSION TRANSCRIPT ---\n${context}`;

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

// ---- Summary Prompt Templates ----

// List all summary prompts
router.get('/summary-prompts', (req, res) => {
  const rows = db.prepare('SELECT * FROM summary_prompts ORDER BY is_default DESC, name ASC').all();
  res.json({ prompts: rows });
});

// Create a new summary prompt
router.post('/summary-prompts', (req, res) => {
  const { name, prompt, is_default } = req.body;
  if (!name || !prompt) return res.status(400).json({ error: 'name and prompt are required' });
  const now = Date.now();
  // If setting as default, clear other defaults
  if (is_default) {
    db.prepare('UPDATE summary_prompts SET is_default = 0').run();
  }
  const result = db.prepare('INSERT INTO summary_prompts (name, prompt, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(name, prompt, is_default ? 1 : 0, now, now);
  res.json({ ok: true, id: result.lastInsertRowid });
});

// Update a summary prompt
router.put('/summary-prompts/:id', (req, res) => {
  const { name, prompt, is_default } = req.body;
  const id = req.params.id;
  const now = Date.now();
  if (is_default) {
    db.prepare('UPDATE summary_prompts SET is_default = 0').run();
  }
  const sets = [];
  const params = [];
  if (name !== undefined) { sets.push('name = ?'); params.push(name); }
  if (prompt !== undefined) { sets.push('prompt = ?'); params.push(prompt); }
  if (is_default !== undefined) { sets.push('is_default = ?'); params.push(is_default ? 1 : 0); }
  sets.push('updated_at = ?'); params.push(now);
  params.push(id);
  db.prepare(`UPDATE summary_prompts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// Delete a summary prompt
router.delete('/summary-prompts/:id', (req, res) => {
  db.prepare('DELETE FROM summary_prompts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
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

// ---- Prompt Queue ----

// Helper: re-number positions after delete/pop
function renumberQueue(sessionId) {
  const rows = db.prepare('SELECT id FROM prompt_queue WHERE session_id = ? ORDER BY position ASC').all(sessionId);
  const stmt = db.prepare('UPDATE prompt_queue SET position = ? WHERE id = ?');
  for (let i = 0; i < rows.length; i++) {
    stmt.run(i, rows[i].id);
  }
}

// Helper: broadcast updated session with new queueCount
function broadcastQueueChange(sessionId) {
  const session = updateQueueCount(sessionId);
  if (session) {
    broadcast({ type: 'session_update', session });
  }
}

// List queued prompts
router.get('/sessions/:id/prompt-queue', (req, res) => {
  const items = db.prepare('SELECT * FROM prompt_queue WHERE session_id = ? ORDER BY position ASC').all(req.params.id);
  res.json({ items });
});

// Add prompt to queue
router.post('/sessions/:id/prompt-queue', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Prompt text is required' });
  const now = Date.now();
  const maxPos = db.prepare('SELECT MAX(position) AS m FROM prompt_queue WHERE session_id = ?').get(req.params.id);
  const position = (maxPos?.m ?? -1) + 1;
  const result = db.prepare('INSERT INTO prompt_queue (session_id, text, position, created_at) VALUES (?, ?, ?, ?)').run(req.params.id, text.trim(), position, now);
  broadcastQueueChange(req.params.id);
  res.json({ ok: true, item: { id: result.lastInsertRowid, session_id: req.params.id, text: text.trim(), position, created_at: now } });
});

// Edit prompt text
router.put('/sessions/:id/prompt-queue/:itemId', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Prompt text is required' });
  db.prepare('UPDATE prompt_queue SET text = ? WHERE id = ? AND session_id = ?').run(text.trim(), req.params.itemId, req.params.id);
  res.json({ ok: true });
});

// Delete prompt from queue
router.delete('/sessions/:id/prompt-queue/:itemId', (req, res) => {
  db.prepare('DELETE FROM prompt_queue WHERE id = ? AND session_id = ?').run(req.params.itemId, req.params.id);
  renumberQueue(req.params.id);
  broadcastQueueChange(req.params.id);
  res.json({ ok: true });
});

// Pop top prompt (position=0) — returns text for clipboard copy
router.post('/sessions/:id/prompt-queue/pop', (req, res) => {
  const top = db.prepare('SELECT * FROM prompt_queue WHERE session_id = ? ORDER BY position ASC LIMIT 1').get(req.params.id);
  if (!top) return res.status(404).json({ error: 'Queue is empty' });
  db.prepare('DELETE FROM prompt_queue WHERE id = ?').run(top.id);
  renumberQueue(req.params.id);
  broadcastQueueChange(req.params.id);
  res.json({ ok: true, text: top.text });
});

// Reorder queue — accepts { order: [id, id, id] }
router.put('/sessions/:id/prompt-queue/reorder', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of item IDs' });
  const stmt = db.prepare('UPDATE prompt_queue SET position = ? WHERE id = ? AND session_id = ?');
  for (let i = 0; i < order.length; i++) {
    stmt.run(i, order[i], req.params.id);
  }
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

// ── SSH Keys ──

router.get('/ssh-keys', (req, res) => {
  res.json({ keys: listSshKeys() });
});

// ── SSH Profiles ──

router.get('/ssh-profiles', (req, res) => {
  const profiles = db.prepare('SELECT * FROM ssh_profiles ORDER BY updated_at DESC').all();
  res.json({ profiles });
});

router.post('/ssh-profiles', (req, res) => {
  const { name, host, port, username, authMethod, privateKeyPath, workingDir, defaultCommand } = req.body;
  if (!name || !username) return res.status(400).json({ error: 'name and username required' });
  const now = Date.now();
  const result = db.prepare(
    'INSERT INTO ssh_profiles (name, host, port, username, auth_method, private_key_path, working_dir, default_command, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, host || 'localhost', port || 22, username, authMethod || 'key', privateKeyPath || null, workingDir || '~', defaultCommand || 'claude', now, now);
  res.json({ ok: true, id: result.lastInsertRowid });
});

router.put('/ssh-profiles/:id', (req, res) => {
  const { name, host, port, username, authMethod, privateKeyPath, workingDir, defaultCommand } = req.body;
  const now = Date.now();
  db.prepare(
    'UPDATE ssh_profiles SET name = COALESCE(?, name), host = COALESCE(?, host), port = COALESCE(?, port), username = COALESCE(?, username), auth_method = COALESCE(?, auth_method), private_key_path = COALESCE(?, private_key_path), working_dir = COALESCE(?, working_dir), default_command = COALESCE(?, default_command), updated_at = ? WHERE id = ?'
  ).run(name, host, port, username, authMethod, privateKeyPath, workingDir, defaultCommand, now, req.params.id);
  res.json({ ok: true });
});

router.delete('/ssh-profiles/:id', (req, res) => {
  db.prepare('DELETE FROM ssh_profiles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Tmux Sessions ──

router.post('/tmux-sessions', async (req, res) => {
  try {
    const { host, port, username, password, privateKeyPath, authMethod, passphrase } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const config = {
      host: host || 'localhost',
      port: port || 22,
      username,
      authMethod: authMethod || 'key',
      privateKeyPath,
      password,
      passphrase,
    };
    const sessions = await listTmuxSessions(config);
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Terminals ──

router.post('/terminals', async (req, res) => {
  try {
    const { profileId, host, port, username, password, privateKeyPath, authMethod, workingDir, command, apiKey, tmuxSession, useTmux } = req.body;

    let config;
    if (profileId) {
      const profile = db.prepare('SELECT * FROM ssh_profiles WHERE id = ?').get(profileId);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });
      config = {
        host: host || profile.host,
        port: port || profile.port,
        username: username || profile.username,
        authMethod: authMethod || profile.auth_method,
        privateKeyPath: privateKeyPath || profile.private_key_path,
        workingDir: workingDir || profile.working_dir,
        command: command || profile.default_command,
        password,
      };
    } else {
      if (!username) return res.status(400).json({ error: 'username required' });
      config = { host: host || 'localhost', port: port || 22, username, authMethod: authMethod || 'key', privateKeyPath, workingDir: workingDir || '~', command: command || 'claude', password };
    }

    // Tmux modes
    if (tmuxSession) config.tmuxSession = tmuxSession; // attach to existing
    if (useTmux) config.useTmux = true; // wrap in new tmux session

    // Resolve API key: per-session override > global setting
    let resolvedApiKey = apiKey || '';
    if (!resolvedApiKey) {
      const row = db.prepare('SELECT value FROM user_settings WHERE key = ?').get('anthropicApiKey');
      if (row && row.value) resolvedApiKey = row.value;
    }
    if (resolvedApiKey) {
      config.apiKey = resolvedApiKey;
    }

    const terminalId = await createTerminal(config, null);
    // Create session card immediately so it appears in the dashboard
    await createTerminalSession(terminalId, config);
    res.json({ ok: true, terminalId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/terminals', (req, res) => {
  res.json({ terminals: getTerminals() });
});

router.delete('/terminals/:id', (req, res) => {
  closeTerminal(req.params.id);
  res.json({ ok: true });
});

export default router;

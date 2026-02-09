// sessionStore.js — In-memory session state machine with SQLite dual-write
import db from './db.js';
import { execSync } from 'child_process';

const sessions = new Map();
const projectSessionCounters = new Map();
const pendingToolTimers = new Map(); // session_id -> timeout for tool approval detection

// Prepared statements for SQLite dual-write
const insertSession = db.prepare(
  `INSERT OR IGNORE INTO sessions (id, project_path, project_name, model, status, git_branch, started_at, last_activity_at, source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const updateSessionStatus = db.prepare(
  `UPDATE sessions SET status=?, last_activity_at=?, total_tool_calls=? WHERE id=?`
);
const updateSessionEnded = db.prepare(
  `UPDATE sessions SET status='ended', ended_at=?, last_activity_at=? WHERE id=?`
);
const insertPrompt = db.prepare(
  `INSERT INTO prompts (session_id, text, timestamp) VALUES (?, ?, ?)`
);
const insertToolCall = db.prepare(
  `INSERT INTO tool_calls (session_id, tool_name, tool_input_summary, timestamp) VALUES (?, ?, ?, ?)`
);
const insertEvent = db.prepare(
  `INSERT INTO events (session_id, event_type, detail, timestamp) VALUES (?, ?, ?, ?)`
);
const insertResponse = db.prepare(
  `INSERT INTO responses (session_id, text_excerpt, timestamp) VALUES (?, ?, ?)`
);
const updateSessionPromptCount = db.prepare(
  `UPDATE sessions SET total_prompts = total_prompts + 1 WHERE id=?`
);
const updateSessionTitle = db.prepare(
  `UPDATE sessions SET title=? WHERE id=?`
);

// Startup recovery: reload active sessions from DB into the Map
const selectActiveSessions = db.prepare(
  `SELECT id, project_path, project_name, model, status, started_at, last_activity_at, total_tool_calls, total_prompts, source, title
   FROM sessions WHERE status != 'ended' AND last_activity_at > ?`
);
const selectSessionPrompts = db.prepare(
  `SELECT text, timestamp FROM prompts WHERE session_id = ? ORDER BY timestamp DESC LIMIT 50`
);
const selectSessionToolLog = db.prepare(
  `SELECT tool_name, tool_input_summary, timestamp FROM tool_calls WHERE session_id = ? ORDER BY timestamp DESC LIMIT 200`
);
const selectSessionResponses = db.prepare(
  `SELECT text_excerpt, timestamp FROM responses WHERE session_id = ? ORDER BY timestamp DESC LIMIT 50`
);
const selectSessionEvents = db.prepare(
  `SELECT event_type AS type, detail, timestamp FROM events WHERE session_id = ? ORDER BY timestamp DESC LIMIT 50`
);

export function loadActiveSessions() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    const rows = selectActiveSessions.all(cutoff);
    for (const row of rows) {
      if (sessions.has(row.id)) continue;

      // Reload history from DB (reverse to get chronological order)
      const promptRows = selectSessionPrompts.all(row.id).reverse();
      const toolRows = selectSessionToolLog.all(row.id).reverse();
      const responseRows = selectSessionResponses.all(row.id).reverse();
      const eventRows = selectSessionEvents.all(row.id).reverse();

      // Build toolUsage map from tool log
      const toolUsage = {};
      for (const t of toolRows) {
        toolUsage[t.tool_name] = (toolUsage[t.tool_name] || 0) + 1;
      }

      sessions.set(row.id, {
        sessionId: row.id,
        projectPath: row.project_path || '',
        projectName: row.project_name || 'Unknown',
        title: row.title || '',
        status: row.status || 'idle',
        animationState: 'Idle',
        emote: null,
        startedAt: row.started_at || Date.now(),
        lastActivityAt: row.last_activity_at || Date.now(),
        currentPrompt: promptRows.length > 0 ? promptRows[promptRows.length - 1].text : '',
        promptHistory: promptRows.map(p => ({ text: p.text, timestamp: p.timestamp })),
        toolUsage,
        totalToolCalls: row.total_tool_calls || 0,
        model: row.model || '',
        subagentCount: 0,
        toolLog: toolRows.map(t => ({ tool: t.tool_name, input: t.tool_input_summary, timestamp: t.timestamp })),
        responseLog: responseRows.map(r => ({ text: r.text_excerpt, timestamp: r.timestamp })),
        events: eventRows.map(e => ({ type: e.type, detail: e.detail, timestamp: e.timestamp })),
        archived: 0
      });
    }
  } catch (err) {
    console.error('[sessionStore] Failed to load active sessions from DB:', err.message);
  }
}

// Load active sessions at module init
loadActiveSessions();

export function handleEvent(hookData) {
  const { session_id, hook_event_name, cwd } = hookData;
  if (!session_id) return null;

  let session = sessions.get(session_id);

  // Create session if new
  if (!session) {
    session = {
      sessionId: session_id,
      projectPath: cwd || '',
      projectName: cwd ? cwd.split('/').filter(Boolean).pop() : 'Unknown',
      title: '',
      status: 'idle',
      animationState: 'Idle',
      emote: null,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      currentPrompt: '',
      promptHistory: [],
      toolUsage: {},
      totalToolCalls: 0,
      model: hookData.model || '',
      subagentCount: 0,
      toolLog: [],
      responseLog: [],
      events: [],
      archived: 0,
      pendingTool: null,
      waitingDetail: null
    };
    sessions.set(session_id, session);

    // Increment per-project session counter
    const projectKey = session.projectName;
    const count = (projectSessionCounters.get(projectKey) || 0) + 1;
    projectSessionCounters.set(projectKey, count);

    // Dual-write: insert new session into DB
    try {
      insertSession.run(
        session_id,
        session.projectPath,
        session.projectName,
        session.model,
        session.status,
        hookData.git_branch || null,
        session.startedAt,
        session.lastActivityAt,
        hookData.source || 'hook'
      );
    } catch (err) {
      console.error('[sessionStore] DB insertSession error:', err.message);
    }
  }

  session.lastActivityAt = Date.now();
  const eventEntry = {
    type: hook_event_name,
    timestamp: Date.now(),
    detail: ''
  };

  switch (hook_event_name) {
    case 'SessionStart':
      session.status = 'idle';
      session.animationState = 'Idle';
      session.model = hookData.model || session.model;
      eventEntry.detail = `Session started (${hookData.source || 'startup'})`;
      break;

    case 'UserPromptSubmit':
      session.status = 'prompting';
      session.animationState = 'Walking';
      session.emote = 'Wave';
      session.currentPrompt = hookData.prompt || '';
      session.promptHistory.push({
        text: hookData.prompt || '',
        timestamp: Date.now()
      });
      // Keep last 50 prompts
      if (session.promptHistory.length > 50) session.promptHistory.shift();
      eventEntry.detail = (hookData.prompt || '').substring(0, 80);

      // Auto-generate title from project name + counter + short prompt summary
      if (!session.title) {
        const counter = projectSessionCounters.get(session.projectName) || 1;
        const shortPrompt = makeShortTitle(hookData.prompt || '');
        session.title = shortPrompt
          ? `${session.projectName} #${counter} — ${shortPrompt}`
          : `${session.projectName} — Session #${counter}`;
        try {
          updateSessionTitle.run(session.title, session_id);
        } catch (err) {
          console.error('[sessionStore] DB updateSessionTitle error:', err.message);
        }
      }

      // Dual-write: insert prompt into DB
      try {
        insertPrompt.run(session_id, hookData.prompt || '', Date.now());
        updateSessionPromptCount.run(session_id);
      } catch (err) {
        console.error('[sessionStore] DB insertPrompt error:', err.message);
      }
      break;

    case 'PreToolUse': {
      session.status = 'working';
      session.animationState = 'Running';
      const toolName = hookData.tool_name || 'Unknown';
      session.toolUsage[toolName] = (session.toolUsage[toolName] || 0) + 1;
      session.totalToolCalls++;
      // Store detailed tool log entry for the detail panel
      const toolInputSummary = summarizeToolInput(hookData.tool_input, toolName);
      session.toolLog.push({
        tool: toolName,
        input: toolInputSummary,
        timestamp: Date.now()
      });
      if (session.toolLog.length > 200) session.toolLog.shift();
      eventEntry.detail = `${toolName}`;

      // Approval detection: if PostToolUse doesn't arrive within the timeout,
      // the tool is likely pending user approval.
      //
      // Only tools that are ALWAYS fast when auto-approved can reliably trigger
      // approval detection. Tools like Bash, Task, WebSearch etc. can legitimately
      // run for minutes, so we can't distinguish "slow execution" from "waiting
      // for approval" — applying the timer would cause false positives.
      const fastTools = new Set([
        'Read', 'Write', 'Edit', 'Grep', 'Glob', 'NotebookEdit',
        'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion',
        'TodoWrite', 'TodoRead'
      ]);
      clearTimeout(pendingToolTimers.get(session_id));
      if (fastTools.has(toolName)) {
        session.pendingTool = toolName;
        const timer = setTimeout(async () => {
          pendingToolTimers.delete(session_id);
          if (session.status === 'working' && session.pendingTool) {
            session.status = 'approval';
            session.animationState = 'Waiting';
            session.waitingDetail = `Approve: ${session.pendingTool}`;
            try {
              const { broadcast } = await import('./wsManager.js');
              broadcast({ type: 'session_update', session: { ...session } });
            } catch(e) {}
          }
        }, 3000);
        pendingToolTimers.set(session_id, timer);
      } else {
        session.pendingTool = null;
      }

      // Dual-write: insert tool call into DB
      try {
        insertToolCall.run(session_id, toolName, toolInputSummary, Date.now());
      } catch (err) {
        console.error('[sessionStore] DB insertToolCall error:', err.message);
      }
      break;
    }

    case 'PostToolUse':
      // Tool completed — cancel approval timer, stay working
      clearTimeout(pendingToolTimers.get(session_id));
      pendingToolTimers.delete(session_id);
      session.pendingTool = null;
      session.waitingDetail = null;
      session.status = 'working';
      eventEntry.detail = `${hookData.tool_name || 'Tool'} completed`;
      break;

    case 'Stop': {
      // Clear any pending tool approval timer
      clearTimeout(pendingToolTimers.get(session_id));
      pendingToolTimers.delete(session_id);
      session.pendingTool = null;
      session.waitingDetail = null;

      const wasHeavyWork = session.totalToolCalls > 10 &&
        session.status === 'working';
      // Session finished its turn — waiting for user's next prompt
      session.status = 'waiting';
      if (wasHeavyWork) {
        session.animationState = 'Dance';
        session.emote = null;
      } else {
        session.animationState = 'Waiting';
        session.emote = 'ThumbsUp';
      }
      eventEntry.detail = wasHeavyWork ? 'Heavy work done — ready for input' : 'Ready for your input';

      // Store response if present — try multiple possible field names
      const responseText = hookData.response || hookData.message || hookData.stop_reason_str || '';
      if (responseText) {
        const excerpt = responseText.substring(0, 2000);
        session.responseLog.push({ text: excerpt, timestamp: Date.now() });
        if (session.responseLog.length > 50) session.responseLog.shift();

        // Dual-write: insert response into DB
        try {
          insertResponse.run(session_id, excerpt, Date.now());
        } catch (err) {
          console.error('[sessionStore] DB insertResponse error:', err.message);
        }
      }

      // Dual-write: update session status in DB
      try {
        updateSessionStatus.run('waiting', Date.now(), session.totalToolCalls, session_id);
      } catch (err) {
        console.error('[sessionStore] DB updateSessionStatus error:', err.message);
      }

      // Reset tool counter for next turn
      session.totalToolCalls = 0;
      break;
    }

    case 'SubagentStart':
      session.subagentCount++;
      session.emote = 'Jump';
      eventEntry.detail = `Subagent spawned (${hookData.agent_type || 'unknown'})`;
      break;

    case 'SubagentStop':
      session.subagentCount = Math.max(0, session.subagentCount - 1);
      eventEntry.detail = `Subagent finished`;
      break;

    case 'Notification':
      eventEntry.detail = hookData.message || hookData.title || 'Notification';
      break;

    case 'SessionEnd':
      session.status = 'ended';
      session.animationState = 'Death';
      eventEntry.detail = `Session ended (${hookData.reason || 'unknown'})`;

      // Dual-write: mark session ended in DB
      try {
        updateSessionEnded.run(Date.now(), Date.now(), session_id);
      } catch (err) {
        console.error('[sessionStore] DB updateSessionEnded error:', err.message);
      }

      // Schedule removal from memory after 10s (client auto-removes cards sooner)
      setTimeout(() => sessions.delete(session_id), 10000);
      break;
  }

  // Keep last 50 events
  session.events.push(eventEntry);
  if (session.events.length > 50) session.events.shift();

  // Dual-write: insert event into DB
  try {
    insertEvent.run(session_id, hook_event_name, eventEntry.detail, eventEntry.timestamp);
  } catch (err) {
    console.error('[sessionStore] DB insertEvent error:', err.message);
  }

  return { session: { ...session } };
}

export function getAllSessions() {
  const result = {};
  for (const [id, session] of sessions) {
    result[id] = { ...session };
  }
  return result;
}

// Extract a short title from the first prompt (first sentence or first ~60 chars)
function makeShortTitle(prompt) {
  if (!prompt) return '';
  // Strip leading whitespace and common prefixes
  let text = prompt.trim().replace(/^(please|can you|could you|help me|i want to|i need to)\s+/i, '');
  if (!text) return '';
  // Take first sentence (up to . ! ? or newline)
  const match = text.match(/^[^\n.!?]{1,60}/);
  if (match) text = match[0].trim();
  // Capitalize first letter
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Summarize tool input for the tool log detail panel
function summarizeToolInput(toolInput, toolName) {
  if (!toolInput) return '';
  switch (toolName) {
    case 'Read': return toolInput.file_path || '';
    case 'Write': return toolInput.file_path || '';
    case 'Edit': return toolInput.file_path || '';
    case 'Bash': return (toolInput.command || '').substring(0, 120);
    case 'Grep': return `${toolInput.pattern || ''} in ${toolInput.path || 'cwd'}`;
    case 'Glob': return toolInput.pattern || '';
    case 'WebFetch': return toolInput.url || '';
    case 'Task': return toolInput.description || '';
    default: return JSON.stringify(toolInput).substring(0, 100);
  }
}

export function getSession(sessionId) {
  const s = sessions.get(sessionId);
  return s ? { ...s } : null;
}

export function killSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.status = 'ended';
  session.animationState = 'Death';
  session.archived = 1;
  try { updateSessionArchived.run(1, sessionId); } catch(e) {}
  session.lastActivityAt = Date.now();
  try { updateSessionEnded.run(Date.now(), Date.now(), sessionId); } catch(e) {}
  setTimeout(() => sessions.delete(sessionId), 10000);
  return { ...session };
}

export function setSessionTitle(sessionId, title) {
  const session = sessions.get(sessionId);
  if (session) session.title = title;
  try { updateSessionTitle.run(title, sessionId); } catch(e) {}
  return session ? { ...session } : null;
}

const updateSessionArchived = db.prepare('UPDATE sessions SET archived=? WHERE id=?');
export function archiveSession(sessionId, archived) {
  const session = sessions.get(sessionId);
  if (session) session.archived = archived ? 1 : 0;
  try { updateSessionArchived.run(archived ? 1 : 0, sessionId); } catch(e) {}
  return session ? { ...session } : null;
}

// Auto-idle: mark sessions as idle if no activity for a while
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.status === 'ended' || session.status === 'idle') continue;
    // 'approval' stays visible — never auto-clear (user must act)
    if (session.status === 'approval') continue;
    // 'waiting' (ready for next prompt) goes idle after 2 min of no activity
    if (session.status === 'waiting' && now - session.lastActivityAt > 120000) {
      session.status = 'idle';
      session.animationState = 'Idle';
      session.emote = null;
    // Other active states (prompting/working) go idle after 30s of silence
    } else if (session.status !== 'waiting' && now - session.lastActivityAt > 30000) {
      session.status = 'idle';
      session.animationState = 'Idle';
      session.emote = null;
    }
  }
}, 10000);

export function findClaudeProcess(sessionId) {
  try {
    const out = execSync(`ps aux | grep -v grep | grep claude | grep "${sessionId}"`, { encoding: 'utf-8', timeout: 5000 });
    const lines = out.trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      const parts = lines[0].trim().split(/\s+/);
      const pid = parseInt(parts[1], 10);
      if (pid > 0) return pid;
    }
  } catch(e) {}
  return null;
}

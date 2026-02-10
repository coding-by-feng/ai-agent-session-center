// sessionStore.js — In-memory session state machine with SQLite dual-write
import db from './db.js';
import { execSync } from 'child_process';

const sessions = new Map();
const projectSessionCounters = new Map();
const pendingToolTimers = new Map(); // session_id -> timeout for tool approval detection

// Team mode structures
const teams = new Map();            // teamId -> { teamId, parentSessionId, childSessionIds: Set, teamName, createdAt }
const sessionToTeam = new Map();    // sessionId -> teamId
const pendingSubagents = [];        // { parentSessionId, parentCwd, agentType, timestamp }

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

// Team mode prepared statements
const insertTeam = db.prepare(
  `INSERT OR IGNORE INTO teams (id, parent_session_id, team_name, created_at) VALUES (?, ?, ?, ?)`
);
const updateSessionTeam = db.prepare(
  `UPDATE sessions SET team_id=?, team_role=?, parent_session_id=? WHERE id=?`
);
const selectActiveTeams = db.prepare(
  `SELECT t.id, t.parent_session_id, t.team_name, t.created_at
   FROM teams t
   WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.team_id = t.id AND s.status != 'ended')`
);
const selectTeamMembers = db.prepare(
  `SELECT id, team_role FROM sessions WHERE team_id = ? AND status != 'ended'`
);

// Startup recovery: reload active sessions from DB into the Map
const selectActiveSessions = db.prepare(
  `SELECT id, project_path, project_name, model, status, started_at, last_activity_at, total_tool_calls, total_prompts, source, title, summary, character_model, accent_color
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
        source: row.source || 'unknown',
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
        archived: 0,
        summary: row.summary || null,
        characterModel: row.character_model || null,
        accentColor: row.accent_color || null
      });
    }
  } catch (err) {
    console.error('[sessionStore] Failed to load active sessions from DB:', err.message);
  }

  // Rebuild teams from DB
  try {
    const teamRows = selectActiveTeams.all();
    for (const tRow of teamRows) {
      const team = {
        teamId: tRow.id,
        parentSessionId: tRow.parent_session_id,
        childSessionIds: new Set(),
        teamName: tRow.team_name,
        createdAt: tRow.created_at
      };
      const memberRows = selectTeamMembers.all(tRow.id);
      for (const m of memberRows) {
        if (m.team_role === 'leader') {
          sessionToTeam.set(m.id, tRow.id);
          const s = sessions.get(m.id);
          if (s) { s.teamId = tRow.id; s.teamRole = 'leader'; }
        } else {
          team.childSessionIds.add(m.id);
          sessionToTeam.set(m.id, tRow.id);
          const s = sessions.get(m.id);
          if (s) { s.teamId = tRow.id; s.teamRole = 'member'; }
        }
      }
      teams.set(tRow.id, team);
    }
    if (teamRows.length > 0) {
      console.log(`[sessionStore] Rebuilt ${teamRows.length} active teams from DB`);
    }
  } catch (err) {
    console.error('[sessionStore] Failed to rebuild teams from DB:', err.message);
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
      source: hookData.source || 'unknown',
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
    case 'SessionStart': {
      session.status = 'idle';
      session.animationState = 'Idle';
      session.model = hookData.model || session.model;
      eventEntry.detail = `Session started (${hookData.source || 'startup'})`;
      // Try to match this new session as a subagent child
      const teamResult = findPendingSubagentMatch(session_id, session.projectPath);
      if (teamResult) {
        eventEntry.detail += ` [Team: ${teamResult.teamId}]`;
      }
      break;
    }

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
      // Tools that complete near-instantly when auto-approved (3s timeout)
      const fastTools = new Set([
        'Read', 'Write', 'Edit', 'Grep', 'Glob', 'NotebookEdit',
        'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion'
      ]);
      // Tools that may take longer but still indicate approval if stalled (15s timeout)
      const mediumTools = new Set([
        'WebFetch', 'WebSearch'
      ]);
      clearTimeout(pendingToolTimers.get(session_id));
      const approvalTimeout = fastTools.has(toolName) ? 3000
        : mediumTools.has(toolName) ? 15000
        : 0;
      if (approvalTimeout > 0) {
        session.pendingTool = toolName;
        session.pendingToolDetail = toolInputSummary;
        const timer = setTimeout(async () => {
          pendingToolTimers.delete(session_id);
          if (session.status === 'working' && session.pendingTool) {
            session.status = 'approval';
            session.animationState = 'Waiting';
            const detail = session.pendingToolDetail
              ? `${session.pendingTool}: ${session.pendingToolDetail}`
              : session.pendingTool;
            session.waitingDetail = `Approve ${detail}`;
            try {
              const { broadcast } = await import('./wsManager.js');
              broadcast({ type: 'session_update', session: { ...session } });
            } catch(e) {}
          }
        }, approvalTimeout);
        pendingToolTimers.set(session_id, timer);
      } else {
        session.pendingTool = null;
        session.pendingToolDetail = null;
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
      session.pendingToolDetail = null;
      session.waitingDetail = null;
      session.status = 'working';
      eventEntry.detail = `${hookData.tool_name || 'Tool'} completed`;
      break;

    case 'Stop': {
      // Clear any pending tool approval timer
      clearTimeout(pendingToolTimers.get(session_id));
      pendingToolTimers.delete(session_id);
      session.pendingTool = null;
      session.pendingToolDetail = null;
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
      // Track pending subagent for team auto-detection
      pendingSubagents.push({
        parentSessionId: session_id,
        parentCwd: session.projectPath,
        agentType: hookData.agent_type || 'unknown',
        timestamp: Date.now()
      });
      // Prune stale entries (>30s old)
      const now_sub = Date.now();
      while (pendingSubagents.length > 0 && now_sub - pendingSubagents[0].timestamp > 30000) {
        pendingSubagents.shift();
      }
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

      // Team cleanup: remove from team, clean up if empty
      handleTeamMemberEnd(session_id);

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

  const result = { session: { ...session } };
  // Include team info if session belongs to a team
  const teamId = sessionToTeam.get(session_id);
  if (teamId) {
    result.team = serializeTeam(teams.get(teamId));
  }
  return result;
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

// ---- Team Mode Functions ----

function findPendingSubagentMatch(childSessionId, childCwd) {
  const now = Date.now();
  // Clean stale entries (>10s old)
  while (pendingSubagents.length > 0 && now - pendingSubagents[0].timestamp > 10000) {
    pendingSubagents.shift();
  }
  if (!childCwd || pendingSubagents.length === 0) return null;

  // Match by cwd — exact match or parent/child path relationship
  for (let i = pendingSubagents.length - 1; i >= 0; i--) {
    const pending = pendingSubagents[i];
    if (pending.parentSessionId === childSessionId) continue; // skip self
    const parentCwd = pending.parentCwd;
    if (parentCwd && (childCwd === parentCwd || childCwd.startsWith(parentCwd + '/') || parentCwd.startsWith(childCwd + '/'))) {
      // Found match — consume it
      pendingSubagents.splice(i, 1);
      return linkSessionToTeam(pending.parentSessionId, childSessionId, pending.agentType);
    }
  }
  return null;
}

function linkSessionToTeam(parentId, childId, agentType) {
  const teamId = `team-${parentId}`;
  let team = teams.get(teamId);

  if (!team) {
    team = {
      teamId,
      parentSessionId: parentId,
      childSessionIds: new Set(),
      teamName: null,
      createdAt: Date.now()
    };
    teams.set(teamId, team);

    // Set team name from parent's project name
    const parentSession = sessions.get(parentId);
    if (parentSession) {
      team.teamName = `${parentSession.projectName} Team`;
      parentSession.teamId = teamId;
      parentSession.teamRole = 'leader';
      sessionToTeam.set(parentId, teamId);
      try { updateSessionTeam.run(teamId, 'leader', null, parentId); } catch(e) {}
    }

    // DB insert team
    try { insertTeam.run(teamId, parentId, team.teamName, team.createdAt); } catch(e) {}
  }

  // Link child
  team.childSessionIds.add(childId);
  const childSession = sessions.get(childId);
  if (childSession) {
    childSession.teamId = teamId;
    childSession.teamRole = 'member';
    childSession.agentType = agentType;
  }
  sessionToTeam.set(childId, teamId);
  try { updateSessionTeam.run(teamId, 'member', parentId, childId); } catch(e) {}

  console.log(`[sessionStore] Linked session ${childId} to team ${teamId} as ${agentType}`);
  return { teamId, team: serializeTeam(team) };
}

function handleTeamMemberEnd(sessionId) {
  const teamId = sessionToTeam.get(sessionId);
  if (!teamId) return null;

  const team = teams.get(teamId);
  if (!team) return null;

  team.childSessionIds.delete(sessionId);
  sessionToTeam.delete(sessionId);

  // If parent ended and all children ended, clean up the team
  if (sessionId === team.parentSessionId) {
    const parentSession = sessions.get(sessionId);
    const allChildrenEnded = [...team.childSessionIds].every(cid => {
      const s = sessions.get(cid);
      return !s || s.status === 'ended';
    });
    if (allChildrenEnded) {
      // Clean up team after a delay
      setTimeout(() => {
        teams.delete(teamId);
        sessionToTeam.delete(team.parentSessionId);
        for (const cid of team.childSessionIds) {
          sessionToTeam.delete(cid);
        }
      }, 15000);
    }
  }

  return { teamId, team: serializeTeam(team) };
}

function serializeTeam(team) {
  if (!team) return null;
  return {
    teamId: team.teamId,
    parentSessionId: team.parentSessionId,
    childSessionIds: [...team.childSessionIds],
    teamName: team.teamName,
    createdAt: team.createdAt
  };
}

export function getTeam(teamId) {
  const team = teams.get(teamId);
  return team ? serializeTeam(team) : null;
}

export function getAllTeams() {
  const result = {};
  for (const [id, team] of teams) {
    result[id] = serializeTeam(team);
  }
  return result;
}

export function getTeamForSession(sessionId) {
  const teamId = sessionToTeam.get(sessionId);
  if (!teamId) return null;
  return getTeam(teamId);
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

const updateSessionSummary = db.prepare('UPDATE sessions SET summary=? WHERE id=?');
export function setSummary(sessionId, summary) {
  const session = sessions.get(sessionId);
  if (session) session.summary = summary;
  try { updateSessionSummary.run(summary, sessionId); } catch(e) {}
  return session ? { ...session } : null;
}

const updateSessionAccentColor = db.prepare('UPDATE sessions SET accent_color=? WHERE id=?');
export function setSessionAccentColor(sessionId, color) {
  const session = sessions.get(sessionId);
  if (session) session.accentColor = color;
  try { updateSessionAccentColor.run(color, sessionId); } catch(e) {}
}

const updateSessionCharModel = db.prepare('UPDATE sessions SET character_model=? WHERE id=?');
export function setSessionCharacterModel(sessionId, model) {
  const session = sessions.get(sessionId);
  if (session) session.characterModel = model;
  try { updateSessionCharModel.run(model, sessionId); } catch(e) {}
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
    // 'prompting' is a brief transitional state — if stuck for 30s, user likely
    // pressed Esc/cancelled before Claude started processing (no Stop hook fires)
    if (session.status === 'prompting' && now - session.lastActivityAt > 30000) {
      session.status = 'waiting';
      session.animationState = 'Waiting';
      session.emote = null;
    // 'waiting' (ready for next prompt) goes idle after 2 min of no activity
    } else if (session.status === 'waiting' && now - session.lastActivityAt > 120000) {
      session.status = 'idle';
      session.animationState = 'Idle';
      session.emote = null;
    // Other active states (working) go idle after 3 min of silence
    // Claude can think/generate text for a long time between tool calls
    } else if (session.status !== 'waiting' && session.status !== 'prompting' && now - session.lastActivityAt > 180000) {
      session.status = 'idle';
      session.animationState = 'Idle';
      session.emote = null;
    }
  }
}, 10000);

// Detect whether session is from VS Code, JetBrains, or terminal, cache result
export function detectSessionSource(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return 'unknown';
  if (session.source === 'vscode' || session.source === 'terminal' || session.source === 'jetbrains') return session.source;

  const pid = findClaudeProcess(sessionId, session.projectPath);
  if (pid) {
    try {
      const cmd = execSync(`ps -o args= -p ${pid}`, { encoding: 'utf-8', timeout: 3000 }).trim();
      if (cmd.includes('.vscode') || cmd.includes('--no-chrome') || cmd.includes('stream-json')) {
        session.source = 'vscode';
      } else if (isJetBrainsProcess(pid)) {
        session.source = 'jetbrains';
      } else {
        session.source = 'terminal';
      }
    } catch(e) { /* keep existing */ }
  }
  return session.source || 'unknown';
}

// Check if a process is spawned from a JetBrains IDE by walking the process tree
function isJetBrainsProcess(pid) {
  const jbNames = ['idea', 'webstorm', 'pycharm', 'goland', 'clion', 'rider',
    'phpstorm', 'rubymine', 'datagrip', 'dataspell', 'fleet', 'jetbrains',
    'appcode', 'aqua', 'writerside'];
  try {
    let current = String(pid);
    for (let i = 0; i < 10; i++) {
      const ppid = execSync(`ps -o ppid= -p ${current}`, { encoding: 'utf-8', timeout: 3000 }).trim();
      if (!ppid || ppid === '0' || ppid === '1') break;
      const cmd = execSync(`ps -o comm= -p ${ppid}`, { encoding: 'utf-8', timeout: 3000 }).trim().toLowerCase();
      if (jbNames.some(n => cmd.includes(n))) return true;
      current = ppid;
    }
  } catch(e) {}
  return false;
}

export function findClaudeProcess(sessionId, projectPath) {
  const myPid = process.pid;
  try {
    if (process.platform === 'win32') {
      // Windows: find Claude processes by cwd matching
      if (!projectPath) return null;
      const psScript = `
        $procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*claude*' -and $_.ProcessId -ne ${myPid} }
        foreach ($p in $procs) {
          try {
            $proc = Get-Process -Id $p.ProcessId -ErrorAction Stop
            if ($proc.Path) {
              $cwd = (Get-Process -Id $p.ProcessId).Path | Split-Path
            }
          } catch {}
        }
        # Fallback: return first claude process
        if ($procs.Count -gt 0) { $procs[0].ProcessId }
      `;
      const out = execSync(
        `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      const pid = parseInt(out.trim(), 10);
      return pid > 0 ? pid : null;
    } else {
      // Unix (macOS / Linux): find Claude processes and match by cwd
      const pidsOut = execSync(`pgrep -f claude 2>/dev/null || true`, { encoding: 'utf-8', timeout: 5000 });
      const pids = pidsOut.trim().split('\n')
        .map(p => parseInt(p.trim(), 10))
        .filter(p => p > 0 && p !== myPid);

      if (pids.length === 0) return null;

      // If we have a projectPath, match by cwd
      if (projectPath) {
        for (const pid of pids) {
          try {
            let cwd;
            if (process.platform === 'darwin') {
              const out = execSync(`lsof -a -d cwd -Fn -p ${pid} 2>/dev/null | grep '^n'`, { encoding: 'utf-8', timeout: 3000 });
              cwd = out.trim().replace(/^n/, '');
            } else {
              // Linux: read /proc/PID/cwd symlink
              cwd = execSync(`readlink /proc/${pid}/cwd 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 }).trim();
            }
            if (cwd === projectPath) return pid;
          } catch(e) { continue; }
        }
      }

      // Fallback: return first terminal-attached Claude process
      for (const pid of pids) {
        try {
          const tty = execSync(`ps -o tty= -p ${pid}`, { encoding: 'utf-8', timeout: 3000 }).trim();
          if (tty && tty !== '??' && tty !== '?') return pid;
        } catch(e) { continue; }
      }

      return pids[0] || null;
    }
  } catch(e) {}
  return null;
}

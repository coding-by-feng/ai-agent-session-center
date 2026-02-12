// @ts-check
// sessionStore.js — In-memory session state machine (coordinator)
// Delegates to sub-modules: sessionMatcher, approvalDetector, teamManager, processMonitor, autoIdleManager
//
// Session State Machine:
//   SessionStart    → idle    (Idle animation)
//   UserPromptSubmit → prompting (Wave + Walking)
//   PreToolUse      → working  (Running)
//   PostToolUse     → working  (stays)
//   PermissionRequest → approval (Waiting)
//   Stop            → waiting  (ThumbsUp/Dance + Waiting)
//   SessionEnd      → ended   (Death, removed after 10s)
import { homedir } from 'os';
import log from './logger.js';
import { getWaitingLabel } from './config.js';
import {
  EVENT_TYPES, SESSION_STATUS, ANIMATION_STATE, EMOTE, WS_TYPES,
} from './constants.js';

// Sub-module imports
import { matchSession, detectHookSource } from './sessionMatcher.js';
import { startApprovalTimer, clearApprovalTimer, hasChildProcesses } from './approvalDetector.js';
import {
  findPendingSubagentMatch, handleTeamMemberEnd, addPendingSubagent,
  linkByParentSessionId,
  getTeam, getAllTeams, getTeamForSession, getTeamIdForSession,
} from './teamManager.js';
import { startMonitoring, stopMonitoring, findClaudeProcess as _findClaudeProcess } from './processMonitor.js';
import { startAutoIdle, stopAutoIdle, startPendingResumeCleanup, stopPendingResumeCleanup } from './autoIdleManager.js';

/** @type {Map<string, import('../types/session').Session>} */
const sessions = new Map();
/** @type {Map<string, number>} */
const projectSessionCounters = new Map();
/** @type {Map<number, string>} pid -> sessionId — ensures each PID is only assigned to one session */
const pidToSession = new Map();
/** @type {Map<string, { oldSessionId: string, timestamp: number }>} terminalId -> pending resume info */
const pendingResume = new Map();

// Serialization cache for getAllSessions() — invalidated on any session change
let sessionsCacheDirty = true;
let sessionsCache = null;

function invalidateSessionsCache() {
  sessionsCacheDirty = true;
  sessionsCache = null;
}

// Event ring buffer for reconnect replay
const EVENT_BUFFER_MAX = 500;
let eventSeq = 0;
/** @type {import('../types/session').BufferedEvent[]} */
const eventBuffer = [];

/**
 * Push an event to the ring buffer for WebSocket reconnect replay.
 * @param {string} type - WebSocket message type
 * @param {unknown} data - Event payload
 * @returns {number} The new sequence number
 */
export function pushEvent(type, data) {
  eventSeq++;
  eventBuffer.push({ seq: eventSeq, type, data, timestamp: Date.now() });
  if (eventBuffer.length > EVENT_BUFFER_MAX) eventBuffer.shift();
  return eventSeq;
}

/**
 * @param {number} sinceSeq
 * @returns {import('../types/session').BufferedEvent[]}
 */
export function getEventsSince(sinceSeq) {
  return eventBuffer.filter(e => e.seq > sinceSeq);
}

export function getEventSeq() {
  return eventSeq;
}

export function loadActiveSessions() {
  // No-op: no database to load from. Sessions are populated from hooks at runtime.
  // Browser IndexedDB is the persistence layer — it loads history on page open.
}

// Load active sessions at module init
loadActiveSessions();

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

// Async broadcast helper — lazy imports wsManager to avoid circular deps
async function broadcastAsync(data) {
  const { broadcast } = await import('./wsManager.js');
  broadcast(data);
}

// Debounced broadcast — batches rapid state changes within 50ms window
const BROADCAST_DEBOUNCE_MS = 50;
let pendingBroadcasts = [];
let broadcastDebounceTimer = null;

async function debouncedBroadcast(data) {
  pendingBroadcasts.push(data);
  if (broadcastDebounceTimer) return;
  broadcastDebounceTimer = setTimeout(async () => {
    const batch = pendingBroadcasts;
    pendingBroadcasts = [];
    broadcastDebounceTimer = null;
    // Deduplicate: for session_update, keep only the latest per sessionId
    const seen = new Map();
    for (const item of batch) {
      if (item.type === WS_TYPES.SESSION_UPDATE && item.session?.sessionId) {
        seen.set(item.session.sessionId, item);
      } else {
        // Non-session updates get a unique key to ensure they're sent
        seen.set(`${item.type}_${Date.now()}_${Math.random()}`, item);
      }
    }
    for (const item of seen.values()) {
      await broadcastAsync(item);
    }
  }, BROADCAST_DEBOUNCE_MS);
}

// Broadcast helper for approval timer
async function broadcastSessionUpdate(session) {
  await debouncedBroadcast({ type: WS_TYPES.SESSION_UPDATE, session: { ...session } });
}

/**
 * Process an incoming hook event, updating the session state machine.
 * @param {import('../types/hook').HookPayload} hookData
 * @returns {import('../types/session').HandleEventResult | null}
 */
export function handleEvent(hookData) {
  const { session_id, hook_event_name, cwd } = hookData;
  if (!session_id) return null;

  if (hookData.claude_pid) {
    const env = [
      `pid=${hookData.claude_pid}`,
      hookData.tty_path ? `tty=${hookData.tty_path}` : null,
      hookData.term_program ? `term=${hookData.term_program}` : null,
      hookData.tab_id ? `tab=${hookData.tab_id}` : null,
      hookData.vscode_pid ? `vscode_pid=${hookData.vscode_pid}` : null,
      hookData.tmux ? `tmux=${hookData.tmux.pane}` : null,
      hookData.window_id ? `x11win=${hookData.window_id}` : null,
    ].filter(Boolean).join(' ');
    log.info('session', `event=${hook_event_name} session=${session_id?.slice(0,8)} ${env}`);
  } else {
    log.info('session', `event=${hook_event_name} session=${session_id?.slice(0,8)} cwd=${cwd || 'none'}`);
  }
  log.debugJson('session', 'Full hook data', hookData);

  // Match or create session (delegated to sessionMatcher)
  const session = matchSession(hookData, sessions, pendingResume, pidToSession, projectSessionCounters);

  invalidateSessionsCache();
  session.lastActivityAt = Date.now();
  const eventEntry = {
    type: hook_event_name,
    timestamp: Date.now(),
    detail: ''
  };

  switch (hook_event_name) {
    case EVENT_TYPES.SESSION_START: {
      session.status = SESSION_STATUS.IDLE;
      session.animationState = ANIMATION_STATE.IDLE;
      session.model = hookData.model || session.model;
      if (hookData.transcript_path) session.transcriptPath = hookData.transcript_path;
      if (hookData.permission_mode) session.permissionMode = hookData.permission_mode;
      eventEntry.detail = `Session started (${hookData.source || 'startup'})`;
      log.debug('session', `SessionStart: ${session_id?.slice(0,8)} project=${session.projectName} model=${session.model}`);

      // Priority 0: Direct link via CLAUDE_CODE_PARENT_SESSION_ID env var
      let teamResult = null;
      if (hookData.parent_session_id) {
        teamResult = linkByParentSessionId(
          session_id,
          hookData.parent_session_id,
          hookData.agent_type || 'unknown',
          hookData.agent_name || null,
          hookData.team_name || null,
          sessions
        );
        if (teamResult) {
          eventEntry.detail += ` [Team: ${teamResult.teamId} via env]`;
          log.debug('session', `Subagent linked to team ${teamResult.teamId} via parent_session_id`);
        }
      }

      // Fallback: path-based pending subagent matching (backward compatible)
      if (!teamResult) {
        teamResult = findPendingSubagentMatch(session_id, session.projectPath, sessions);
        if (teamResult) {
          eventEntry.detail += ` [Team: ${teamResult.teamId}]`;
          log.debug('session', `Subagent matched to team ${teamResult.teamId}`);
        }
      }
      break;
    }

    case EVENT_TYPES.USER_PROMPT_SUBMIT:
      session.status = SESSION_STATUS.PROMPTING;
      session.animationState = ANIMATION_STATE.WALKING;
      session.emote = EMOTE.WAVE;
      session.currentPrompt = hookData.prompt || '';
      session.promptHistory.push({
        text: hookData.prompt || '',
        timestamp: Date.now()
      });
      // Keep last 50 prompts
      if (session.promptHistory.length > 50) session.promptHistory.shift();
      eventEntry.detail = (hookData.prompt || '').substring(0, 80);

      // Auto-generate title from project name + label + counter + short prompt summary
      if (!session.title) {
        const counter = projectSessionCounters.get(session.projectName) || 1;
        const labelPart = session.label ? ` ${session.label}` : '';
        const shortPrompt = makeShortTitle(hookData.prompt || '');
        session.title = shortPrompt
          ? `${session.projectName}${labelPart} #${counter} — ${shortPrompt}`
          : `${session.projectName}${labelPart} — Session #${counter}`;
      }
      break;

    case EVENT_TYPES.PRE_TOOL_USE: {
      session.status = SESSION_STATUS.WORKING;
      session.animationState = ANIMATION_STATE.RUNNING;
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

      // Approval/input detection via timer (delegated to approvalDetector)
      startApprovalTimer(session_id, session, toolName, toolInputSummary, broadcastSessionUpdate);
      break;
    }

    case EVENT_TYPES.POST_TOOL_USE:
      // Tool completed — cancel approval timer, stay working
      clearApprovalTimer(session_id, session);
      session.status = SESSION_STATUS.WORKING;
      eventEntry.detail = `${hookData.tool_name || 'Tool'} completed`;
      break;

    case EVENT_TYPES.STOP: {
      // Clear any pending tool approval timer
      clearApprovalTimer(session_id, session);

      const wasHeavyWork = session.totalToolCalls > 10 &&
        session.status === SESSION_STATUS.WORKING;
      // Session finished its turn — waiting for user's next prompt
      session.status = SESSION_STATUS.WAITING;
      if (wasHeavyWork) {
        session.animationState = ANIMATION_STATE.DANCE;
        session.emote = null;
      } else {
        session.animationState = ANIMATION_STATE.WAITING;
        session.emote = EMOTE.THUMBS_UP;
      }
      eventEntry.detail = wasHeavyWork ? 'Heavy work done — ready for input' : 'Ready for your input';

      // Store response if present — try multiple possible field names
      const responseText = hookData.response || hookData.message || hookData.stop_reason_str || '';
      if (responseText) {
        const excerpt = responseText.substring(0, 2000);
        session.responseLog.push({ text: excerpt, timestamp: Date.now() });
        if (session.responseLog.length > 50) session.responseLog.shift();
      }

      // Reset tool counter for next turn
      session.totalToolCalls = 0;
      break;
    }

    case EVENT_TYPES.SUBAGENT_START:
      session.subagentCount++;
      session.emote = EMOTE.JUMP;
      eventEntry.detail = `Subagent spawned (${hookData.agent_type || 'unknown'}${hookData.agent_name ? ' ' + hookData.agent_name : ''}${hookData.agent_id ? ' #' + hookData.agent_id.slice(0, 8) : ''})`;
      // Store agent name on session if available from enriched hook
      if (hookData.agent_name) {
        session.lastSubagentName = hookData.agent_name;
      }
      // Track pending subagent for team auto-detection (delegated to teamManager)
      addPendingSubagent(session_id, session.projectPath, hookData.agent_type, hookData.agent_id);
      break;

    case EVENT_TYPES.SUBAGENT_STOP:
      session.subagentCount = Math.max(0, session.subagentCount - 1);
      eventEntry.detail = `Subagent finished`;
      break;

    case EVENT_TYPES.PERMISSION_REQUEST: {
      // Real signal that user approval is needed — replaces timeout-based heuristic
      clearApprovalTimer(session_id, session);
      const permTool = hookData.tool_name || session.pendingTool || 'Unknown';
      session.status = SESSION_STATUS.APPROVAL;
      session.animationState = ANIMATION_STATE.WAITING;
      session.waitingDetail = hookData.tool_input
        ? `Approve ${permTool}: ${summarizeToolInput(hookData.tool_input, permTool)}`
        : `Approve ${permTool}`;
      session.permissionMode = hookData.permission_mode || null;
      eventEntry.detail = `Permission request: ${permTool}`;
      break;
    }

    case EVENT_TYPES.POST_TOOL_USE_FAILURE: {
      // Tool call failed — cancel approval timer, mark the failure in tool log
      clearApprovalTimer(session_id, session);
      session.status = SESSION_STATUS.WORKING;
      const failedTool = hookData.tool_name || 'Tool';
      // Mark last tool log entry as failed if it matches
      if (session.toolLog.length > 0) {
        const lastEntry = session.toolLog[session.toolLog.length - 1];
        if (lastEntry.tool === failedTool && !lastEntry.failed) {
          lastEntry.failed = true;
          lastEntry.error = hookData.error || hookData.message || 'Failed';
        }
      }
      eventEntry.detail = `${failedTool} failed${hookData.error ? ': ' + hookData.error.substring(0, 80) : ''}`;
      break;
    }

    case EVENT_TYPES.TEAMMATE_IDLE:
      eventEntry.detail = `Teammate idle: ${hookData.agent_name || hookData.agent_id || 'unknown'}`;
      break;

    case EVENT_TYPES.TASK_COMPLETED:
      eventEntry.detail = `Task completed: ${hookData.task_description || hookData.task_id || 'unknown'}`;
      session.emote = EMOTE.THUMBS_UP;
      break;

    case EVENT_TYPES.PRE_COMPACT:
      eventEntry.detail = 'Context compaction starting';
      break;

    case EVENT_TYPES.NOTIFICATION:
      eventEntry.detail = hookData.message || hookData.title || 'Notification';
      break;

    case EVENT_TYPES.SESSION_END:
      session.status = SESSION_STATUS.ENDED;
      session.animationState = ANIMATION_STATE.DEATH;
      session.endedAt = Date.now();
      eventEntry.detail = `Session ended (${hookData.reason || 'unknown'})`;

      // Release PID cache for this session
      if (session.cachedPid) {
        log.debug('session', `releasing pid=${session.cachedPid} from session=${session_id?.slice(0,8)}`);
        pidToSession.delete(session.cachedPid);
        session.cachedPid = null;
      }

      // Team cleanup (delegated to teamManager)
      handleTeamMemberEnd(session_id, sessions);

      // SSH sessions: keep in memory as historical (disconnected), preserve terminal ref for resume
      if (session.source === 'ssh') {
        session.isHistorical = true;
        session.lastTerminalId = session.terminalId;
        session.terminalId = null;
      } else {
        setTimeout(() => sessions.delete(session_id), 10000);
      }
      break;
  }

  // Keep last 50 events
  session.events.push(eventEntry);
  if (session.events.length > 50) session.events.shift();

  const result = { session: { ...session } };
  // Clean up one-time re-key flag
  delete session.replacesId;
  // Include team info if session belongs to a team
  const teamId = getTeamIdForSession(session_id);
  if (teamId) {
    result.team = getTeam(teamId);
  }

  // Push to ring buffer for reconnect replay
  pushEvent(WS_TYPES.SESSION_UPDATE, result);

  return result;
}

/** @returns {Record<string, import('../types/session').Session>} */
export function getAllSessions() {
  if (!sessionsCacheDirty && sessionsCache) {
    return sessionsCache;
  }
  const result = {};
  for (const [id, session] of sessions) {
    result[id] = { ...session };
  }
  sessionsCache = result;
  sessionsCacheDirty = false;
  return result;
}

/**
 * @param {string} sessionId
 * @returns {import('../types/session').Session | null}
 */
export function getSession(sessionId) {
  const s = sessions.get(sessionId);
  return s ? { ...s } : null;
}

/**
 * Create a session card immediately when SSH terminal connects (before hooks arrive).
 * @param {string} terminalId
 * @param {import('../types/api').CreateTerminalRequest} config
 * @returns {Promise<import('../types/session').Session>}
 */
export async function createTerminalSession(terminalId, config) {
  const workDir = config.workingDir
    ? (config.workingDir.startsWith('~') ? config.workingDir.replace(/^~/, homedir()) : config.workingDir)
    : homedir();
  const projectName = workDir === homedir() ? 'Home' : workDir.split('/').filter(Boolean).pop() || 'SSH Session';
  // Build default title: projectName + label + counter
  let defaultTitle = `${config.host || 'localhost'}:${workDir}`;
  if (!config.sessionTitle && config.label) {
    const counter = (projectSessionCounters.get(projectName) || 0) + 1;
    projectSessionCounters.set(projectName, counter);
    defaultTitle = `${projectName} ${config.label} #${counter}`;
  }
  const session = {
    sessionId: terminalId,
    projectPath: workDir,
    projectName,
    label: config.label || '',
    title: config.sessionTitle || defaultTitle,
    status: SESSION_STATUS.CONNECTING,
    animationState: ANIMATION_STATE.WALKING,
    emote: EMOTE.WAVE,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    currentPrompt: '',
    promptHistory: [],
    toolUsage: {},
    totalToolCalls: 0,
    model: '',
    subagentCount: 0,
    toolLog: [],
    responseLog: [],
    events: [{ type: 'TerminalCreated', detail: `SSH → ${config.host || 'localhost'}`, timestamp: Date.now() }],
    archived: 0,
    source: 'ssh',
    pendingTool: null,
    waitingDetail: null,
    cachedPid: null,
    queueCount: 0,
    terminalId,
    sshHost: config.host || 'localhost',
    sshCommand: config.command || 'claude',
  };
  sessions.set(terminalId, session);
  invalidateSessionsCache();

  log.info('session', `Created terminal session ${terminalId} → ${config.host}:${workDir}`);

  await broadcastAsync({ type: WS_TYPES.SESSION_UPDATE, session: { ...session } });

  // Non-Claude CLIs (codex, gemini, etc.) don't send hooks — auto-transition to idle
  const command = config.command || 'claude';
  if (!command.startsWith('claude')) {
    setTimeout(async () => {
      const s = sessions.get(terminalId);
      if (s && s.status === SESSION_STATUS.CONNECTING) {
        s.status = SESSION_STATUS.IDLE;
        s.animationState = ANIMATION_STATE.IDLE;
        s.emote = null;
        s.model = command; // Show command name as model
        await broadcastAsync({ type: WS_TYPES.SESSION_UPDATE, session: { ...s } });
        log.info('session', `Auto-transitioned non-Claude session ${terminalId} to idle (${command})`);
      }
    }, 3000);
  }

  return session;
}

/**
 * @param {string} sessionId
 * @param {string} terminalId
 * @returns {import('../types/session').Session | null}
 */
export function linkTerminalToSession(sessionId, terminalId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.terminalId = terminalId;
  invalidateSessionsCache();
  return { ...session };
}

export function updateQueueCount(sessionId, count) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.queueCount = count || 0;
  invalidateSessionsCache();
  return { ...session };
}

/**
 * @param {string} sessionId
 * @returns {import('../types/session').Session | null}
 */
export function killSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  invalidateSessionsCache();
  session.status = SESSION_STATUS.ENDED;
  session.animationState = ANIMATION_STATE.DEATH;
  session.archived = 1;
  session.lastActivityAt = Date.now();
  session.endedAt = Date.now();
  // SSH sessions: keep in memory as historical (disconnected), preserve terminal ref for resume
  if (session.source === 'ssh') {
    session.isHistorical = true;
    session.lastTerminalId = session.terminalId;
    session.terminalId = null;
  } else {
    setTimeout(() => sessions.delete(sessionId), 10000);
  }
  return { ...session };
}

export function deleteSessionFromMemory(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  // Release PID cache
  if (session.cachedPid) {
    pidToSession.delete(session.cachedPid);
  }
  // Team cleanup
  handleTeamMemberEnd(sessionId, sessions);
  sessions.delete(sessionId);
  invalidateSessionsCache();
  return true;
}

export function setSessionTitle(sessionId, title) {
  const session = sessions.get(sessionId);
  if (session) { session.title = title; invalidateSessionsCache(); }
  return session ? { ...session } : null;
}

export function setSessionLabel(sessionId, label) {
  const session = sessions.get(sessionId);
  if (session) { session.label = label; invalidateSessionsCache(); }
  return session ? { ...session } : null;
}

export function setSummary(sessionId, summary) {
  const session = sessions.get(sessionId);
  if (session) { session.summary = summary; invalidateSessionsCache(); }
  return session ? { ...session } : null;
}

export function setSessionAccentColor(sessionId, color) {
  const session = sessions.get(sessionId);
  if (session) { session.accentColor = color; invalidateSessionsCache(); }
}

export function setSessionCharacterModel(sessionId, model) {
  const session = sessions.get(sessionId);
  if (session) { session.characterModel = model; invalidateSessionsCache(); }
  return session ? { ...session } : null;
}

export function archiveSession(sessionId, archived) {
  const session = sessions.get(sessionId);
  if (session) { session.archived = archived ? 1 : 0; invalidateSessionsCache(); }
  return session ? { ...session } : null;
}

/**
 * Resume a disconnected SSH session — sends claude --resume to its terminal.
 * @param {string} sessionId
 * @returns {{ error: string } | { ok: true, terminalId: string, session: import('../types/session').Session }}
 */
export function resumeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { error: 'Session not found' };
  if (session.status !== SESSION_STATUS.ENDED) return { error: 'Session is not ended' };
  if (!session.lastTerminalId) return { error: 'No terminal associated with this session' };

  // Archive current session data into previousSessions array
  if (!session.previousSessions) session.previousSessions = [];
  session.previousSessions.push({
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    promptHistory: [...session.promptHistory],
    toolLog: [...(session.toolLog || [])],
    responseLog: [...(session.responseLog || [])],
    events: [...session.events],
    toolUsage: { ...session.toolUsage },
    totalToolCalls: session.totalToolCalls,
  });
  // Cap to prevent unbounded growth (each entry can hold hundreds of log items)
  if (session.previousSessions.length > 5) session.previousSessions.shift();

  // Register pending resume
  pendingResume.set(session.lastTerminalId, {
    oldSessionId: sessionId,
    timestamp: Date.now(),
  });

  // Restore terminal link and transition to connecting
  session.terminalId = session.lastTerminalId;
  session.status = SESSION_STATUS.CONNECTING;
  session.animationState = ANIMATION_STATE.WALKING;
  session.emote = EMOTE.WAVE;
  session.isHistorical = false;
  session.lastActivityAt = Date.now();
  invalidateSessionsCache();

  session.events.push({
    type: 'ResumeRequested',
    timestamp: Date.now(),
    detail: 'Resume requested by user',
  });

  log.info('session', `RESUME: session ${sessionId?.slice(0,8)} → connecting (terminal=${session.lastTerminalId?.slice(0,8)})`);

  return { ok: true, terminalId: session.lastTerminalId, session: { ...session } };
}

export function detectSessionSource(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return 'unknown';
  return session.source || 'ssh';
}

// Wrapper for findClaudeProcess that passes internal state
export function findClaudeProcess(sessionId, projectPath) {
  return _findClaudeProcess(sessionId, projectPath, sessions, pidToSession);
}

// ---- Start background monitors ----

// Auto-idle transitions
startAutoIdle(sessions);

// Process liveness monitoring
startMonitoring(
  sessions,
  pidToSession,
  clearApprovalTimer,
  (sid) => handleTeamMemberEnd(sid, sessions),
  broadcastAsync
);

// Clean up stale pendingResume entries
startPendingResumeCleanup(pendingResume, sessions, broadcastAsync);

// ---- Re-exports from sub-modules for backward compatibility ----
// External files (apiRouter, wsManager, hookProcessor, index) should not need to change their imports
export { getAllTeams, getTeam, getTeamForSession } from './teamManager.js';
export { hasChildProcesses } from './approvalDetector.js';

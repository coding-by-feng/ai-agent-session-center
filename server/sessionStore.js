// sessionStore.js — In-memory session state machine (no database)
import { execSync } from 'child_process';
import { homedir } from 'os';
import log from './logger.js';
import { getToolTimeout, getToolCategory, getWaitingStatus, getWaitingLabel, AUTO_IDLE_TIMEOUTS, PROCESS_CHECK_INTERVAL } from './config.js';
import { tryLinkByWorkDir, getTerminalForSession, getTerminalByPtyChild } from './sshManager.js';

const sessions = new Map();
const projectSessionCounters = new Map();
const pendingToolTimers = new Map(); // session_id -> timeout for tool approval detection
const pidToSession = new Map();      // pid -> sessionId — ensures each PID is only assigned to one session
const pendingResume = new Map();     // terminalId -> { oldSessionId, timestamp }

// Team mode structures
const teams = new Map();            // teamId -> { teamId, parentSessionId, childSessionIds: Set, teamName, createdAt }
const sessionToTeam = new Map();    // sessionId -> teamId
const pendingSubagents = [];        // { parentSessionId, parentCwd, agentType, timestamp }

// Event ring buffer for reconnect replay
const EVENT_BUFFER_MAX = 500;
let eventSeq = 0;
const eventBuffer = []; // { seq, type, data, timestamp }

export function pushEvent(type, data) {
  eventSeq++;
  eventBuffer.push({ seq: eventSeq, type, data, timestamp: Date.now() });
  if (eventBuffer.length > EVENT_BUFFER_MAX) eventBuffer.shift();
  return eventSeq;
}

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

// Re-key a resumed session: transfer from old sessionId to new, reset state for fresh session.
// Note: previousSessions is intentionally preserved (not reset) to maintain history chain.
function reKeyResumedSession(oldSession, newSessionId, oldSessionId) {
  sessions.delete(oldSessionId);
  oldSession.replacesId = oldSessionId;
  oldSession.sessionId = newSessionId;
  oldSession.status = 'idle';
  oldSession.animationState = 'Idle';
  oldSession.emote = null;
  oldSession.startedAt = Date.now();
  oldSession.endedAt = null;
  oldSession.isHistorical = false;
  oldSession.currentPrompt = '';
  oldSession.totalToolCalls = 0;
  oldSession.toolUsage = {};
  oldSession.promptHistory = [];
  oldSession.toolLog = [];
  oldSession.responseLog = [];
  oldSession.events = [{ type: 'SessionResumed', timestamp: Date.now(), detail: `Resumed from ${oldSessionId?.slice(0,8)}` }];
  sessions.set(newSessionId, oldSession);
  return oldSession;
}

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

  let session = sessions.get(session_id);

  // Cache all process/tab info from hook's enriched environment data
  if (hookData.claude_pid) {
    const pid = Number(hookData.claude_pid);
    if (pid > 0 && session && session.cachedPid !== pid) {
      if (session.cachedPid) pidToSession.delete(session.cachedPid);
      session.cachedPid = pid;
      pidToSession.set(pid, session_id);
      console.log(`[hook] CACHED pid=${pid} → session=${session_id?.slice(0,8)}`);
    }
  }

  // Create session if new — ONLY when linked to an SSH terminal
  if (!session) {
    // Priority 0: Check if this new session matches a pending resume request
    if (hook_event_name === 'SessionStart') {
      const termId = hookData.agent_terminal_id;
      // Match by agent_terminal_id
      if (termId && pendingResume.has(termId)) {
        const pending = pendingResume.get(termId);
        pendingResume.delete(termId);
        const oldSession = sessions.get(pending.oldSessionId);
        if (oldSession) {
          session = reKeyResumedSession(oldSession, session_id, pending.oldSessionId);
          log.info('session', `RESUME: Re-keyed session ${pending.oldSessionId?.slice(0,8)} → ${session_id?.slice(0,8)} (via pending resume + terminal ID)`);
        }
      }
      // Fallback: match by projectPath
      if (!session) {
        for (const [pTermId, pending] of pendingResume) {
          const oldSession = sessions.get(pending.oldSessionId);
          if (oldSession && oldSession.projectPath) {
            const normalizedSessionPath = oldSession.projectPath.replace(/\/$/, '');
            const normalizedCwd = (cwd || '').replace(/\/$/, '');
            if (normalizedSessionPath === normalizedCwd) {
              pendingResume.delete(pTermId);
              session = reKeyResumedSession(oldSession, session_id, pending.oldSessionId);
              log.info('session', `RESUME: Re-keyed session ${pending.oldSessionId?.slice(0,8)} → ${session_id?.slice(0,8)} (via pending resume + workDir match)`);
              break;
            }
          }
        }
      }
    }

    // Priority 1: Direct match via AGENT_MANAGER_TERMINAL_ID (injected into pty env)
    if (hookData.agent_terminal_id) {
      const preSession = sessions.get(hookData.agent_terminal_id);
      if (preSession && preSession.terminalId) {
        sessions.delete(hookData.agent_terminal_id);
        preSession.sessionId = session_id;
        preSession.replacesId = hookData.agent_terminal_id;
        session = preSession;
        sessions.set(session_id, session);
        log.info('session', `Re-keyed terminal session ${hookData.agent_terminal_id} → ${session_id?.slice(0,8)} (via terminal ID)`);
      }
    }

    // Priority 2: Match via pending workDir link
    if (!session) {
      const linkedTerminalId = tryLinkByWorkDir(cwd || '', session_id);
      if (linkedTerminalId) {
        // Check if there's a pre-created terminal session with this terminalId
        const preSession = sessions.get(linkedTerminalId);
        if (preSession) {
          sessions.delete(linkedTerminalId);
          preSession.sessionId = session_id;
          preSession.replacesId = linkedTerminalId;
          session = preSession;
          sessions.set(session_id, session);
          log.info('session', `Re-keyed terminal session ${linkedTerminalId} → ${session_id?.slice(0,8)} (via workDir link)`);
        } else {
          console.log(`[hook] NEW SSH SESSION ${session_id?.slice(0,8)} — terminal=${linkedTerminalId}`);
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
            source: 'ssh',
            pendingTool: null,
            waitingDetail: null,
            cachedPid: null,
            queueCount: 0,
            terminalId: linkedTerminalId
          };
          sessions.set(session_id, session);
        }
      } else {
        // Priority 3: Scan pre-created sessions by normalized path
        let found = false;
        for (const [key, s] of sessions) {
          if (s.terminalId && s.status === 'connecting' && s.projectPath) {
            const normalizedSessionPath = s.projectPath.replace(/\/$/, '');
            const normalizedCwd = (cwd || '').replace(/\/$/, '');
            if (normalizedSessionPath === normalizedCwd || s.projectPath === cwd) {
              sessions.delete(key);
              s.sessionId = session_id;
              s.replacesId = key;
              session = s;
              sessions.set(session_id, session);
              log.info('session', `Re-keyed terminal session ${key} → ${session_id?.slice(0,8)} (via path scan)`);
              found = true;
              break;
            }
          }
        }
        // Priority 4: PID-based fallback — check if Claude's parent is a known pty
        if (!found && hookData.claude_pid) {
          const pidTerminalId = getTerminalByPtyChild(Number(hookData.claude_pid));
          if (pidTerminalId) {
            const preSession = sessions.get(pidTerminalId);
            if (preSession && preSession.terminalId) {
              sessions.delete(pidTerminalId);
              preSession.sessionId = session_id;
              preSession.replacesId = pidTerminalId;
              session = preSession;
              sessions.set(session_id, session);
              log.info('session', `Re-keyed terminal session ${pidTerminalId} → ${session_id?.slice(0,8)} (via PID fallback)`);
              found = true;
            }
          }
        }
        if (!found) {
          // No SSH terminal match — create a display-only card with detected source
          const detectedSource = detectHookSource(hookData);
          log.info('session', `Creating display-only session ${session_id?.slice(0,8)} source=${detectedSource} cwd=${cwd}`);
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
            source: detectedSource,
            pendingTool: null,
            waitingDetail: null,
            cachedPid: null,
            queueCount: 0,
            terminalId: null,
          };
          sessions.set(session_id, session);
        }
      }
    }

    // Cache PID from hook
    const pid = hookData.claude_pid ? Number(hookData.claude_pid) : null;
    if (pid && pid > 0) {
      session.cachedPid = pid;
      pidToSession.set(pid, session_id);
      console.log(`[hook] CACHED pid=${pid} → session=${session_id?.slice(0,8)} (new session)`);
    }

    // Increment per-project session counter
    const projectKey = session.projectName;
    const count = (projectSessionCounters.get(projectKey) || 0) + 1;
    projectSessionCounters.set(projectKey, count);
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
      if (hookData.transcript_path) session.transcriptPath = hookData.transcript_path;
      if (hookData.permission_mode) session.permissionMode = hookData.permission_mode;
      eventEntry.detail = `Session started (${hookData.source || 'startup'})`;
      log.debug('session', `SessionStart: ${session_id?.slice(0,8)} project=${session.projectName} model=${session.model}`);
      // Try to match this new session as a subagent child
      const teamResult = findPendingSubagentMatch(session_id, session.projectPath);
      if (teamResult) {
        eventEntry.detail += ` [Team: ${teamResult.teamId}]`;
        log.debug('session', `Subagent matched to team ${teamResult.teamId}`);
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

      // Approval/input detection: if PostToolUse doesn't arrive within the
      // timeout, the tool is likely pending user interaction.
      // Tool timeouts and categories are defined in config.js.
      clearTimeout(pendingToolTimers.get(session_id));
      const approvalTimeout = getToolTimeout(toolName);
      if (approvalTimeout > 0) {
        session.pendingTool = toolName;
        session.pendingToolDetail = toolInputSummary;
        const timer = setTimeout(async () => {
          pendingToolTimers.delete(session_id);
          if (session.status === 'working' && session.pendingTool) {
            const category = getToolCategory(session.pendingTool);
            if (category === 'slow' && session.cachedPid && hasChildProcesses(session.cachedPid)) {
              return; // Command is running, not waiting for approval
            }

            const waitingStatus = getWaitingStatus(session.pendingTool) || 'approval';
            session.status = waitingStatus;
            session.animationState = 'Waiting';
            session.waitingDetail = getWaitingLabel(session.pendingTool, session.pendingToolDetail);
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
      }

      // Reset tool counter for next turn
      session.totalToolCalls = 0;
      break;
    }

    case 'SubagentStart':
      session.subagentCount++;
      session.emote = 'Jump';
      eventEntry.detail = `Subagent spawned (${hookData.agent_type || 'unknown'}${hookData.agent_id ? ' #' + hookData.agent_id.slice(0, 8) : ''})`;
      // Track pending subagent for team auto-detection
      pendingSubagents.push({
        parentSessionId: session_id,
        parentCwd: session.projectPath,
        agentType: hookData.agent_type || 'unknown',
        agentId: hookData.agent_id || null,
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

    case 'PermissionRequest': {
      // Real signal that user approval is needed — replaces timeout-based heuristic
      clearTimeout(pendingToolTimers.get(session_id));
      pendingToolTimers.delete(session_id);
      const permTool = hookData.tool_name || session.pendingTool || 'Unknown';
      session.status = 'approval';
      session.animationState = 'Waiting';
      session.waitingDetail = hookData.tool_input
        ? `Approve ${permTool}: ${summarizeToolInput(hookData.tool_input, permTool)}`
        : `Approve ${permTool}`;
      session.permissionMode = hookData.permission_mode || null;
      eventEntry.detail = `Permission request: ${permTool}`;
      break;
    }

    case 'PostToolUseFailure': {
      // Tool call failed — cancel approval timer, mark the failure in tool log
      clearTimeout(pendingToolTimers.get(session_id));
      pendingToolTimers.delete(session_id);
      session.pendingTool = null;
      session.pendingToolDetail = null;
      session.waitingDetail = null;
      session.status = 'working';
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

    case 'TeammateIdle':
      eventEntry.detail = `Teammate idle: ${hookData.agent_name || hookData.agent_id || 'unknown'}`;
      break;

    case 'TaskCompleted':
      eventEntry.detail = `Task completed: ${hookData.task_description || hookData.task_id || 'unknown'}`;
      session.emote = 'ThumbsUp';
      break;

    case 'PreCompact':
      eventEntry.detail = 'Context compaction starting';
      break;

    case 'Notification':
      eventEntry.detail = hookData.message || hookData.title || 'Notification';
      break;

    case 'SessionEnd':
      session.status = 'ended';
      session.animationState = 'Death';
      session.endedAt = Date.now();
      eventEntry.detail = `Session ended (${hookData.reason || 'unknown'})`;

      // Release PID cache for this session
      if (session.cachedPid) {
        console.log(`[findProcess] releasing pid=${session.cachedPid} from session=${session_id?.slice(0,8)}`);
        pidToSession.delete(session.cachedPid);
        session.cachedPid = null;
      }

      // Team cleanup: remove from team, clean up if empty
      handleTeamMemberEnd(session_id);

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
  const teamId = sessionToTeam.get(session_id);
  if (teamId) {
    result.team = serializeTeam(teams.get(teamId));
  }

  // Push to ring buffer for reconnect replay
  pushEvent('session_update', result);

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
    }
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

// Create a session card immediately when SSH terminal connects (before hooks arrive)
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
    status: 'connecting',
    animationState: 'Walking',
    emote: 'Wave',
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

  log.info('session', `Created terminal session ${terminalId} → ${config.host}:${workDir}`);

  const { broadcast } = await import('./wsManager.js');
  broadcast({ type: 'session_update', session: { ...session } });

  // Non-Claude CLIs (codex, gemini, etc.) don't send hooks — auto-transition to idle
  const command = config.command || 'claude';
  if (!command.startsWith('claude')) {
    setTimeout(async () => {
      const s = sessions.get(terminalId);
      if (s && s.status === 'connecting') {
        s.status = 'idle';
        s.animationState = 'Idle';
        s.emote = null;
        s.model = command; // Show command name as model
        const { broadcast: bc } = await import('./wsManager.js');
        bc({ type: 'session_update', session: { ...s } });
        log.info('session', `Auto-transitioned non-Claude session ${terminalId} to idle (${command})`);
      }
    }, 3000);
  }

  return session;
}

export function linkTerminalToSession(sessionId, terminalId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.terminalId = terminalId;
  return { ...session };
}

export function updateQueueCount(sessionId, count) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.queueCount = count || 0;
  return { ...session };
}

export function killSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.status = 'ended';
  session.animationState = 'Death';
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
  handleTeamMemberEnd(sessionId);
  sessions.delete(sessionId);
  return true;
}

export function setSessionTitle(sessionId, title) {
  const session = sessions.get(sessionId);
  if (session) session.title = title;
  return session ? { ...session } : null;
}

export function setSessionLabel(sessionId, label) {
  const session = sessions.get(sessionId);
  if (session) session.label = label;
  return session ? { ...session } : null;
}

export function setSummary(sessionId, summary) {
  const session = sessions.get(sessionId);
  if (session) session.summary = summary;
  return session ? { ...session } : null;
}

export function setSessionAccentColor(sessionId, color) {
  const session = sessions.get(sessionId);
  if (session) session.accentColor = color;
}

export function setSessionCharacterModel(sessionId, model) {
  const session = sessions.get(sessionId);
  if (session) session.characterModel = model;
  return session ? { ...session } : null;
}

export function archiveSession(sessionId, archived) {
  const session = sessions.get(sessionId);
  if (session) session.archived = archived ? 1 : 0;
  return session ? { ...session } : null;
}

// Auto-idle: mark sessions as idle if no activity for a while
// Timeouts are defined in config.js (AUTO_IDLE_TIMEOUTS)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.status === 'ended' || session.status === 'idle') continue;
    const elapsed = now - session.lastActivityAt;

    if (session.status === 'approval' && elapsed > AUTO_IDLE_TIMEOUTS.approval) {
      session.status = 'idle';
      session.animationState = 'Idle';
      session.emote = null;
      session.pendingTool = null;
      session.pendingToolDetail = null;
      session.waitingDetail = null;
    } else if (session.status === 'input' && elapsed > AUTO_IDLE_TIMEOUTS.input) {
      session.status = 'idle';
      session.animationState = 'Idle';
      session.emote = null;
      session.pendingTool = null;
      session.pendingToolDetail = null;
      session.waitingDetail = null;
    } else if (session.status === 'prompting' && elapsed > AUTO_IDLE_TIMEOUTS.prompting) {
      session.status = 'waiting';
      session.animationState = 'Waiting';
      session.emote = null;
    } else if (session.status === 'waiting' && elapsed > AUTO_IDLE_TIMEOUTS.waiting) {
      session.status = 'idle';
      session.animationState = 'Idle';
      session.emote = null;
    } else if (session.status !== 'waiting' && session.status !== 'prompting'
      && session.status !== 'approval' && session.status !== 'input'
      && session.status !== 'connecting'
      && elapsed > AUTO_IDLE_TIMEOUTS.working) {
      session.status = 'idle';
      session.animationState = 'Idle';
      session.emote = null;
    }
  }
}, 10000);

// ---- Process Liveness Monitor ----
setInterval(async () => {
  for (const [id, session] of sessions) {
    if (session.status === 'ended') continue;
    if (!session.cachedPid) continue;

    // Skip sessions with active terminal — the PTY is the source of truth
    if (session.terminalId && getTerminalForSession(id)) continue;

    try {
      process.kill(session.cachedPid, 0); // signal 0 = liveness check, doesn't kill
    } catch {
      // Process is dead — auto-end this session
      console.log(`[processMonitor] pid=${session.cachedPid} is dead → ending session=${id.slice(0,8)}`);

      session.status = 'ended';
      session.animationState = 'Death';
      session.lastActivityAt = Date.now();
      session.endedAt = Date.now();

      session.events.push({
        type: 'SessionEnd',
        timestamp: Date.now(),
        detail: 'Session ended (process exited)'
      });
      if (session.events.length > 50) session.events.shift();

      // Release PID cache
      pidToSession.delete(session.cachedPid);
      session.cachedPid = null;

      // Clear any pending tool timer
      clearTimeout(pendingToolTimers.get(id));
      pendingToolTimers.delete(id);
      session.pendingTool = null;
      session.pendingToolDetail = null;
      session.waitingDetail = null;

      // Team cleanup
      handleTeamMemberEnd(id);

      // Broadcast to connected browsers
      try {
        const { broadcast } = await import('./wsManager.js');
        broadcast({ type: 'session_update', session: { ...session } });
      } catch(e) {}

      // SSH sessions: keep in memory as historical (disconnected), preserve terminal ref for resume
      if (session.source === 'ssh') {
        session.isHistorical = true;
        session.lastTerminalId = session.terminalId;
        session.terminalId = null;
      } else {
        setTimeout(() => sessions.delete(id), 10000);
      }
    }
  }
}, PROCESS_CHECK_INTERVAL);

// Clean up stale pendingResume entries every 30s
setInterval(() => {
  const now = Date.now();
  for (const [termId, pending] of pendingResume) {
    if (now - pending.timestamp > 120000) { // 2 minutes
      pendingResume.delete(termId);
      const session = sessions.get(pending.oldSessionId);
      if (session && session.status === 'connecting') {
        session.status = 'ended';
        session.animationState = 'Death';
        session.isHistorical = true;
        session.terminalId = null;
        log.info('session', `RESUME TIMEOUT: reverted session ${pending.oldSessionId?.slice(0,8)} back to ended`);
        import('./wsManager.js').then(({ broadcast }) => {
          broadcast({ type: 'session_update', session: { ...session } });
        }).catch(() => {});
      }
    }
  }
}, 30000);

// Resume a disconnected SSH session — sends claude --resume to its terminal
export function resumeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { error: 'Session not found' };
  if (session.status !== 'ended') return { error: 'Session is not ended' };
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
  session.status = 'connecting';
  session.animationState = 'Walking';
  session.emote = 'Wave';
  session.isHistorical = false;
  session.lastActivityAt = Date.now();

  session.events.push({
    type: 'ResumeRequested',
    timestamp: Date.now(),
    detail: 'Resume requested by user',
  });

  log.info('session', `RESUME: session ${sessionId?.slice(0,8)} → connecting (terminal=${session.lastTerminalId?.slice(0,8)})`);

  return { ok: true, terminalId: session.lastTerminalId, session: { ...session } };
}

// Detect where a hook-only session originated from environment variables
function detectHookSource(hookData) {
  if (hookData.vscode_pid) return 'vscode';
  const tp = (hookData.term_program || '').toLowerCase();
  if (tp.includes('vscode') || tp.includes('code')) return 'vscode';
  if (tp.includes('jetbrains') || tp.includes('intellij') || tp.includes('idea') || tp.includes('webstorm') || tp.includes('pycharm') || tp.includes('goland') || tp.includes('clion') || tp.includes('phpstorm') || tp.includes('rider') || tp.includes('rubymine') || tp.includes('datagrip')) return 'jetbrains';
  if (tp.includes('iterm')) return 'iterm';
  if (tp.includes('warp')) return 'warp';
  if (tp.includes('kitty')) return 'kitty';
  if (tp.includes('ghostty') || hookData.is_ghostty) return 'ghostty';
  if (tp.includes('alacritty')) return 'alacritty';
  if (tp.includes('wezterm') || hookData.wezterm_pane) return 'wezterm';
  if (tp.includes('hyper')) return 'hyper';
  if (tp.includes('apple_terminal') || tp === 'apple_terminal') return 'terminal';
  if (hookData.tmux) return 'tmux';
  if (tp) return tp;
  return 'terminal';
}

export function detectSessionSource(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return 'unknown';
  return session.source || 'ssh';
}

export function findClaudeProcess(sessionId, projectPath) {
  const session = sessionId ? sessions.get(sessionId) : null;
  if (session?.cachedPid) {
    try {
      execSync(`kill -0 ${session.cachedPid} 2>/dev/null`, { timeout: 1000 });
      console.log(`[findProcess] session=${sessionId?.slice(0,8)} → cached pid=${session.cachedPid}`);
      return session.cachedPid;
    } catch {
      console.log(`[findProcess] session=${sessionId?.slice(0,8)} cached pid=${session.cachedPid} is dead, re-scanning`);
      pidToSession.delete(session.cachedPid);
      session.cachedPid = null;
    }
  }

  const myPid = process.pid;
  console.log(`[findProcess] ── session=${sessionId?.slice(0,8)} projectPath=${projectPath}`);

  const claimedPids = new Set();
  for (const [pid, sid] of pidToSession) {
    if (sid !== sessionId) claimedPids.add(pid);
  }
  if (claimedPids.size > 0) {
    console.log(`[findProcess] PIDs claimed by other sessions: [${[...claimedPids].join(', ')}]`);
  }

  try {
    if (process.platform === 'win32') {
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
        if ($procs.Count -gt 0) { $procs[0].ProcessId }
      `;
      const out = execSync(
        `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      const pid = parseInt(out.trim(), 10);
      if (pid > 0) cachePid(pid, sessionId, session);
      return pid > 0 ? pid : null;
    } else {
      const pidsOut = execSync(`pgrep -f claude 2>/dev/null || true`, { encoding: 'utf-8', timeout: 5000 });
      const pids = pidsOut.trim().split('\n')
        .map(p => parseInt(p.trim(), 10))
        .filter(p => p > 0 && p !== myPid);

      console.log(`[findProcess] pgrep found ${pids.length} claude pids: [${pids.join(', ')}]`);

      if (pids.length === 0) return null;

      if (projectPath) {
        for (const pid of pids) {
          if (claimedPids.has(pid)) {
            console.log(`[findProcess] pid=${pid} SKIP (claimed by session ${pidToSession.get(pid)?.slice(0,8)})`);
            continue;
          }
          try {
            let cwd;
            if (process.platform === 'darwin') {
              const out = execSync(`lsof -a -d cwd -Fn -p ${pid} 2>/dev/null | grep '^n'`, { encoding: 'utf-8', timeout: 3000 });
              cwd = out.trim().replace(/^n/, '');
            } else {
              cwd = execSync(`readlink /proc/${pid}/cwd 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 }).trim();
            }
            const match = cwd === projectPath;
            console.log(`[findProcess] pid=${pid} cwd="${cwd}" ${match ? '✓ MATCH' : '✗ no match'}`);
            if (match) {
              cachePid(pid, sessionId, session);
              return pid;
            }
          } catch(e) {
            console.log(`[findProcess] pid=${pid} cwd lookup failed: ${e.message?.split('\n')[0]}`);
            continue;
          }
        }
        console.log(`[findProcess] no cwd match found, trying tty fallback`);
      }

      for (const pid of pids) {
        if (claimedPids.has(pid)) continue;
        try {
          const tty = execSync(`ps -o tty= -p ${pid}`, { encoding: 'utf-8', timeout: 3000 }).trim();
          console.log(`[findProcess] fallback pid=${pid} tty=${tty || 'NONE'}`);
          if (tty && tty !== '??' && tty !== '?') {
            console.log(`[findProcess] FALLBACK returning pid=${pid} (first unclaimed with tty)`);
            cachePid(pid, sessionId, session);
            return pid;
          }
        } catch(e) { continue; }
      }

      const unclaimed = pids.find(p => !claimedPids.has(p));
      console.log(`[findProcess] last resort returning pid=${unclaimed || 'null'}`);
      if (unclaimed) cachePid(unclaimed, sessionId, session);
      return unclaimed || null;
    }
  } catch(e) {
    console.log(`[findProcess] ERROR: ${e.message}`);
  }
  return null;
}

function hasChildProcesses(pid) {
  try {
    const out = execSync(`pgrep -P ${pid} 2>/dev/null`, { encoding: 'utf-8', timeout: 2000 });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function cachePid(pid, sessionId, session) {
  pidToSession.set(pid, sessionId);
  if (session) session.cachedPid = pid;
  console.log(`[findProcess] CACHED pid=${pid} → session=${sessionId?.slice(0,8)}`);
}

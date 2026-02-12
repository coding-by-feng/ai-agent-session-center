// @ts-check
/**
 * @module sessionMatcher
 * 5-priority session matching system that maps incoming hook events to existing sessions.
 * Priorities: pendingResume > agent_terminal_id > workDir link > path scan > PID fallback.
 * Also detects hook source (terminal type) from environment variables.
 */
import { tryLinkByWorkDir, getTerminalByPtyChild } from './sshManager.js';
import { EVENT_TYPES, SESSION_STATUS, ANIMATION_STATE, EMOTE } from './constants.js';
import log from './logger.js';

/**
 * Detect where a hook-only session originated from environment variables.
 * @param {import('../types/hook').HookPayloadBase} hookData
 * @returns {import('../types/session').SessionSource}
 */
export function detectHookSource(hookData) {
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

/**
 * Re-key a resumed session: transfer from old sessionId to new, reset state for fresh session.
 * Note: previousSessions is intentionally preserved (not reset) to maintain history chain.
 * @param {Map<string, import('../types/session').Session>} sessions
 * @param {import('../types/session').Session} oldSession
 * @param {string} newSessionId
 * @param {string} oldSessionId
 * @returns {import('../types/session').Session}
 */
export function reKeyResumedSession(sessions, oldSession, newSessionId, oldSessionId) {
  sessions.delete(oldSessionId);
  oldSession.replacesId = oldSessionId;
  oldSession.sessionId = newSessionId;
  oldSession.status = SESSION_STATUS.IDLE;
  oldSession.animationState = ANIMATION_STATE.IDLE;
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

/**
 * Create a default session object.
 * @param {string} session_id
 * @param {string|undefined} cwd
 * @param {import('../types/hook').HookPayloadBase} hookData
 * @param {string} source
 * @param {string|null} terminalId
 * @returns {import('../types/session').Session}
 */
function createDefaultSession(session_id, cwd, hookData, source, terminalId) {
  return {
    sessionId: session_id,
    projectPath: cwd || '',
    projectName: cwd ? cwd.split('/').filter(Boolean).pop() : 'Unknown',
    title: '',
    status: SESSION_STATUS.IDLE,
    animationState: ANIMATION_STATE.IDLE,
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
    source,
    pendingTool: null,
    waitingDetail: null,
    cachedPid: null,
    queueCount: 0,
    terminalId: terminalId || null,
  };
}

/**
 * Match an incoming hook event to an existing session, or create a new one.
 * Implements a 5-priority fallback system:
 *   Priority 0: pendingResume + terminal ID / workDir matching
 *   Priority 1: agent_terminal_id matching
 *   Priority 2: tryLinkByWorkDir matching
 *   Priority 3: scan pre-created sessions by path
 *   Priority 4: PID parent check
 *
 * @param {object} hookData - The incoming hook event data
 * @param {Map} sessions - The sessions Map
 * @param {Map} pendingResume - The pendingResume Map
 * @param {Map} pidToSession - The pidToSession Map
 * @param {Map} projectSessionCounters - Per-project session counters
 * @returns {object} The matched or created session
 */
export function matchSession(hookData, sessions, pendingResume, pidToSession, projectSessionCounters) {
  const { session_id, hook_event_name, cwd } = hookData;
  let session = sessions.get(session_id);

  // Cache all process/tab info from hook's enriched environment data
  if (hookData.claude_pid) {
    const pid = Number(hookData.claude_pid);
    if (pid > 0 && session && session.cachedPid !== pid) {
      if (session.cachedPid) pidToSession.delete(session.cachedPid);
      session.cachedPid = pid;
      pidToSession.set(pid, session_id);
      log.debug('session', `CACHED pid=${pid} → session=${session_id?.slice(0,8)}`);
    }
  }

  if (session) return session;

  // Session not found — try matching strategies

  // Priority 0: Check if this new session matches a pending resume request
  if (hook_event_name === EVENT_TYPES.SESSION_START) {
    const termId = hookData.agent_terminal_id;
    // Match by agent_terminal_id
    if (termId && pendingResume.has(termId)) {
      const pending = pendingResume.get(termId);
      pendingResume.delete(termId);
      const oldSession = sessions.get(pending.oldSessionId);
      if (oldSession) {
        session = reKeyResumedSession(sessions, oldSession, session_id, pending.oldSessionId);
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
            session = reKeyResumedSession(sessions, oldSession, session_id, pending.oldSessionId);
            log.info('session', `RESUME: Re-keyed session ${pending.oldSessionId?.slice(0,8)} → ${session_id?.slice(0,8)} (via pending resume + workDir match)`);
            break;
          }
        }
      }
    }
  }

  // Priority 1: Direct match via AGENT_MANAGER_TERMINAL_ID (injected into pty env)
  if (!session && hookData.agent_terminal_id) {
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
        log.info('session', `NEW SSH SESSION ${session_id?.slice(0,8)} — terminal=${linkedTerminalId}`);
        session = createDefaultSession(session_id, cwd, hookData, 'ssh', linkedTerminalId);
        sessions.set(session_id, session);
      }
    } else {
      // Priority 3: Scan pre-created sessions by normalized path
      let found = false;
      for (const [key, s] of sessions) {
        if (s.terminalId && s.status === SESSION_STATUS.CONNECTING && s.projectPath) {
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
        session = createDefaultSession(session_id, cwd, hookData, detectedSource, null);
        sessions.set(session_id, session);
      }
    }
  }

  // Cache PID from hook
  const pid = hookData.claude_pid ? Number(hookData.claude_pid) : null;
  if (pid && pid > 0) {
    session.cachedPid = pid;
    pidToSession.set(pid, session_id);
    log.debug('session', `CACHED pid=${pid} → session=${session_id?.slice(0,8)} (new session)`);
  }

  // Store team-related fields from enriched hook data
  if (hookData.agent_name && !session.agentName) {
    session.agentName = hookData.agent_name;
  }
  if (hookData.agent_type && !session.agentType) {
    session.agentType = hookData.agent_type;
  }
  if (hookData.team_name && !session.teamName) {
    session.teamName = hookData.team_name;
  }
  if (hookData.agent_color && !session.agentColor) {
    session.agentColor = hookData.agent_color;
  }

  // Increment per-project session counter
  const projectKey = session.projectName;
  const count = (projectSessionCounters.get(projectKey) || 0) + 1;
  projectSessionCounters.set(projectKey, count);

  return session;
}

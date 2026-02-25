/**
 * @module sessionMatcher
 * 5-priority session matching system that maps incoming hook events to existing sessions.
 * Priorities: pendingResume > agent_terminal_id > workDir link > path scan > PID fallback.
 * Also detects hook source (terminal type) from environment variables.
 */
import { tryLinkByWorkDir, getTerminalByPtyChild, consumePendingLink } from './sshManager.js';
import { EVENT_TYPES, SESSION_STATUS, ANIMATION_STATE } from './constants.js';
import log from './logger.js';
import type { Session, SessionSource, SshConfig, PendingResume } from '../src/types/session.js';
import type { HookPayloadBase } from '../src/types/hook.js';

/**
 * Detect where a hook-only session originated from environment variables.
 */
export function detectHookSource(hookData: HookPayloadBase): SessionSource | string {
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
 */
export function reKeyResumedSession(
  sessions: Map<string, Session>,
  oldSession: Session,
  newSessionId: string,
  oldSessionId: string,
  pidToSession?: Map<number, string>,
): Session {
  sessions.delete(oldSessionId);

  // Clear stale PID mapping — next hook will re-cache with the new session ID
  if (pidToSession && oldSession.cachedPid) {
    pidToSession.delete(oldSession.cachedPid);
    oldSession.cachedPid = null;
  }

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
  oldSession.events = [{ type: 'SessionResumed', timestamp: Date.now(), detail: `Resumed from ${oldSessionId?.slice(0, 8)}` }];
  sessions.set(newSessionId, oldSession);
  return oldSession;
}

/**
 * Create a default session object.
 */
function createDefaultSession(
  session_id: string,
  cwd: string | undefined,
  hookData: HookPayloadBase,
  source: string,
  terminalId: string | null,
  sshConfig?: SshConfig | null,
): Session {
  const session: Session = {
    sessionId: session_id,
    projectPath: cwd || '',
    projectName: cwd ? cwd.split('/').filter(Boolean).pop() || 'Unknown' : 'Unknown',
    title: '',
    status: SESSION_STATUS.IDLE,
    animationState: ANIMATION_STATE.IDLE,
    emote: null,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    endedAt: null,
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
  if (sshConfig) session.sshConfig = { ...sshConfig };
  return session;
}

/**
 * Find the sshConfig from any existing session that shares the given terminalId or projectPath.
 * Used to propagate SSH config when creating new sessions in already-known SSH terminals.
 */
function findSshConfig(
  sessions: Map<string, Session>,
  terminalId: string | undefined,
  cwd: string | undefined,
): SshConfig | null {
  // Prefer exact terminal match first
  if (terminalId) {
    for (const s of sessions.values()) {
      if (s.sshConfig && (s.terminalId === terminalId || s.lastTerminalId === terminalId)) {
        return s.sshConfig;
      }
    }
  }
  // Fallback: match by projectPath + source=ssh
  if (cwd) {
    const normalizedCwd = cwd.replace(/\/$/, '');
    for (const s of sessions.values()) {
      if (s.sshConfig && s.source === 'ssh' && s.projectPath?.replace(/\/$/, '') === normalizedCwd) {
        return s.sshConfig;
      }
    }
  }
  return null;
}

/**
 * Match an incoming hook event to an existing session, or create a new one.
 * Implements a 5-priority fallback system:
 *   Priority 0: pendingResume + terminal ID / workDir matching
 *   Priority 1: agent_terminal_id matching
 *   Priority 2: tryLinkByWorkDir matching
 *   Priority 3: scan pre-created sessions by path
 *   Priority 4: PID parent check
 */
export function matchSession(
  hookData: HookPayloadBase,
  sessions: Map<string, Session>,
  pendingResume: Map<string, PendingResume>,
  pidToSession: Map<number, string>,
  projectSessionCounters: Map<string, number>,
): Session {
  const { session_id, hook_event_name, cwd } = hookData;
  let session = sessions.get(session_id);

  // Cache all process/tab info from hook's enriched environment data
  if (hookData.claude_pid) {
    const pid = Number(hookData.claude_pid);
    if (pid > 0 && session && session.cachedPid !== pid) {
      if (session.cachedPid) pidToSession.delete(session.cachedPid);
      session.cachedPid = pid;
      pidToSession.set(pid, session_id);
      log.debug('session', `CACHED pid=${pid} -> session=${session_id?.slice(0, 8)}`);
    }
  }

  if (session) {
    // When `claude --resume` reuses the same session_id, the session is found
    // by direct Map lookup and we return early.  But pendingResume/pendingLinks
    // entries (registered by reconnectSessionTerminal / createTerminal) are left
    // dangling.  Clean them up here to prevent stale matches for future hooks.
    if (hook_event_name === EVENT_TYPES.SESSION_START && session.terminalId) {
      if (pendingResume.has(session.terminalId)) {
        pendingResume.delete(session.terminalId);
        log.debug('session', `Cleaned stale pendingResume for terminal=${session.terminalId?.slice(0, 8)} (session found by direct ID)`);
      }
      consumePendingLink(session.projectPath);
    }
    return session;
  }

  // Session not found — try matching strategies

  // Priority 0: Check if this new session matches a pending resume request
  if (hook_event_name === EVENT_TYPES.SESSION_START) {
    const termId = hookData.agent_terminal_id;
    // Match by agent_terminal_id
    if (termId && pendingResume.has(termId)) {
      const pending = pendingResume.get(termId)!;
      pendingResume.delete(termId);
      const oldSession = sessions.get(pending.oldSessionId);
      if (oldSession) {
        session = reKeyResumedSession(sessions, oldSession, session_id, pending.oldSessionId, pidToSession);
        log.info('session', `RESUME: Re-keyed session ${pending.oldSessionId?.slice(0, 8)} -> ${session_id?.slice(0, 8)} (via pending resume + terminal ID)`);
      }
    }
    // Fallback: match by projectPath — only if exactly one pendingResume matches.
    // When multiple pending resumes share the same projectPath, path alone is
    // ambiguous and we'd link the wrong session.
    if (!session) {
      const pathMatches: Array<{ pTermId: string; pending: PendingResume; oldSession: Session }> = [];
      const normalizedCwd = (cwd || '').replace(/\/$/, '');
      for (const [pTermId, pending] of pendingResume) {
        const oldSession = sessions.get(pending.oldSessionId);
        if (oldSession && oldSession.projectPath) {
          const normalizedSessionPath = oldSession.projectPath.replace(/\/$/, '');
          if (normalizedSessionPath === normalizedCwd) {
            pathMatches.push({ pTermId, pending, oldSession });
          }
        }
      }
      if (pathMatches.length === 1) {
        const { pTermId, pending, oldSession } = pathMatches[0];
        pendingResume.delete(pTermId);
        session = reKeyResumedSession(sessions, oldSession, session_id, pending.oldSessionId, pidToSession);
        log.info('session', `RESUME: Re-keyed session ${pending.oldSessionId?.slice(0, 8)} -> ${session_id?.slice(0, 8)} (via pending resume + workDir match, 1 candidate)`);
      } else if (pathMatches.length > 1) {
        log.info('session', `SKIP RESUME path match: ${pathMatches.length} pending resumes for cwd=${normalizedCwd} — ambiguous`);
      }
    }
    // Clean up stale pendingLinks from sshManager.createTerminal() so they
    // don't create a duplicate session at Priority 2
    if (session && session.projectPath) {
      consumePendingLink(session.projectPath);
    }
  }

  // Priority 0.5: Auto-link to snapshot-restored ended session by projectPath.
  // After server restart, sessions with dead PIDs are marked ended with a
  // 'ServerRestart' event.  When `claude --resume` sends a SessionStart with
  // a NEW session_id in the same directory, re-key the old card instead of
  // creating a duplicate.
  // IMPORTANT: Only auto-link when there is exactly ONE candidate.  When
  // multiple sessions share the same projectPath, path alone is ambiguous
  // and we'd link the wrong card.  In that case, skip and let a new card
  // be created — the user can manually resume/reconnect.
  if (!session && hook_event_name === EVENT_TYPES.SESSION_START && cwd) {
    const normalizedCwd = cwd.replace(/\/$/, '');
    const candidates: Array<{ oldId: string; s: Session; endedAt: number }> = [];
    for (const [oldId, s] of sessions) {
      if (s.projectPath?.replace(/\/$/, '') !== normalizedCwd) continue;
      // Match 1: Ended sessions with ServerRestart event (standard post-restart case)
      if (s.status === SESSION_STATUS.ENDED
          && s.events?.some(e => e.type === 'ServerRestart')
          && (Date.now() - (s.endedAt || 0)) < 30 * 60 * 1000) {
        candidates.push({ oldId, s, endedAt: s.endedAt || 0 });
      }
      // Match 2: Safety net — zombie SSH sessions that slipped through cleanup
      // (non-ended, source=ssh, no terminalId, stale for >60s)
      if (s.source === 'ssh'
          && s.status !== SESSION_STATUS.ENDED
          && !s.terminalId
          && s.lastActivityAt && (Date.now() - s.lastActivityAt) > 60_000) {
        candidates.push({ oldId, s, endedAt: s.lastActivityAt || 0 });
      }
    }
    if (candidates.length === 1) {
      const match = candidates[0];
      session = reKeyResumedSession(sessions, match.s, session_id, match.oldId, pidToSession);
      log.info('session', `AUTO-RESUME: Re-keyed ${match.oldId?.slice(0, 8)} -> ${session_id?.slice(0, 8)} (snapshot restore + projectPath match, 1 candidate)`);
    } else if (candidates.length > 1) {
      // #47: Prefer ENDED sessions over zombie SSH candidates to reduce ambiguity
      const ended = candidates.filter(c => c.s.status === SESSION_STATUS.ENDED);
      const zombies = candidates.filter(c => c.s.status !== SESSION_STATUS.ENDED);
      if (ended.length === 1 && zombies.length > 0) {
        const match = ended[0];
        session = reKeyResumedSession(sessions, match.s, session_id, match.oldId, pidToSession);
        log.info('session', `AUTO-RESUME: Re-keyed ${match.oldId?.slice(0, 8)} -> ${session_id?.slice(0, 8)} (preferred ENDED over ${zombies.length} zombies)`);
      } else {
        log.info('session', `SKIP AUTO-RESUME: ${candidates.length} candidates for cwd=${normalizedCwd} — ambiguous, creating new card`);
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
      // Consume pendingLink so Priority 2 doesn't create a duplicate match
      consumePendingLink(preSession.projectPath || '');
      log.info('session', `Re-keyed terminal session ${hookData.agent_terminal_id} -> ${session_id?.slice(0, 8)} (via terminal ID)`);
    }
  }

  // Priority 2: Match via pending workDir link
  if (!session) {
    const linkedTerminalId = tryLinkByWorkDir(cwd || '', session_id);
    if (linkedTerminalId) {
      // Check if there's a pre-created terminal session with this terminalId as its key
      let preSession = sessions.get(linkedTerminalId);
      if (preSession) {
        sessions.delete(linkedTerminalId);
        preSession.sessionId = session_id;
        preSession.replacesId = linkedTerminalId;
        session = preSession;
        sessions.set(session_id, session);
        log.info('session', `Re-keyed terminal session ${linkedTerminalId} -> ${session_id?.slice(0, 8)} (via workDir link)`);
      }
      // Fallback: scan for a session that owns this terminal (resume case —
      // reconnectSessionTerminal keeps the session under its old ID, not the terminal ID)
      if (!session) {
        for (const [key, s] of sessions) {
          if (s.terminalId === linkedTerminalId) {
            sessions.delete(key);
            s.sessionId = session_id;
            s.replacesId = key;
            session = s;
            sessions.set(session_id, session);
            log.info('session', `Re-keyed resumed session ${key?.slice(0, 8)} -> ${session_id?.slice(0, 8)} (via workDir link + terminalId scan)`);
            break;
          }
        }
      }
      if (!session) {
        log.info('session', `NEW SSH SESSION ${session_id?.slice(0, 8)} — terminal=${linkedTerminalId}`);
        const inheritedConfig = findSshConfig(sessions, linkedTerminalId, cwd);
        session = createDefaultSession(session_id, cwd, hookData, 'ssh', linkedTerminalId, inheritedConfig);
        sessions.set(session_id, session);
      }
    } else {
      // Priority 3: Scan pre-created sessions by normalized path.
      // Only match when exactly one CONNECTING session shares the path —
      // multiple CONNECTING sessions in the same dir means ambiguity.
      let found = false;
      const normalizedCwd = (cwd || '').replace(/\/$/, '');
      const connectingMatches: Array<{ key: string; s: Session }> = [];
      for (const [key, s] of sessions) {
        if (s.terminalId && s.status === SESSION_STATUS.CONNECTING && s.projectPath) {
          const normalizedSessionPath = s.projectPath.replace(/\/$/, '');
          if (normalizedSessionPath === normalizedCwd || s.projectPath === cwd) {
            connectingMatches.push({ key, s });
          }
        }
      }
      if (connectingMatches.length === 1) {
        const { key, s } = connectingMatches[0];
        sessions.delete(key);
        s.sessionId = session_id;
        s.replacesId = key;
        session = s;
        sessions.set(session_id, session);
        log.info('session', `Re-keyed terminal session ${key} -> ${session_id?.slice(0, 8)} (via path scan, 1 candidate)`);
        found = true;
      } else if (connectingMatches.length > 1) {
        // Multiple CONNECTING sessions in the same dir — prefer the most recently created
        // to avoid creating a duplicate display-only card.
        connectingMatches.sort((a, b) => (b.s.startedAt || 0) - (a.s.startedAt || 0));
        const { key, s } = connectingMatches[0];
        sessions.delete(key);
        s.sessionId = session_id;
        s.replacesId = key;
        session = s;
        sessions.set(session_id, session);
        log.info('session', `Re-keyed terminal session ${key} -> ${session_id?.slice(0, 8)} (via path scan, picked newest of ${connectingMatches.length})`);
        found = true;
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
            log.info('session', `Re-keyed terminal session ${pidTerminalId} -> ${session_id?.slice(0, 8)} (via PID fallback)`);
            found = true;
          }
        }
      }
      if (!found) {
        // No SSH terminal match — create a display-only card with detected source
        const detectedSource = detectHookSource(hookData);
        log.info('session', `Creating display-only session ${session_id?.slice(0, 8)} source=${detectedSource} cwd=${cwd}`);
        // Inherit SSH config for capability (e.g. terminal relay) but keep the actual detected source.
        // Only sessions created via the dashboard (createTerminalSession) should have source='ssh'.
        const inheritedConfig = findSshConfig(sessions, hookData.agent_terminal_id, cwd);
        session = createDefaultSession(session_id, cwd, hookData, detectedSource, hookData.agent_terminal_id || null, inheritedConfig);
        sessions.set(session_id, session);
      }
    }
  }

  // Cache PID from hook
  const pid = hookData.claude_pid ? Number(hookData.claude_pid) : null;
  if (pid && pid > 0) {
    session!.cachedPid = pid;
    pidToSession.set(pid, session_id);
    log.debug('session', `CACHED pid=${pid} -> session=${session_id?.slice(0, 8)} (new session)`);
  }

  // Store team-related fields from enriched hook data
  if (hookData.agent_name && !session!.agentName) {
    session!.agentName = hookData.agent_name;
  }
  if (hookData.agent_type && !session!.agentType) {
    session!.agentType = hookData.agent_type;
  }
  if (hookData.team_name && !session!.teamName) {
    session!.teamName = hookData.team_name;
  }
  if (hookData.agent_color && !session!.agentColor) {
    session!.agentColor = hookData.agent_color;
  }

  // Increment per-project session counter
  const projectKey = session!.projectName;
  const count = (projectSessionCounters.get(projectKey) || 0) + 1;
  projectSessionCounters.set(projectKey, count);

  return session!;
}

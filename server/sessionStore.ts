// sessionStore.ts — In-memory session state machine (coordinator)
// Delegates to sub-modules: sessionMatcher, approvalDetector, teamManager, processMonitor, autoIdleManager
//
// Session State Machine:
//   SessionStart    -> idle    (Idle animation)
//   UserPromptSubmit -> prompting (Wave + Walking)
//   PreToolUse      -> working  (Running)
//   PostToolUse     -> working  (stays)
//   PermissionRequest -> approval (Waiting)
//   Stop            -> waiting  (ThumbsUp/Dance + Waiting)
//   SessionEnd      -> ended   (Death, removed after 10s)
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import log from './logger.js';
import { getWaitingLabel } from './config.js';
import {
  EVENT_TYPES, SESSION_STATUS, ANIMATION_STATE, EMOTE, WS_TYPES,
} from './constants.js';

// Sub-module imports
import { matchSession, detectHookSource } from './sessionMatcher.js';
import { startApprovalTimer, clearApprovalTimer, hasChildProcesses } from './approvalDetector.js';
import { closeTerminal, registerTerminalExitCallback } from './sshManager.js';
import {
  findPendingSubagentMatch, handleTeamMemberEnd, addPendingSubagent,
  linkByParentSessionId,
  getTeam, getAllTeams, getTeamForSession, getTeamIdForSession,
} from './teamManager.js';
import { startMonitoring, stopMonitoring, findClaudeProcess as _findClaudeProcess } from './processMonitor.js';
import { startAutoIdle, stopAutoIdle, startPendingResumeCleanup, stopPendingResumeCleanup } from './autoIdleManager.js';
import {
  upsertSession as dbUpsertSession,
  updateSessionTitle as dbUpdateTitle,
  updateSessionLabel as dbUpdateLabel,
  updateSessionSummary as dbUpdateSummary,
  updateSessionArchived as dbUpdateArchived,
  migrateSessionId as dbMigrateSessionId,
} from './db.js';
import type { Session, HandleEventResult, BufferedEvent, PendingResume, SessionEvent } from '../src/types/session.js';
import type { HookPayload } from '../src/types/hook.js';
import type { TerminalConfig } from '../src/types/terminal.js';
import type { TeamSerialized } from '../src/types/team.js';

const sessions = new Map<string, Session>();
const projectSessionCounters = new Map<string, number>();
/** pid -> sessionId — ensures each PID is only assigned to one session */
const pidToSession = new Map<number, string>();
/** terminalId -> pending resume info */
const pendingResume = new Map<string, PendingResume>();

// Serialization cache for getAllSessions() — invalidated on any session change
let sessionsCacheDirty = true;
let sessionsCache: Record<string, Session> | null = null;

function invalidateSessionsCache(): void {
  sessionsCacheDirty = true;
  sessionsCache = null;
}

// Event ring buffer for reconnect replay
const EVENT_BUFFER_MAX = 500;
let eventSeq = 0;
const eventBuffer: BufferedEvent[] = [];

/**
 * Push an event to the ring buffer for WebSocket reconnect replay.
 */
// #36: Deep-clone data before pushing to ring buffer to avoid stale references
export function pushEvent(type: string, data: unknown): number {
  eventSeq++;
  const cloned = typeof data === 'object' && data !== null
    ? JSON.parse(JSON.stringify(data))
    : data;
  eventBuffer.push({ seq: eventSeq, type, data: cloned, timestamp: Date.now() });
  if (eventBuffer.length > EVENT_BUFFER_MAX) eventBuffer.shift();
  return eventSeq;
}

export function getEventsSince(sinceSeq: number): BufferedEvent[] {
  return eventBuffer.filter(e => e.seq > sinceSeq);
}

export function getEventSeq(): number {
  return eventSeq;
}

// ---- Snapshot persistence ----
const SNAPSHOT_DIR = process.platform === 'win32'
  ? join(process.env.TEMP || process.env.TMP || 'C:\\Temp', 'claude-session-center')
  : '/tmp/claude-session-center';
const SNAPSHOT_FILE = join(SNAPSHOT_DIR, 'sessions-snapshot.json');
const SNAPSHOT_INTERVAL_MS = 10_000; // Save every 10s
let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let lastSnapshotMqOffset = 0; // Stores the MQ byte offset at snapshot time

/**
 * Check if a PID is still alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Save current sessions to a snapshot file for persistence across restarts.
 * Writes atomically (tmp file + rename).
 */
export function saveSnapshot(mqOffset?: number): void {
  try {
    if (typeof mqOffset === 'number') {
      lastSnapshotMqOffset = mqOffset;
    }
    const sessionsObj: Record<string, Session> = {};
    for (const [id, session] of sessions) {
      // Always key by sessionId to prevent Map key / sessionId divergence
      const key = session.sessionId || id;
      sessionsObj[key] = { ...session };
    }
    const countersObj: Record<string, number> = {};
    for (const [name, count] of projectSessionCounters) {
      countersObj[name] = count;
    }
    const pidObj: Record<string, string> = {};
    for (const [pid, sid] of pidToSession) pidObj[String(pid)] = sid;
    const pendingResumeObj: Record<string, PendingResume> = {};
    for (const [termId, info] of pendingResume) {
      pendingResumeObj[termId] = info;
    }
    const snapshot = {
      version: 1,
      savedAt: Date.now(),
      eventSeq,
      mqOffset: lastSnapshotMqOffset,
      sessions: sessionsObj,
      projectSessionCounters: countersObj,
      pidToSession: pidObj,
      pendingResume: pendingResumeObj,
    };
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const tmpFile = SNAPSHOT_FILE + '.tmp';
    writeFileSync(tmpFile, JSON.stringify(snapshot));
    renameSync(tmpFile, SNAPSHOT_FILE);
    log.debug('session', `Snapshot saved: ${Object.keys(sessionsObj).length} sessions`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('session', `Snapshot save failed: ${msg}`);
  }
}

/**
 * Load sessions from a snapshot file. Checks PID liveness and marks dead sessions as ended.
 */
export function loadSnapshot(): { mqOffset: number } | null {
  if (!existsSync(SNAPSHOT_FILE)) {
    log.info('session', 'No snapshot file found — starting fresh');
    return null;
  }
  try {
    const raw = readFileSync(SNAPSHOT_FILE, 'utf8');
    const snapshot = JSON.parse(raw);
    if (!snapshot || snapshot.version !== 1 || !snapshot.sessions) {
      log.warn('session', 'Snapshot file has invalid format — starting fresh');
      return null;
    }

    let restored = 0;
    let ended = 0;
    for (const [id, session] of Object.entries(snapshot.sessions) as [string, Session][]) {
      // Skip sessions that were already ended
      if (session.status === SESSION_STATUS.ENDED) {
        // Still restore ended SSH sessions (historical)
        if (session.source === 'ssh' && session.isHistorical) {
          sessions.set(id, session);
          restored++;
        }
        continue;
      }
      // Check PID liveness for active sessions
      if (session.cachedPid) {
        if (isPidAlive(session.cachedPid)) {
          if (session.source === 'ssh') {
            // SSH sessions: terminal is dead after server restart (PTY was owned
            // by the old node process). Keep session visible as idle — user can
            // reconnect or manually close it.
            session.status = SESSION_STATUS.IDLE;
            session.animationState = ANIMATION_STATE.IDLE;
            session.events = session.events || [];
            session.events.push({
              type: 'ServerRestart',
              detail: 'Server restarted — session preserved (terminal lost, process still alive)',
              timestamp: Date.now(),
            });
            session.lastTerminalId = session.terminalId;
            session.terminalId = null;
            sessions.set(id, session);
            pidToSession.set(session.cachedPid, id);
            restored++;
          } else {
            // Non-SSH (VS Code, iTerm, etc.): process can legitimately survive
            // server restart since the terminal is external
            sessions.set(id, session);
            pidToSession.set(session.cachedPid, id);
            restored++;
          }
        } else {
          // Process died while server was down — keep as idle so user can
          // see the session and manually close it when ready
          session.status = SESSION_STATUS.IDLE;
          session.animationState = ANIMATION_STATE.IDLE;
          session.cachedPid = null;
          session.events = session.events || [];
          session.events.push({
            type: 'ServerRestart',
            detail: 'Server restarted — session preserved (process ended while server was down)',
            timestamp: Date.now(),
          });
          if (session.source === 'ssh') {
            session.lastTerminalId = session.terminalId;
            session.terminalId = null;
          }
          // Keep all sessions visible — user must manually close them
          sessions.set(id, session);
          restored++;
        }
      } else {
        // No PID cached — restore as-is, processMonitor will handle it
        sessions.set(id, session);
        restored++;
      }
    }

    // Post-restoration cleanup: handle stale terminal references and zombie sessions.
    // After a server restart, ALL PTY terminals are dead (children of the old node process).
    // sshManager.terminals Map is always empty on fresh start.
    let sshCleaned = 0;
    const nonSshCleanupIds: string[] = [];
    for (const [id, session] of sessions) {
      // SSH sessions: clear stale terminalId + handle zombies
      if (session.source === 'ssh') {
        // Clear stale terminalId on ALL SSH sessions — terminals never survive restart
        if (session.terminalId) {
          if (!session.lastTerminalId) {
            session.lastTerminalId = session.terminalId;
          }
          session.terminalId = null;
        }

        // SSH sessions without cachedPid in non-ended status — keep as idle,
        // user must manually close them via the UI close button
        if (!session.cachedPid && session.status !== SESSION_STATUS.ENDED && session.status !== SESSION_STATUS.IDLE) {
          session.status = SESSION_STATUS.IDLE;
          session.animationState = ANIMATION_STATE.IDLE;
          session.events = session.events || [];
          session.events.push({
            type: 'ServerRestart',
            detail: 'Server restarted — SSH session preserved (no PID, terminal lost)',
            timestamp: Date.now(),
          });
          sshCleaned++;
        }
      } else if (session.status === SESSION_STATUS.ENDED) {
        // Non-SSH ended sessions: mark for ServerRestart event tagging (kept for auto-linking)
        nonSshCleanupIds.push(id);
      }
    }
    if (sshCleaned > 0) {
      log.info('session', `Post-restart: ${sshCleaned} SSH sessions transitioned to idle (preserved for user)`);
    }
    // Mark non-SSH ended sessions with ServerRestart event for auto-linking eligibility.
    // Sessions are NOT auto-deleted — user must manually close them via the UI.
    if (nonSshCleanupIds.length > 0) {
      for (const id of nonSshCleanupIds) {
        const s = sessions.get(id);
        if (s && !s.events?.some(e => e.type === 'ServerRestart')) {
          s.events = s.events || [];
          s.events.push({
            type: 'ServerRestart',
            detail: 'Server restarted — session preserved',
            timestamp: Date.now(),
          });
        }
      }
    }

    // Restore project session counters
    if (snapshot.projectSessionCounters) {
      for (const [name, count] of Object.entries(snapshot.projectSessionCounters) as [string, number][]) {
        projectSessionCounters.set(name, count);
      }
    }

    // Restore pidToSession map (supplements per-session PID caching above)
    if (snapshot.pidToSession) {
      for (const [pid, sid] of Object.entries(snapshot.pidToSession) as [string, string][]) {
        const numPid = Number(pid);
        // Only restore if the session exists and the PID is still alive
        if (sessions.has(sid) && isPidAlive(numPid)) {
          pidToSession.set(numPid, sid);
        }
      }
    }

    // Restore pendingResume entries — these survive Ctrl+C so Priority 0
    // can disambiguate "which session was being resumed" on next start.
    // Terminal IDs are stale (PTYs died), but the path-based fallback in
    // Priority 0 only needs oldSessionId + projectPath to match.
    let pendingResumeRestored = 0;
    if (snapshot.pendingResume) {
      for (const [termId, info] of Object.entries(snapshot.pendingResume) as [string, PendingResume][]) {
        // Only restore if the referenced session still exists in the map
        if (info.oldSessionId && sessions.has(info.oldSessionId)) {
          pendingResume.set(termId, {
            ...info,
            // Refresh timestamp so autoIdleManager's 2-minute cleanup
            // doesn't immediately garbage-collect restored entries
            timestamp: Date.now(),
          });
          pendingResumeRestored++;
        }
      }
    }

    // Restore eventSeq
    if (snapshot.eventSeq) {
      eventSeq = snapshot.eventSeq;
    }

    // Repair any Map key / sessionId mismatches (defensive — prevents duplicate cards)
    let keyRepairs = 0;
    const repairList: Array<{ oldKey: string; newKey: string; session: Session }> = [];
    for (const [id, session] of sessions) {
      if (session.sessionId && id !== session.sessionId) {
        repairList.push({ oldKey: id, newKey: session.sessionId, session });
      }
    }
    for (const { oldKey, newKey, session } of repairList) {
      sessions.delete(oldKey);
      // If the correct key already exists, keep the newer session
      if (sessions.has(newKey)) {
        const existing = sessions.get(newKey)!;
        if ((session.lastActivityAt || 0) > (existing.lastActivityAt || 0)) {
          sessions.set(newKey, session);
        }
      } else {
        sessions.set(newKey, session);
      }
      keyRepairs++;
    }
    if (keyRepairs > 0) {
      log.warn('session', `Repaired ${keyRepairs} Map key/sessionId mismatches in snapshot`);
    }

    // Deduplicate: remove sessions with identical projectPath+source that are ended
    // and whose sessionId differs (stale leftover from interrupted re-key)
    const seenPaths = new Map<string, string[]>(); // projectPath -> [sessionId, ...]
    const dupsToRemove: string[] = [];
    for (const [id, session] of sessions) {
      if (session.status !== SESSION_STATUS.ENDED || !session.projectPath) continue;
      const key = `${session.projectPath}|${session.source}`;
      if (!seenPaths.has(key)) {
        seenPaths.set(key, [id]);
      } else {
        seenPaths.get(key)!.push(id);
      }
    }
    for (const [, ids] of seenPaths) {
      if (ids.length <= 1) continue;
      // Keep the one with the most recent activity, remove the rest
      const sorted = ids
        .map(id => ({ id, lastActivity: sessions.get(id)!.lastActivityAt || 0 }))
        .sort((a, b) => b.lastActivity - a.lastActivity);
      for (let i = 1; i < sorted.length; i++) {
        dupsToRemove.push(sorted[i].id);
      }
    }
    if (dupsToRemove.length > 0) {
      for (const id of dupsToRemove) {
        sessions.delete(id);
      }
      log.info('session', `Removed ${dupsToRemove.length} duplicate ended sessions (same path+source) during snapshot load`);
    }

    invalidateSessionsCache();
    log.info('session', `Snapshot loaded: ${restored} sessions restored (preserved as idle), ${ended} already ended, ${pidToSession.size} PIDs tracked, ${pendingResumeRestored} pendingResume entries`);

    return { mqOffset: snapshot.mqOffset || 0 };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('session', `Snapshot load failed: ${msg} — starting fresh`);
    return null;
  }
}

/**
 * Start periodic snapshot saving.
 */
export function startPeriodicSave(getMqOffset?: () => number): void {
  if (snapshotTimer) return;
  snapshotTimer = setInterval(() => {
    const offset = getMqOffset ? getMqOffset() : lastSnapshotMqOffset;
    saveSnapshot(offset);
  }, SNAPSHOT_INTERVAL_MS);
}

/** Stop periodic snapshot saving. */
export function stopPeriodicSave(): void {
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
}

// Extract a short title from the first prompt (first sentence or first ~60 chars)
function makeShortTitle(prompt: string): string {
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
function summarizeToolInput(toolInput: Record<string, unknown> | undefined, toolName: string): string {
  if (!toolInput) return '';
  switch (toolName) {
    case 'Read': return (toolInput.file_path as string) || '';
    case 'Write': return (toolInput.file_path as string) || '';
    case 'Edit': return (toolInput.file_path as string) || '';
    case 'Bash': return ((toolInput.command as string) || '').substring(0, 120);
    case 'Grep': return `${(toolInput.pattern as string) || ''} in ${(toolInput.path as string) || 'cwd'}`;
    case 'Glob': return (toolInput.pattern as string) || '';
    case 'WebFetch': return (toolInput.url as string) || '';
    case 'Task': return (toolInput.description as string) || '';
    default: return JSON.stringify(toolInput).substring(0, 100);
  }
}

// Async broadcast helper — lazy imports wsManager to avoid circular deps
async function broadcastAsync(data: unknown): Promise<void> {
  const { broadcast } = await import('./wsManager.js');
  broadcast(data as { type: string; [key: string]: unknown });
}

// #48: Reduced from 50ms to 20ms for snappier real-time updates
const BROADCAST_DEBOUNCE_MS = 20;
let pendingBroadcasts: Array<{ type: string; session?: Session; [key: string]: unknown }> = [];
let broadcastDebounceTimer: ReturnType<typeof setTimeout> | null = null;

async function debouncedBroadcast(data: { type: string; session?: Session; [key: string]: unknown }): Promise<void> {
  pendingBroadcasts.push(data);
  if (broadcastDebounceTimer) return;
  broadcastDebounceTimer = setTimeout(async () => {
    const batch = pendingBroadcasts;
    pendingBroadcasts = [];
    broadcastDebounceTimer = null;
    // Deduplicate: for session_update, keep only the latest per sessionId
    const seen = new Map<string, typeof batch[number]>();
    for (const item of batch) {
      if (item.type === WS_TYPES.SESSION_UPDATE && item.session?.sessionId) {
        seen.set(item.session.sessionId, item);
      } else {
        // #40: Use type as key for non-session broadcasts to deduplicate within the batch
        // (e.g., multiple team_update events collapse to one)
        seen.set(item.type, item);
      }
    }
    for (const item of seen.values()) {
      await broadcastAsync(item);
    }
  }, BROADCAST_DEBOUNCE_MS);
}

// Broadcast helper for approval timer
async function broadcastSessionUpdate(session: Session): Promise<void> {
  await debouncedBroadcast({ type: WS_TYPES.SESSION_UPDATE, session: { ...session } });
}

/**
 * Process an incoming hook event, updating the session state machine.
 */
export function handleEvent(hookData: HookPayload): HandleEventResult | null {
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

  // Auto-revive sessions that were marked ended by ServerRestart but whose Claude process survived.
  // This happens when Claude runs in tmux/screen and keeps sending hooks after server restart.
  const REVIVABLE_EVENTS: Set<string> = new Set([
    EVENT_TYPES.SESSION_START, EVENT_TYPES.USER_PROMPT_SUBMIT,
    EVENT_TYPES.PRE_TOOL_USE, EVENT_TYPES.POST_TOOL_USE,
    EVENT_TYPES.PERMISSION_REQUEST, EVENT_TYPES.STOP,
  ]);
  if (session.status === SESSION_STATUS.ENDED
      && session.events?.some(e => e.type === 'ServerRestart')
      && REVIVABLE_EVENTS.has(hook_event_name)) {
    session.endedAt = null;
    session.isHistorical = false;
    session.events.push({
      type: 'AutoRevived',
      detail: `Session auto-revived on ${hook_event_name} — process survived server restart`,
      timestamp: Date.now(),
    });
    log.info('session', `AUTO-REVIVE: session ${session_id?.slice(0,8)} revived on ${hook_event_name}`);
  }

  invalidateSessionsCache();
  session.lastActivityAt = Date.now();
  const eventEntry: SessionEvent = {
    type: hook_event_name,
    timestamp: Date.now(),
    detail: ''
  };

  switch (hook_event_name) {
    case EVENT_TYPES.SESSION_START: {
      session.status = SESSION_STATUS.IDLE;
      session.animationState = ANIMATION_STATE.IDLE;
      session.model = hookData.model || session.model;
      if ('transcript_path' in hookData && hookData.transcript_path) session.transcriptPath = hookData.transcript_path;
      if ('permission_mode' in hookData && hookData.permission_mode) session.permissionMode = hookData.permission_mode;

      // Update projectPath from the hook's actual cwd — ONLY for SSH sessions.
      // For remote SSH, createTerminalSession resolves '~' to LOCAL homedir
      // (e.g. /Users/kason) but the hook reports the REMOTE cwd (e.g. /home/user/project).
      // Without this correction, Priority 0 path matching fails on resume/reconnect.
      // Display-only sessions (VS Code, Terminal, iTerm, etc.) already have the
      // correct path from createDefaultSession — don't touch them to avoid
      // overwriting their source-derived projectName.
      if (cwd && cwd !== session.projectPath && session.source === 'ssh') {
        const oldPath = session.projectPath;
        session.projectPath = cwd;
        session.projectName = cwd.split('/').filter(Boolean).pop() || session.projectName;
        // Preserve source — NEVER overwrite (VS Code, Terminal, ssh, etc.)
        log.info('session', `Updated SSH projectPath: ${oldPath} → ${cwd} (from hook cwd)`);
      }

      eventEntry.detail = `Session started (${('source' in hookData ? hookData.source : undefined) || 'startup'})`;
      log.debug('session', `SessionStart: ${session_id?.slice(0,8)} project=${session.projectName} model=${session.model}`);

      // Priority 0: Direct link via CLAUDE_CODE_PARENT_SESSION_ID env var
      let teamResult: { teamId: string; team: TeamSerialized } | null = null;
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
      session.currentPrompt = ('prompt' in hookData ? hookData.prompt : undefined) || '';
      session.promptHistory.push({
        text: ('prompt' in hookData ? hookData.prompt : undefined) || '',
        timestamp: Date.now()
      });
      // Keep last 50 prompts
      if (session.promptHistory.length > 50) session.promptHistory.shift();
      eventEntry.detail = (('prompt' in hookData ? hookData.prompt : undefined) || '').substring(0, 80);

      // Auto-generate title from project name + label + counter + short prompt summary
      if (!session.title) {
        const counter = projectSessionCounters.get(session.projectName) || 1;
        const labelPart = session.label ? ` ${session.label}` : '';
        const shortPrompt = makeShortTitle(('prompt' in hookData ? hookData.prompt : undefined) || '');
        session.title = shortPrompt
          ? `${session.projectName}${labelPart} #${counter} — ${shortPrompt}`
          : `${session.projectName}${labelPart} — Session #${counter}`;
      }
      break;

    case EVENT_TYPES.PRE_TOOL_USE: {
      session.status = SESSION_STATUS.WORKING;
      session.animationState = ANIMATION_STATE.RUNNING;
      const toolName = ('tool_name' in hookData ? hookData.tool_name : undefined) || 'Unknown';
      session.toolUsage[toolName] = (session.toolUsage[toolName] || 0) + 1;
      session.totalToolCalls++;
      // Store detailed tool log entry for the detail panel
      const toolInputSummary = summarizeToolInput(
        ('tool_input' in hookData ? hookData.tool_input : undefined) as Record<string, unknown> | undefined,
        toolName
      );
      session.toolLog.push({
        tool: toolName,
        input: toolInputSummary,
        timestamp: Date.now()
      });
      if (session.toolLog.length > 200) session.toolLog.shift();
      eventEntry.detail = `${toolName}`;

      // Approval/input detection via timer (delegated to approvalDetector)
      startApprovalTimer(session_id, session, toolName, toolInputSummary, broadcastSessionUpdate, (sid) => sessions.get(sid));
      break;
    }

    case EVENT_TYPES.POST_TOOL_USE:
      // Tool completed — cancel approval timer, stay working
      clearApprovalTimer(session_id, session);
      session.status = SESSION_STATUS.WORKING;
      eventEntry.detail = `${('tool_name' in hookData ? hookData.tool_name : undefined) || 'Tool'} completed`;
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
      const responseText = ('response' in hookData ? hookData.response : undefined)
        || ('message' in hookData ? hookData.message : undefined)
        || ('stop_reason_str' in hookData ? hookData.stop_reason_str : undefined)
        || '';
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
      const permTool = ('tool_name' in hookData ? hookData.tool_name : undefined) || session.pendingTool || 'Unknown';
      session.status = SESSION_STATUS.APPROVAL;
      session.animationState = ANIMATION_STATE.WAITING;
      session.waitingDetail = ('tool_input' in hookData && hookData.tool_input)
        ? `Approve ${permTool}: ${summarizeToolInput(hookData.tool_input as Record<string, unknown>, permTool)}`
        : `Approve ${permTool}`;
      session.permissionMode = ('permission_mode' in hookData ? hookData.permission_mode : undefined) || null;
      eventEntry.detail = `Permission request: ${permTool}`;
      break;
    }

    case EVENT_TYPES.POST_TOOL_USE_FAILURE: {
      // Tool call failed — cancel approval timer, mark the failure in tool log
      clearApprovalTimer(session_id, session);
      session.status = SESSION_STATUS.WORKING;
      const failedTool = ('tool_name' in hookData ? hookData.tool_name : undefined) || 'Tool';
      // Mark last tool log entry as failed if it matches
      if (session.toolLog.length > 0) {
        const lastEntry = session.toolLog[session.toolLog.length - 1];
        if (lastEntry.tool === failedTool && !lastEntry.failed) {
          lastEntry.failed = true;
          lastEntry.error = ('error' in hookData ? hookData.error : undefined)
            || ('message' in hookData ? hookData.message : undefined)
            || 'Failed';
        }
      }
      const errorMsg = ('error' in hookData ? hookData.error : undefined);
      eventEntry.detail = `${failedTool} failed${errorMsg ? ': ' + errorMsg.substring(0, 80) : ''}`;
      break;
    }

    case EVENT_TYPES.TEAMMATE_IDLE:
      eventEntry.detail = `Teammate idle: ${hookData.agent_name || hookData.agent_id || 'unknown'}`;
      break;

    case EVENT_TYPES.TASK_COMPLETED:
      eventEntry.detail = `Task completed: ${('task_description' in hookData ? hookData.task_description : undefined) || ('task_id' in hookData ? hookData.task_id : undefined) || 'unknown'}`;
      session.emote = EMOTE.THUMBS_UP;
      break;

    case EVENT_TYPES.PRE_COMPACT:
      eventEntry.detail = 'Context compaction starting';
      break;

    case EVENT_TYPES.NOTIFICATION:
      eventEntry.detail = ('message' in hookData ? hookData.message : undefined)
        || ('title' in hookData ? hookData.title : undefined)
        || 'Notification';
      break;

    case EVENT_TYPES.SESSION_END:
      session.status = SESSION_STATUS.ENDED;
      session.animationState = ANIMATION_STATE.DEATH;
      session.endedAt = Date.now();
      eventEntry.detail = `Session ended (${('reason' in hookData ? hookData.reason : undefined) || 'unknown'})`;

      // Release PID cache for this session
      if (session.cachedPid) {
        log.debug('session', `releasing pid=${session.cachedPid} from session=${session_id?.slice(0,8)}`);
        pidToSession.delete(session.cachedPid);
        session.cachedPid = null;
      }

      // Team cleanup (delegated to teamManager)
      handleTeamMemberEnd(session_id, sessions);

      // Keep all ended sessions in memory — user must manually close via UI close button
      if (session.source === 'ssh') {
        session.isHistorical = true;
        session.lastTerminalId = session.terminalId;
        session.terminalId = null;
      }
      // Non-SSH sessions are also kept (no auto-delete)
      break;
  }

  // Keep last 50 events
  session.events.push(eventEntry);
  if (session.events.length > 50) session.events.shift();

  // Persist to SQLite on key state transitions
  const DB_PERSIST_EVENTS: Set<string> = new Set([
    EVENT_TYPES.SESSION_START, EVENT_TYPES.USER_PROMPT_SUBMIT,
    EVENT_TYPES.STOP, EVENT_TYPES.SESSION_END,
  ]);
  if (DB_PERSIST_EVENTS.has(hook_event_name)) {
    dbUpsertSession(session);
  }

  const result: HandleEventResult = { session: { ...session } };
  // Migrate DB records when session is re-keyed (e.g., after claude --resume)
  if (session.replacesId) {
    dbMigrateSessionId(session.replacesId, session_id);
  }
  // Clean up one-time re-key flag
  delete session.replacesId;
  // Include team info if session belongs to a team
  const teamId = getTeamIdForSession(session_id);
  if (teamId) {
    const teamData = getTeam(teamId);
    if (teamData) result.team = teamData;
  }

  // Push to ring buffer for reconnect replay
  pushEvent(WS_TYPES.SESSION_UPDATE, result);

  return result;
}

export function getAllSessions(): Record<string, Session> {
  if (!sessionsCacheDirty && sessionsCache) {
    return sessionsCache;
  }
  const result: Record<string, Session> = {};
  for (const [id, session] of sessions) {
    // Defensive: always key by session.sessionId to prevent key mismatch bugs.
    // If Map key diverged from sessionId (e.g., after re-key edge case), fix it.
    const key = session.sessionId || id;
    if (id !== key) {
      log.warn('session', `Key mismatch: Map key=${id?.slice(0,8)} vs sessionId=${key?.slice(0,8)} — using sessionId`);
    }
    result[key] = { ...session };
  }
  sessionsCache = result;
  sessionsCacheDirty = false;
  return result;
}

export function getSession(sessionId: string): Session | null {
  const s = sessions.get(sessionId);
  return s ? { ...s } : null;
}

/**
 * Create a session card immediately when SSH terminal connects (before hooks arrive).
 */
export async function createTerminalSession(terminalId: string, config: TerminalConfig): Promise<Session> {
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
  const session: Session = {
    sessionId: terminalId,
    projectPath: workDir,
    projectName,
    label: config.label || '',
    title: config.sessionTitle || defaultTitle,
    status: SESSION_STATUS.CONNECTING as Session['status'],
    animationState: ANIMATION_STATE.WALKING,
    emote: EMOTE.WAVE,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    endedAt: null,
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
    sshConfig: {
      host: config.host || 'localhost',
      port: config.port || 22,
      username: config.username,
      authMethod: config.authMethod || 'key',
      privateKeyPath: config.privateKeyPath,
      workingDir: config.workingDir || '~',
      command: config.command || 'claude',
    },
  };
  sessions.set(terminalId, session);
  invalidateSessionsCache();
  dbUpsertSession(session);

  log.info('session', `Created terminal session ${terminalId} → ${config.host}:${workDir}`);

  await broadcastAsync({ type: WS_TYPES.SESSION_UPDATE, session: { ...session } });

  // Non-Claude CLIs (codex, gemini, etc.) don't send hooks — auto-transition to idle
  const command = config.command || 'claude';
  if (!command.startsWith('claude')) {
    setTimeout(async () => {
      const s = sessions.get(terminalId);
      if (s && s.status === (SESSION_STATUS.CONNECTING as string)) {
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

export function linkTerminalToSession(sessionId: string, terminalId: string): Session | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.terminalId = terminalId;
  invalidateSessionsCache();
  return { ...session };
}

export function updateQueueCount(sessionId: string, count: number): Session | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.queueCount = count || 0;
  invalidateSessionsCache();
  return { ...session };
}

export function killSession(sessionId: string): Session | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  invalidateSessionsCache();
  // #20: Close PTY before unlinking to prevent orphan processes
  if (session.terminalId) {
    closeTerminal(session.terminalId);
  }
  session.status = SESSION_STATUS.ENDED;
  session.animationState = ANIMATION_STATE.DEATH;
  session.archived = 1;
  session.lastActivityAt = Date.now();
  session.endedAt = Date.now();
  if (session.source === 'ssh') {
    session.isHistorical = true;
    session.lastTerminalId = session.terminalId;
    session.terminalId = null;
  } else {
    setTimeout(() => sessions.delete(sessionId), 10000);
  }
  return { ...session };
}

export function deleteSessionFromMemory(sessionId: string): boolean {
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

export function setSessionTitle(sessionId: string, title: string): Session | null {
  const session = sessions.get(sessionId);
  if (session) { session.title = title; invalidateSessionsCache(); dbUpdateTitle(sessionId, title); }
  return session ? { ...session } : null;
}

export function setSessionLabel(sessionId: string, label: string): Session | null {
  const session = sessions.get(sessionId);
  if (session) { session.label = label; invalidateSessionsCache(); dbUpdateLabel(sessionId, label); }
  return session ? { ...session } : null;
}

export function setSummary(sessionId: string, summary: string): Session | null {
  const session = sessions.get(sessionId);
  if (session) { session.summary = summary; invalidateSessionsCache(); dbUpdateSummary(sessionId, summary); }
  return session ? { ...session } : null;
}

export function setSessionAccentColor(sessionId: string, color: string): void {
  const session = sessions.get(sessionId);
  if (session) { session.accentColor = color; invalidateSessionsCache(); }
}

export function setSessionCharacterModel(sessionId: string, model: string): Session | null {
  const session = sessions.get(sessionId);
  if (session) { session.characterModel = model; invalidateSessionsCache(); }
  return session ? { ...session } : null;
}

export function archiveSession(sessionId: string, archived: boolean | number): Session | null {
  const session = sessions.get(sessionId);
  if (session) { session.archived = archived ? 1 : 0; invalidateSessionsCache(); dbUpdateArchived(sessionId, archived); }
  return session ? { ...session } : null;
}

/**
 * Resume a disconnected SSH session — sends claude --resume with --continue fallback.
 */
export function resumeSession(sessionId: string): { error: string } | { ok: true; terminalId: string; session: Session } {
  const session = sessions.get(sessionId);
  if (!session) return { error: 'Session not found' };
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

  // #38: Clear stale PID cache before resume to prevent mismatched PID references
  if (session.cachedPid) {
    pidToSession.delete(session.cachedPid);
    session.cachedPid = null;
  }

  // Register pending resume
  pendingResume.set(session.lastTerminalId, {
    oldSessionId: sessionId,
    timestamp: Date.now(),
  });

  // Restore terminal link and transition to connecting
  session.terminalId = session.lastTerminalId;
  session.status = SESSION_STATUS.CONNECTING as Session['status'];
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

/**
 * Reconnect an ended SSH session to a newly created terminal.
 * Used when the original terminal died (server restart) and a new one was created.
 * Updates the REAL session in the Map and registers pendingResume for hook matching.
 */
export function reconnectSessionTerminal(sessionId: string, newTerminalId: string): { error: string } | { ok: true; session: Session } {
  const session = sessions.get(sessionId);
  if (!session) return { error: 'Session not found' };

  // Archive current session data (same as resumeSession)
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
  if (session.previousSessions.length > 5) session.previousSessions.shift();

  // Register pending resume so session matching can link new Claude hooks
  pendingResume.set(newTerminalId, {
    oldSessionId: sessionId,
    timestamp: Date.now(),
  });

  // Update the REAL session (not a copy)
  session.terminalId = newTerminalId;
  session.lastTerminalId = newTerminalId;
  session.status = SESSION_STATUS.CONNECTING as Session['status'];
  session.animationState = ANIMATION_STATE.WALKING;
  session.emote = EMOTE.WAVE;
  session.isHistorical = false;
  session.endedAt = null;
  session.lastActivityAt = Date.now();
  session.events.push({
    type: 'ResumeNewTerminal',
    timestamp: Date.now(),
    detail: `New terminal ${newTerminalId?.slice(0, 8)} for claude --resume || --continue`,
  });

  invalidateSessionsCache();
  log.info('session', `RECONNECT: session ${sessionId?.slice(0, 8)} → new terminal ${newTerminalId?.slice(0, 8)}`);

  return { ok: true, session: { ...session } };
}

export function detectSessionSource(sessionId: string): string {
  const session = sessions.get(sessionId);
  if (!session) return 'unknown';
  return session.source || 'ssh';
}

// Wrapper for findClaudeProcess that passes internal state
export function findClaudeProcess(sessionId: string, projectPath: string): number | null {
  return _findClaudeProcess(sessionId, projectPath, sessions, pidToSession);
}

// ---- #21: Register terminal exit callback to unbind session when PTY dies ----
registerTerminalExitCallback((terminalId: string) => {
  for (const [_id, session] of sessions) {
    if (session.terminalId === terminalId) {
      session.lastTerminalId = terminalId;
      session.terminalId = null;
      invalidateSessionsCache();
      log.info('session', `Terminal ${terminalId} exited — unlinked from session ${_id.slice(0, 8)}`);
      break;
    }
  }
});

// ---- Start background monitors ----

// Auto-idle transitions
startAutoIdle(sessions);

// Process liveness monitoring
startMonitoring(
  sessions,
  pidToSession,
  clearApprovalTimer,
  (sid: string) => handleTeamMemberEnd(sid, sessions),
  broadcastAsync
);

// Clean up stale pendingResume entries
startPendingResumeCleanup(pendingResume, sessions, broadcastAsync);

// ---- Re-exports from sub-modules for backward compatibility ----
// External files (apiRouter, wsManager, hookProcessor, index) should not need to change their imports
export { getAllTeams, getTeam, getTeamForSession } from './teamManager.js';
export { hasChildProcesses } from './approvalDetector.js';

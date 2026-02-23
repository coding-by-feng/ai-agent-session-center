/**
 * @module processMonitor
 * Periodically checks whether session PIDs are still alive via process.kill(pid, 0).
 * Auto-ends sessions whose processes have died (e.g., terminal closed abruptly).
 * Also provides findClaudeProcess() with cached PID, pgrep, and lsof fallbacks.
 */
import { execSync } from 'child_process';
import { getTerminalForSession } from './sshManager.js';
import { SESSION_STATUS, ANIMATION_STATE, WS_TYPES } from './constants.js';
import { PROCESS_CHECK_INTERVAL } from './config.js';
import log from './logger.js';
import type { Session } from '../src/types/session.js';
import type { ServerMessage } from '../src/types/websocket.js';

// Validate PID as a positive integer. Returns the validated number or null.
function validatePid(pid: unknown): number | null {
  const n = parseInt(String(pid), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

let livenessInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the process liveness monitor.
 * Periodically checks if session PIDs are still alive and auto-ends dead sessions.
 */
export function startMonitoring(
  sessions: Map<string, Session>,
  pidToSession: Map<number, string>,
  clearApprovalTimerFn: (sessionId: string, session: Session) => void,
  handleTeamMemberEndFn: (sessionId: string) => void,
  broadcastFn: (data: ServerMessage) => Promise<void>,
): void {
  if (livenessInterval) return;

  livenessInterval = setInterval(async () => {
    for (const [id, session] of sessions) {
      // #43: Defensive check — session may have been deleted by another part of the code
      if (!sessions.has(id)) continue;
      if (session.status === SESSION_STATUS.ENDED) continue;
      if (!session.cachedPid) continue;
      const monitorPid = validatePid(session.cachedPid);
      if (!monitorPid) {
        session.cachedPid = null;
        continue;
      }

      // Skip sessions with active terminal — the PTY is the source of truth
      if (session.terminalId && getTerminalForSession(id)) continue;

      try {
        process.kill(monitorPid, 0); // signal 0 = liveness check, doesn't kill
      } catch {
        // Process is dead — auto-end this session
        log.info('session', `processMonitor: pid=${session.cachedPid} is dead -> ending session=${id.slice(0, 8)}`);

        session.status = SESSION_STATUS.ENDED;
        session.animationState = ANIMATION_STATE.DEATH;
        session.lastActivityAt = Date.now();
        session.endedAt = Date.now();

        session.events.push({
          type: 'SessionEnd',
          timestamp: Date.now(),
          detail: 'Session ended (process exited)',
        });
        if (session.events.length > 50) session.events.shift();

        // Release PID cache
        pidToSession.delete(session.cachedPid);
        session.cachedPid = null;

        // Clear any pending tool timer
        clearApprovalTimerFn(id, session);

        // Team cleanup
        handleTeamMemberEndFn(id);

        // Broadcast to connected browsers
        try {
          await broadcastFn({ type: WS_TYPES.SESSION_UPDATE, session: { ...session } });
        } catch (e: unknown) {
          log.warn('session', `processMonitor broadcast failed: ${(e as Error).message}`);
        }

        // Keep all sessions in memory — user must manually close via UI close button
        if (session.source === 'ssh') {
          session.isHistorical = true;
          session.lastTerminalId = session.terminalId;
          session.terminalId = null;
        }
        // Non-SSH sessions are also kept (no auto-delete)
      }
    }
  }, PROCESS_CHECK_INTERVAL);
}

/**
 * Stop the process liveness monitor.
 */
export function stopMonitoring(): void {
  if (livenessInterval) {
    clearInterval(livenessInterval);
    livenessInterval = null;
  }
}

/**
 * Find the Claude process PID for a given session.
 * Uses cached PID first, then falls back to pgrep/lsof.
 */
export function findClaudeProcess(
  sessionId: string,
  projectPath: string,
  sessions: Map<string, Session>,
  pidToSession: Map<number, string>,
): number | null {
  const session = sessionId ? sessions.get(sessionId) : null;
  if (session?.cachedPid) {
    const validCachedPid = validatePid(session.cachedPid);
    if (validCachedPid) {
      try {
        process.kill(validCachedPid, 0); // signal 0 = liveness check
        log.debug('findProcess', `session=${sessionId?.slice(0, 8)} -> cached pid=${validCachedPid}`);
        return validCachedPid;
      } catch {
        log.debug('findProcess', `session=${sessionId?.slice(0, 8)} cached pid=${validCachedPid} is dead, re-scanning`);
        pidToSession.delete(validCachedPid);
        session.cachedPid = null;
      }
    } else {
      session.cachedPid = null;
    }
  }

  const myPid = process.pid;
  log.debug('findProcess', `session=${sessionId?.slice(0, 8)} projectPath=${projectPath}`);

  const claimedPids = new Set<number>();
  for (const [pid, sid] of pidToSession) {
    if (sid !== sessionId) claimedPids.add(pid);
  }
  if (claimedPids.size > 0) {
    log.debug('findProcess', `PIDs claimed by other sessions: [${[...claimedPids].join(', ')}]`);
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
      const pid = validatePid(out.trim());
      if (pid) cachePid(pid, sessionId, session, pidToSession);
      return pid || null;
    } else {
      const pidsOut = execSync(`pgrep -f claude 2>/dev/null || true`, { encoding: 'utf-8', timeout: 5000 });
      const pids = pidsOut.trim().split('\n')
        .map(p => validatePid(p.trim()))
        .filter((p): p is number => p !== null && p !== myPid);

      log.debug('findProcess', `pgrep found ${pids.length} claude pids: [${pids.join(', ')}]`);

      if (pids.length === 0) return null;

      if (projectPath) {
        for (const pid of pids) {
          if (claimedPids.has(pid)) {
            log.debug('findProcess', `pid=${pid} SKIP (claimed by session ${pidToSession.get(pid)?.slice(0, 8)})`);
            continue;
          }
          try {
            let cwd: string;
            if (process.platform === 'darwin') {
              const out = execSync(`lsof -a -d cwd -Fn -p ${pid} 2>/dev/null | grep '^n'`, { encoding: 'utf-8', timeout: 3000 });
              cwd = out.trim().replace(/^n/, '');
            } else {
              cwd = execSync(`readlink /proc/${pid}/cwd 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 }).trim();
            }
            const match = cwd === projectPath;
            log.debug('findProcess', `pid=${pid} cwd="${cwd}" ${match ? 'MATCH' : 'no match'}`);
            if (match) {
              cachePid(pid, sessionId, session, pidToSession);
              return pid;
            }
          } catch (e: unknown) {
            log.debug('findProcess', `pid=${pid} cwd lookup failed: ${(e as Error).message?.split('\n')[0]}`);
            continue;
          }
        }
        log.debug('findProcess', `no cwd match found, trying tty fallback`);
      }

      for (const pid of pids) {
        if (claimedPids.has(pid)) continue;
        try {
          const tty = execSync(`ps -o tty= -p ${pid}`, { encoding: 'utf-8', timeout: 3000 }).trim();
          log.debug('findProcess', `fallback pid=${pid} tty=${tty || 'NONE'}`);
          if (tty && tty !== '??' && tty !== '?') {
            log.debug('findProcess', `FALLBACK returning pid=${pid} (first unclaimed with tty)`);
            cachePid(pid, sessionId, session, pidToSession);
            return pid;
          }
        } catch { continue; }
      }

      const unclaimed = pids.find(p => !claimedPids.has(p));
      log.debug('findProcess', `last resort returning pid=${unclaimed || 'null'}`);
      if (unclaimed) cachePid(unclaimed, sessionId, session, pidToSession);
      return unclaimed || null;
    }
  } catch (e: unknown) {
    log.error('findProcess', `ERROR: ${(e as Error).message}`);
  }
  return null;
}

function cachePid(
  pid: number,
  sessionId: string,
  session: Session | null | undefined,
  pidToSession: Map<number, string>,
): void {
  pidToSession.set(pid, sessionId);
  if (session) session.cachedPid = pid;
  log.debug('findProcess', `CACHED pid=${pid} -> session=${sessionId?.slice(0, 8)}`);
}

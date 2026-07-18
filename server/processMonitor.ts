/**
 * @module processMonitor
 * Periodically checks whether session PIDs are still alive via process.kill(pid, 0).
 * Auto-ends sessions whose processes have died (e.g., terminal closed abruptly).
 * Also provides findClaudeProcess() with cached PID, pgrep, and lsof fallbacks.
 */
import { execSync, execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { getTerminalForSession } from './sshManager.js';

const execFileAsync = promisify(execFile);
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

// ---------------------------------------------------------------------------
// External session discovery (Mechanism B)
//
// The liveness monitor above only tracks sessions it already knows about, and
// sessionMatcher only creates cards from hook events. A Claude CLI started before
// hooks were installed fires NO hooks and would never appear. This pass scans the
// OS for interactive `claude` processes with a real tty that aren't already
// tracked, and hands each to a register callback (sessionStore.registerDiscoveredSession),
// which creates a thin external card. If a hook later fires for that PID, the
// cached-PID re-key (sessionMatcher Priority 1.5) upgrades the card in place.
// ---------------------------------------------------------------------------

/** How often to scan for untracked external claude sessions. */
const EXTERNAL_DISCOVERY_INTERVAL_MS = 20_000;

let discoveryInterval: ReturnType<typeof setInterval> | null = null;

/** Metadata scraped from a bare OS process — everything a hook would otherwise carry. */
export interface DiscoveredProcess {
  pid: number;
  tty: string;
  cwd: string;
  /** Parsed `-n <label>` session name, if present. */
  name: string | null;
  /** Parsed `--model <id>`, if present. */
  model: string | null;
}

/** True only for an interactive `claude` CLI — not daemon/pty-host/mcp/print infra. */
export function isInteractiveClaude(args: string): boolean {
  const first = args.split(/\s+/)[0] || '';
  const base = first.split('/').pop() || first;
  if (base !== 'claude') return false;
  // Exclude the background daemon, spare PTY hosts, MCP servers, and any
  // non-interactive/headless invocation (stream-json workers, --print).
  if (/(^|\s)(daemon|bg-pty-host|bg-spare)(\s|$)/.test(args)) return false;
  if (/(--print|stream-json|--output-format|mcp-server|mcp\s)/.test(args)) return false;
  return true;
}

/** Extract the `-n <name>` label (names may contain spaces; runs until the next flag). */
export function parseNameFlag(args: string): string | null {
  const idx = args.indexOf(' -n ');
  if (idx < 0) return null;
  const rest = args.slice(idx + 4);
  const cut = rest.search(/\s--/);
  const name = (cut >= 0 ? rest.slice(0, cut) : rest).trim();
  return name || null;
}

/** Extract `--model <id>`. */
export function parseModelFlag(args: string): string | null {
  const m = args.match(/--model\s+(\S+)/);
  return m ? m[1] : null;
}

/** Resolve a PID's working directory (darwin: lsof, linux: /proc). Best-effort, async. */
async function resolveCwd(pid: number): Promise<string> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', String(pid)], {
        timeout: 3000,
      });
      const nLine = stdout.split('\n').find((l) => l.startsWith('n'));
      return nLine ? nLine.slice(1).trim() : '';
    }
    const { stdout } = await execFileAsync('readlink', [`/proc/${pid}/cwd`], { timeout: 3000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * One discovery pass: find untracked interactive claude sessions and register them.
 * Fully async (execFile, not execFileSync) so the periodic scan never blocks the
 * event loop — hook processing, WS relays, and HTTP stay responsive during the pass.
 */
async function discoverExternalSessions(
  sessions: Map<string, Session>,
  pidToSession: Map<number, string>,
  registerDiscovered: (proc: DiscoveredProcess) => void,
): Promise<void> {
  let pidsOut = '';
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', 'claude'], { timeout: 5000 });
    pidsOut = stdout;
  } catch {
    return; // pgrep exits non-zero when no matches
  }
  const myPid = process.pid;
  const pids = pidsOut
    .trim()
    .split('\n')
    .map((p) => validatePid(p.trim()))
    .filter((p): p is number => p !== null && p !== myPid);
  if (pids.length === 0) return;

  // Everything already bound to a session (by hook or a prior discovery pass).
  const tracked = new Set<number>(pidToSession.keys());
  for (const s of sessions.values()) if (s.cachedPid) tracked.add(s.cachedPid);

  for (const pid of pids) {
    if (tracked.has(pid)) continue;
    let args = '';
    let tty = '';
    try {
      const [aRes, tRes] = await Promise.all([
        execFileAsync('ps', ['-o', 'args=', '-p', String(pid)], { timeout: 3000 }),
        execFileAsync('ps', ['-o', 'tty=', '-p', String(pid)], { timeout: 3000 }),
      ]);
      args = aRes.stdout.trim();
      tty = tRes.stdout.trim();
    } catch {
      continue; // process vanished between pgrep and ps
    }
    if (!isInteractiveClaude(args)) continue;
    if (!tty || tty === '??' || tty === '?') continue; // interactive sessions have a real tty
    registerDiscovered({
      pid,
      tty,
      cwd: await resolveCwd(pid),
      name: parseNameFlag(args),
      model: parseModelFlag(args),
    });
  }
}

let discoveryRunning = false;

/**
 * Start the external-session discovery scan. No-op on Windows (ps/lsof based).
 * A re-entrancy guard prevents overlapping passes if one runs long.
 */
export function startExternalDiscovery(
  sessions: Map<string, Session>,
  pidToSession: Map<number, string>,
  registerDiscovered: (proc: DiscoveredProcess) => void,
): void {
  if (discoveryInterval) return;
  if (process.platform === 'win32') return;
  discoveryInterval = setInterval(() => {
    if (discoveryRunning) return;
    discoveryRunning = true;
    void discoverExternalSessions(sessions, pidToSession, registerDiscovered)
      .catch((e: unknown) => log.debug('session', `external discovery pass failed: ${(e as Error).message}`))
      .finally(() => {
        discoveryRunning = false;
      });
  }, EXTERNAL_DISCOVERY_INTERVAL_MS);
}

/** Stop the external-session discovery scan. */
export function stopExternalDiscovery(): void {
  if (discoveryInterval) {
    clearInterval(discoveryInterval);
    discoveryInterval = null;
  }
}

/** Is a PID currently alive? (signal 0 = probe, doesn't actually signal.) */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a PID's process-group id, falling back to the PID itself. */
function resolvePgid(pid: number): number {
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    const parsed = parseInt(out, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {
    /* process may already be gone, or ps unavailable — fall through */
  }
  return pid;
}

/**
 * Terminate a process AND its whole process group, escalating SIGTERM -> SIGKILL,
 * then verify death.
 *
 * Why the group: AI CLI agents run as  PTY -> /bin/zsh -l -> claude , and `claude`
 * puts itself in its OWN process group (verified across live sessions). A bare
 * `process.kill(pid, 'SIGTERM')` — or node-pty's SIGHUP-to-the-shell — leaves the
 * agent and its child tool/MCP tree orphaned to launchd. Signalling the negative
 * pgid reaps the entire tree. We fall back to the bare PID if the group signal
 * throws (ESRCH/EPERM), and escalate to the uncatchable SIGKILL if the agent
 * traps SIGTERM (e.g. `& disown`ed hook jobs, a shell with NO_HUP).
 *
 * @returns true if the process is confirmed dead (or was never alive), false if
 *          it survived even SIGKILL.
 */
export async function terminateProcessTree(pid: unknown): Promise<boolean> {
  const validPid = validatePid(pid);
  if (!validPid) return true; // nothing to kill -> treat as dead
  if (!pidAlive(validPid)) return true;

  const pgid = resolvePgid(validPid);
  const signal = (sig: NodeJS.Signals) => {
    // Prefer the group so child tools/MCP servers die too; fall back to the pid.
    try {
      process.kill(-pgid, sig);
    } catch {
      try {
        process.kill(validPid, sig);
      } catch {
        /* already dead */
      }
    }
  };

  signal('SIGTERM');

  // Poll for graceful exit before escalating (up to ~2s).
  const termDeadline = Date.now() + 2000;
  while (Date.now() < termDeadline) {
    if (!pidAlive(validPid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }

  // Survived SIGTERM — escalate to the uncatchable SIGKILL and verify (up to ~1s).
  signal('SIGKILL');
  const killDeadline = Date.now() + 1000;
  while (Date.now() < killDeadline) {
    if (!pidAlive(validPid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !pidAlive(validPid);
}

/**
 * Best-effort reap of a PTY shell's descendant process groups. Called when a
 * terminal/PTY is closed: the login shell's direct children (the agent, e.g.
 * `claude`) each live in their own process group, so killing only the shell
 * (what node-pty's pty.kill() does) orphans them. We enumerate the shell's
 * children via `pgrep -P` and group-terminate each. Fire-and-forget — the caller
 * (closeTerminal) stays synchronous and must not block on process teardown.
 */
export function reapPtyChildren(shellPid: unknown): void {
  const validPid = validatePid(shellPid);
  if (!validPid) return;
  let children: number[] = [];
  try {
    const out = execFileSync('pgrep', ['-P', String(validPid)], {
      encoding: 'utf8',
    }).trim();
    children = out
      .split(/\s+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    /* no children, or pgrep unavailable */
  }
  for (const child of children) {
    void terminateProcessTree(child);
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
      let pidsOut: string;
      try {
        pidsOut = execFileSync('pgrep', ['-f', 'claude'], { encoding: 'utf-8', timeout: 5000 });
      } catch {
        pidsOut = ''; // pgrep exits non-zero when no matches
      }
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
              const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', String(pid)], { encoding: 'utf-8', timeout: 3000 });
              const nLine = out.split('\n').find(l => l.startsWith('n'));
              cwd = nLine ? nLine.slice(1).trim() : '';
            } else {
              cwd = execFileSync('readlink', [`/proc/${pid}/cwd`], { encoding: 'utf-8', timeout: 3000 }).trim();
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
          const tty = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf-8', timeout: 3000 }).trim();
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

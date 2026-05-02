// sshManager.ts — PTY-based terminal multiplexer using node-pty
// Manages terminal lifecycle for local and remote (via native ssh) sessions.
// Terminal I/O is relayed through WebSocket to xterm.js in the browser.

import pty from 'node-pty';
import type { IPty, IDisposable } from 'node-pty';
import { execFile, execSync } from 'child_process';
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, networkInterfaces, hostname as osHostname } from 'os';
import log from './logger.js';
import { appendSessionName } from './config.js';
import type { Terminal, TerminalConfig, TerminalInfo, TmuxSessionInfo, SshKeyInfo } from '../src/types/terminal.js';
import type { PendingLink } from '../src/types/session.js';
import type WebSocket from 'ws';

// Callback type for notifying session store of terminal exit
type OnTerminalExitCallback = (terminalId: string) => void;
let onTerminalExitCallback: OnTerminalExitCallback | null = null;

/**
 * Register a callback invoked when a PTY exits, allowing the session store
 * to clear session.terminalId and broadcast the update.
 */
export function registerTerminalExitCallback(cb: OnTerminalExitCallback): void {
  onTerminalExitCallback = cb;
}

// ---- Input Validation Helpers ----

// Shell metacharacters that indicate injection attempts
const SHELL_META_RE = /[;|&$`\\!><()\n\r{}[\]]/;

// tmuxSession names: alphanumeric, dash, underscore, dot only
const TMUX_SESSION_RE = /^[a-zA-Z0-9_.\-]+$/;

function validateWorkingDir(dir: string | undefined): string | null {
  if (!dir) return null;
  if (typeof dir !== 'string') return 'workingDir must be a string';
  if (dir.length > 1024) return 'workingDir too long';
  // Allow ~ at start, then normal path chars
  if (SHELL_META_RE.test(dir.replace(/^~/, ''))) return 'workingDir contains invalid characters';
  return null;
}

function validateCommand(cmd: string | undefined): string | null {
  if (!cmd) return null;
  if (typeof cmd !== 'string') return 'command must be a string';
  if (cmd.length > 512) return 'command too long';
  // Allow known CLI commands with flags, but reject shell metacharacters
  if (/[;|&$`\\!><()\n\r{}[\]]/.test(cmd)) return 'command contains invalid shell characters';
  return null;
}

function validateTmuxSession(name: string | undefined): string | null {
  if (!name) return null;
  if (typeof name !== 'string') return 'tmuxSession must be a string';
  if (name.length > 128) return 'tmuxSession name too long';
  if (!TMUX_SESSION_RE.test(name)) return 'tmuxSession must be alphanumeric, dash, underscore, or dot only';
  return null;
}

function validatePid(pid: unknown): number | null {
  const n = parseInt(String(pid), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Escape a string for safe use inside single quotes in shell commands
function shellEscapeSingleQuote(str: string): string {
  return str.replace(/'/g, "'\\''");
}

// ---- Shell Ready Detection ----

// Match ANSI escape sequences (CSI + OSC) for stripping from PTY output
const ANSI_ESC_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g;

// Common shell prompt endings: $ (bash/zsh), % (zsh), # (root), > (fish/powershell)
const SHELL_PROMPT_RE = /[#$%>]\s*$/;

/**
 * Watch PTY output to detect when the shell is ready (prompt visible).
 * Resolves `true` when a prompt is detected, `false` on timeout or PTY exit.
 * Uses a 100ms settle timer to avoid false-matching mid-stream MOTD output —
 * shell prompts are always the last thing printed before the shell waits for input.
 */
function detectShellReady(ptyProcess: IPty, terminalId: string, timeoutMs: number): Promise<boolean> {
  let resolveFn: (value: boolean) => void;
  const promise = new Promise<boolean>(r => { resolveFn = r; });
  let buffer = '';
  let done = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  function finish(detected: boolean): void {
    if (done) return;
    done = true;
    clearTimeout(fallbackTimer);
    if (settleTimer) clearTimeout(settleTimer);
    dataDisp.dispose();
    exitDisp.dispose();
    resolveFn(detected);
  }

  function checkPrompt(): void {
    const stripped = buffer.replace(ANSI_ESC_RE, '');
    const lines = stripped.split(/[\r\n]+/);
    // Find the last non-empty line
    let lastLine = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) { lastLine = lines[i].trim(); break; }
    }
    // Shell prompts are short and end with $ % # >
    if (lastLine && lastLine.length < 200 && SHELL_PROMPT_RE.test(lastLine)) {
      log.debug('pty', `Shell prompt detected for ${terminalId}: "${lastLine.slice(-60)}"`);
      finish(true);
    }
  }

  const dataDisp: IDisposable = ptyProcess.onData((data: string) => {
    if (done) return;
    buffer += data;
    // Cap buffer to avoid memory issues with large MOTD output
    if (buffer.length > 4096) buffer = buffer.slice(-4096);
    // Wait for output to settle (50ms of silence) before checking —
    // MOTD lines arrive in bursts, but the final prompt is followed by silence
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(checkPrompt, 50);
  });

  const exitDisp: IDisposable = ptyProcess.onExit(() => {
    log.debug('pty', `PTY ${terminalId} exited before shell ready detected`);
    finish(false);
  });

  const fallbackTimer = setTimeout(() => {
    log.warn('pty', `Shell ready detection timed out for ${terminalId} after ${timeoutMs}ms — sending command as fallback`);
    finish(false);
  }, timeoutMs);

  return promise;
}

// List available SSH keys from ~/.ssh/
export function listSshKeys(): SshKeyInfo[] {
  const sshDir = join(homedir(), '.ssh');
  try {
    return readdirSync(sshDir)
      .filter(f => !f.endsWith('.pub') && !f.startsWith('known_hosts') && !f.startsWith('config') && !f.startsWith('authorized_keys') && !f.startsWith('.'))
      .map(f => ({ name: f, path: join('~', '.ssh', f) }));
  } catch {
    return [];
  }
}

// Auto-generate session name: projectName #N (sequence counter per project)
const projectNameCounters = new Map<string, number>();
function autoSessionName(workDir: string): string {
  const projectName = workDir === homedir()
    ? 'Home'
    : workDir.split('/').filter(Boolean).pop() || 'Session';
  const counter = (projectNameCounters.get(projectName) || 0) + 1;
  projectNameCounters.set(projectName, counter);
  return `${projectName} #${counter}`;
}

// Active terminals: terminalId -> Terminal
const terminals = new Map<string, Terminal>();

// Ring buffer size for PTY output replay (128KB — enough for ~2 full screens of scrollback)
const OUTPUT_BUFFER_MAX = 128 * 1024;

// ---------------------------------------------------------------------------
// Ring-buffer helpers — pre-allocated slab + write offset, O(1) append.
// Replaces the old Buffer.concat-every-chunk approach which was O(n) per write
// and allocated garbage for every PTY data event.
// ---------------------------------------------------------------------------

function ringWrite(term: Terminal, chunk: Buffer): void {
  const cap = term.outputRing.length;
  if (chunk.length >= cap) {
    // Incoming chunk larger than the ring — keep only the tail.
    chunk.copy(term.outputRing, 0, chunk.length - cap);
    term.outputOffset = 0;
    term.outputWrapped = true;
    return;
  }
  const tail = cap - term.outputOffset;
  if (chunk.length <= tail) {
    chunk.copy(term.outputRing, term.outputOffset);
    term.outputOffset += chunk.length;
    if (term.outputOffset === cap) {
      term.outputOffset = 0;
      term.outputWrapped = true;
    }
  } else {
    chunk.copy(term.outputRing, term.outputOffset, 0, tail);
    chunk.copy(term.outputRing, 0, tail);
    term.outputOffset = chunk.length - tail;
    term.outputWrapped = true;
  }
}

function ringSnapshot(term: Terminal): Buffer {
  if (!term.outputWrapped) return term.outputRing.slice(0, term.outputOffset);
  return Buffer.concat([
    term.outputRing.slice(term.outputOffset),
    term.outputRing.slice(0, term.outputOffset),
  ]);
}

function ringLength(term: Terminal): number {
  return term.outputWrapped ? term.outputRing.length : term.outputOffset;
}

function ringReset(term: Terminal, preload?: Buffer): void {
  term.outputRing.fill(0);
  term.outputOffset = 0;
  term.outputWrapped = false;
  if (preload && preload.length > 0) ringWrite(term, preload);
}

// Pending links: workingDir -> array of { terminalId, host, createdAt }.
// Used to match incoming SessionStart hooks to the terminal that launched Claude.
// Multiple terminals can share the same workDir (e.g. several sessions in the same
// project on workspace import); FIFO order preserves the launch sequence.
const pendingLinks = new Map<string, PendingLink[]>();

/** Append a pending link for a workDir, preserving any existing entries (FIFO). */
function addPendingLink(workDir: string, link: PendingLink): void {
  const arr = pendingLinks.get(workDir);
  if (arr) arr.push(link);
  else pendingLinks.set(workDir, [link]);
}

// Clean up stale pending links every 30s
setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of pendingLinks) {
    const fresh = arr.filter(link => now - link.createdAt <= 60000);
    if (fresh.length === 0) {
      log.debug('pty', `Expired pending link for ${key}`);
      pendingLinks.delete(key);
    } else if (fresh.length !== arr.length) {
      pendingLinks.set(key, fresh);
    }
  }
}, 30000);

function resolveWorkDir(dir: string | undefined): string {
  if (!dir || dir === '~') return homedir();
  return dir.replace(/^~/, homedir());
}

// Cache the machine's own IP addresses so we can detect "local" connections
// even when the user accesses the dashboard via a LAN IP (e.g. 192.168.x.x).
const localAddresses = new Set<string>(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
try {
  const h = osHostname();
  localAddresses.add(h);
  localAddresses.add(`${h}.local`); // macOS mDNS
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      localAddresses.add(addr.address);
    }
  }
} catch { /* ignore — fallback to hardcoded set */ }

function isLocal(host: string | undefined): boolean {
  return !host || localAddresses.has(host);
}

function getDefaultShell(): string {
  return process.env.SHELL || '/bin/bash';
}

// Build SSH command args for remote connections (without -t for non-interactive)
function buildSshArgs(config: TerminalConfig, options: { allocatePty?: boolean } = {}): string[] {
  const args: string[] = [];
  if (options.allocatePty) args.push('-t');
  if (config.port && config.port !== 22) {
    args.push('-p', String(config.port));
  }
  if (config.privateKeyPath) {
    const keyPath = config.privateKeyPath.replace(/^~/, homedir());
    args.push('-i', keyPath);
  }
  args.push('-o', 'StrictHostKeyChecking=accept-new');
  args.push(`${config.username}@${config.host}`);
  return args;
}

// List tmux sessions on local or remote host
export function listTmuxSessions(config: TerminalConfig): Promise<TmuxSessionInfo[]> {
  return new Promise((resolve, reject) => {
    const tmuxFmt = 'tmux list-sessions -F "#{session_name}||#{session_attached}||#{session_created}||#{session_windows}" 2>/dev/null || echo "__no_tmux__"';

    let cmd: string;
    let args: string[];
    if (isLocal(config.host)) {
      cmd = 'bash';
      args = ['-c', tmuxFmt];
    } else {
      cmd = 'ssh';
      args = [...buildSshArgs(config), tmuxFmt];
    }

    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => {
      if (err) {
        if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          reject(new Error('Connection timed out'));
        } else {
          // tmux not installed or no sessions — not an error
          resolve([]);
        }
        return;
      }
      const output = stdout.toString();
      if (output.includes('__no_tmux__') || !output.trim()) {
        resolve([]);
        return;
      }
      const sessions = output.trim().split('\n').map(line => {
        const [name, attached, created, windows] = line.split('||');
        return {
          name,
          attached: attached === '1',
          created: parseInt(created) * 1000,
          windows: parseInt(windows) || 1,
        };
      }).filter(s => s.name);
      resolve(sessions);
    });
  });
}

export function createTerminal(config: TerminalConfig, wsClient: WebSocket | null): Promise<string> {
  return new Promise((resolve, reject) => {
    // Validate inputs before any shell interaction
    const wdErr = validateWorkingDir(config.workingDir);
    if (wdErr) return reject(new Error(wdErr));
    const cmdErr = validateCommand(config.command);
    if (cmdErr) return reject(new Error(cmdErr));
    const tmuxErr = validateTmuxSession(config.tmuxSession);
    if (tmuxErr) return reject(new Error(tmuxErr));

    const terminalId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workDir = resolveWorkDir(config.workingDir);
    const baseCommand = config.command || 'claude';
    // Append -n "title" to Claude commands for session naming
    const sessionName = config.sessionTitle || autoSessionName(workDir);
    const command = appendSessionName(baseCommand, sessionName);
    const skipAutoLaunch = config.command === '';
    const local = isLocal(config.host);

    try {
      let shell: string;
      let args: string[];
      let cwd: string;
      // Build environment — API keys go here instead of shell command strings.
      // Remove CLAUDECODE so spawned Claude Code sessions don't think they're nested.
      const { CLAUDECODE: _drop, ...parentEnv } = process.env as Record<string, string>;
      const env: Record<string, string> = { ...parentEnv, AGENT_MANAGER_TERMINAL_ID: terminalId };

      if (config.apiKey) {
        const envVar = command.startsWith('codex') ? 'OPENAI_API_KEY'
          : command.startsWith('gemini') ? 'GEMINI_API_KEY'
          : 'ANTHROPIC_API_KEY';
        env[envVar] = config.apiKey;
      }

      if (local) {
        shell = getDefaultShell();
        // Use -l (login shell) so ~/.zshrc / ~/.bash_profile are sourced
        // and user PATH (e.g. ~/.local/bin for claude) is available.
        args = ['-l'];
        // RC-6: Fall back to homedir() when the resolved workingDir does not
        // exist on disk — pty.spawn would otherwise throw ENOENT and the
        // session card would never be created.  The user can `cd` manually
        // once the shell is open.
        if (workDir !== homedir() && !existsSync(workDir)) {
          log.warn('pty', `workingDir does not exist (${workDir}); falling back to homedir() for terminal ${terminalId}`);
          cwd = homedir();
        } else {
          cwd = workDir;
        }
      } else {
        // Spawn native ssh — uses system SSH config, agent, keys automatically
        shell = 'ssh';
        args = buildSshArgs(config, { allocatePty: true });
        cwd = homedir();
      }

      const ptyProcess: IPty = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd,
        env,
      });

      log.info('pty', `Spawned ${local ? 'local' : `remote (${config.host})`} terminal ${terminalId} (pid: ${ptyProcess.pid})`);

      // Auto-type SSH password when password auth is used.
      // Watches PTY output for "password:" prompts and sends the stored password.
      if (!local && config.password) {
        const storedPassword = config.password;
        let passwordBuffer = '';
        let passwordAttempts = 0;
        const maxAttempts = 2;
        const passwordDisp = ptyProcess.onData((data: string) => {
          passwordBuffer += data;
          if (passwordBuffer.length > 4096) passwordBuffer = passwordBuffer.slice(-4096);
          const stripped = passwordBuffer.replace(ANSI_ESC_RE, '').toLowerCase();
          if (stripped.includes('password:') || stripped.includes('password for')) {
            passwordAttempts++;
            if (passwordAttempts > maxAttempts) {
              log.error('pty', `SSH password rejected after ${maxAttempts} attempts for ${terminalId}`);
              passwordDisp.dispose();
              return;
            }
            // Small delay to ensure the SSH process is ready for input
            setTimeout(() => {
              const term = terminals.get(terminalId);
              if (term?.pty) {
                term.pty.write(storedPassword + '\r');
                log.info('pty', `Auto-typed SSH password for ${terminalId} (attempt ${passwordAttempts})`);
              }
            }, 100);
            // Reset buffer so we don't re-trigger on the same prompt
            passwordBuffer = '';
          }
          // Stop watching after successful auth (shell prompt appears)
          if (stripped.includes('last login') || SHELL_PROMPT_RE.test(stripped.split(/[\r\n]+/).filter(l => l.trim()).pop() || '')) {
            passwordDisp.dispose();
          }
        });
        // Safety cleanup — stop watching after 30s regardless
        setTimeout(() => { passwordDisp.dispose(); }, 30000);
      }

      // Detect when the shell is ready (prompt visible) before sending commands.
      // Local shells init in ~100-300ms; remote SSH can take seconds for key exchange.
      const shellReady = detectShellReady(ptyProcess, terminalId, local ? 2000 : 10000);

      terminals.set(terminalId, {
        pty: ptyProcess,
        sessionId: null,
        config: { ...config, workingDir: workDir },
        wsClient,
        createdAt: Date.now(),
        outputRing: Buffer.alloc(OUTPUT_BUFFER_MAX),
        outputOffset: 0,
        outputWrapped: false,
        shellReady,
      });

      // Register pending link for session matching.
      // Skip for ops terminals (command='', deferredLaunch unset) — they never
      // run Claude so they must not overwrite the main terminal's pending link
      // for the same workDir.  Resume terminals also arrive with command=''
      // but set deferredLaunch=true because the caller will write the real
      // claude launch via writeWhenReady; those MUST register a pendingLink so
      // Claude's SessionStart hook can bind to the correct terminal card when
      // multiple sessions share a workDir.
      if (!skipAutoLaunch || config.deferredLaunch) {
        addPendingLink(workDir, { terminalId, host: config.host || 'localhost', createdAt: Date.now() });
      }

      // #19: Store disposables for proper cleanup on terminal close
      const disposables: IDisposable[] = [];
      terminals.get(terminalId)!.disposables = disposables;

      // Stream output to WebSocket client + buffer for replay
      disposables.push(ptyProcess.onData((data: string) => {
        const term = terminals.get(terminalId);
        if (!term) return;

        // Append to ring buffer for replay on (re)subscribe
        const chunk = Buffer.from(data);
        ringWrite(term, chunk);

        if (term.wsClient && term.wsClient.readyState === 1) {
          term.wsClient.send(JSON.stringify({
            type: 'terminal_output',
            terminalId,
            data: chunk.toString('base64'),
          }));
        }
      }));

      disposables.push(ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        log.info('pty', `Terminal ${terminalId} exited (code: ${exitCode}, signal: ${signal})`);
        broadcastToClient(terminalId, {
          type: 'terminal_closed',
          terminalId,
          reason: signal ? `signal ${signal}` : 'exited',
        });
        // #21: Notify session store so it can clear session.terminalId
        if (onTerminalExitCallback) {
          onTerminalExitCallback(terminalId);
        }
        cleanup(terminalId);
      }));

      // Send the launch command once the shell is ready (prompt detected).
      // API keys are passed via env object to pty.spawn (above), not via shell commands.
      // For remote SSH sessions, we export the env var in the shell since env doesn't
      // propagate across SSH.
      // When skipAutoLaunch is true, the caller will write the command itself
      // (e.g., resume with || fallback that contains shell metacharacters).
      if (!skipAutoLaunch) {
        // Build the launch command eagerly — only the write is deferred
        let launchCmd: string;

        if (config.tmuxSession) {
          // Attach to existing tmux session (validated above as alphanumeric+dash+underscore+dot)
          launchCmd = `tmux attach -t '${shellEscapeSingleQuote(config.tmuxSession)}'`;
        } else if (config.useTmux) {
          // Wrap command in a new tmux session
          const tmuxName = `claude-${Date.now().toString(36)}`;
          let innerCmd = local ? '' : `cd '${shellEscapeSingleQuote(workDir)}' && `;
          if (!local) {
            // Export terminal ID for hook matching over SSH
            innerCmd += `export AGENT_MANAGER_TERMINAL_ID='${shellEscapeSingleQuote(terminalId)}' && `;
            if (config.apiKey) {
              const envVar = command.startsWith('codex') ? 'OPENAI_API_KEY'
                : command.startsWith('gemini') ? 'GEMINI_API_KEY'
                : 'ANTHROPIC_API_KEY';
              innerCmd += `export ${envVar}='${shellEscapeSingleQuote(config.apiKey)}' && `;
            }
          }
          innerCmd += command;
          launchCmd = `tmux new-session -s '${tmuxName}' '${shellEscapeSingleQuote(innerCmd)}'`;
        } else {
          // Direct launch
          launchCmd = local ? '' : `cd '${shellEscapeSingleQuote(workDir)}'`;
          if (!local) {
            // Export AGENT_MANAGER_TERMINAL_ID on the remote side so hooks
            // can include it for Priority 0/1 session matching (SSH doesn't
            // forward env vars from the local PTY).
            if (launchCmd) launchCmd += ' && ';
            launchCmd += `export AGENT_MANAGER_TERMINAL_ID='${shellEscapeSingleQuote(terminalId)}'`;
            if (config.apiKey) {
              const envVar = command.startsWith('codex') ? 'OPENAI_API_KEY'
                : command.startsWith('gemini') ? 'GEMINI_API_KEY'
                : 'ANTHROPIC_API_KEY';
              launchCmd += ` && export ${envVar}='${shellEscapeSingleQuote(config.apiKey)}'`;
            }
          }
          if (launchCmd) launchCmd += ' && ';
          launchCmd += command;
        }

        // Wait for shell prompt before writing — replaces the old blind setTimeout
        shellReady.then((detected) => {
          const term = terminals.get(terminalId);
          if (!term || !term.pty) return;
          if (!detected) {
            log.warn('pty', `Sending launch command to ${terminalId} despite no prompt detected`);
          }
          term.pty.write(launchCmd + '\r');

          // Auto-apply model and/or effort level after Claude Code starts
          if ((config.model || config.effortLevel) && baseCommand.startsWith('claude')) {
            let autoBuffer = '';
            let autoSent = false;
            const autoDisp = ptyProcess.onData((data: string) => {
              if (autoSent) return;
              autoBuffer += data;
              if (autoBuffer.length > 16384) autoBuffer = autoBuffer.slice(-16384);
              const stripped = autoBuffer.replace(ANSI_ESC_RE, '');
              if (stripped.includes('Claude Code')) {
                autoSent = true;
                autoDisp.dispose();
                // Wait for Claude Code prompt to be fully ready
                setTimeout(() => {
                  const t = terminals.get(terminalId);
                  if (!t?.pty) return;
                  const cmds: string[] = [];
                  if (config.model) cmds.push(`/model ${config.model}`);
                  if (config.effortLevel) cmds.push(`/effort ${config.effortLevel}`);
                  // Send commands sequentially with a gap between them
                  cmds.forEach((cmd, i) => {
                    setTimeout(() => {
                      const t2 = terminals.get(terminalId);
                      if (t2?.pty) {
                        t2.pty.write(cmd + '\r');
                        log.info('pty', `Auto-applied ${cmd} for ${terminalId}`);
                      }
                    }, i * 800);
                  });
                }, 2500);
              }
            });
            // Safety: stop watching after 30s
            setTimeout(() => {
              if (!autoSent) autoDisp.dispose();
            }, 30000);
          }
        });
      }

      // Notify client terminal is ready
      if (wsClient && wsClient.readyState === 1) {
        wsClient.send(JSON.stringify({ type: 'terminal_ready', terminalId }));
      }

      resolve(terminalId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('pty', `Failed to create terminal: ${msg}`);
      reject(err);
    }
  });
}

/**
 * Attach to an existing tmux pane, creating a terminal that views the pane's output.
 * Uses `tmux attach -t {paneId}` to attach to the session containing the pane.
 */
export function attachToTmuxPane(tmuxPaneId: string, wsClient: WebSocket | null): Promise<string> {
  return new Promise((resolve, reject) => {
    // Validate pane ID: must be % followed by digits
    if (!tmuxPaneId || typeof tmuxPaneId !== 'string') {
      return reject(new Error('tmuxPaneId is required'));
    }
    if (!/^%\d+$/.test(tmuxPaneId)) {
      return reject(new Error('tmuxPaneId must be in format "%N" (e.g. "%5")'));
    }

    const terminalId = `term-tmux-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      // First, resolve which tmux session this pane belongs to
      // Then attach to that session targeting the specific pane
      const shell = getDefaultShell();
      const { CLAUDECODE: _dropTmux, ...tmuxParentEnv } = process.env as Record<string, string>;
      const env: Record<string, string> = { ...tmuxParentEnv, AGENT_MANAGER_TERMINAL_ID: terminalId };

      const ptyProcess: IPty = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: homedir(),
        env,
      });

      log.info('pty', `Spawned tmux attach terminal ${terminalId} for pane ${tmuxPaneId} (pid: ${ptyProcess.pid})`);

      terminals.set(terminalId, {
        pty: ptyProcess,
        sessionId: null,
        config: { host: 'localhost', workingDir: homedir(), command: `tmux (pane ${tmuxPaneId})` },
        wsClient,
        createdAt: Date.now(),
        outputRing: Buffer.alloc(OUTPUT_BUFFER_MAX),
        outputOffset: 0,
        outputWrapped: false,
      });

      // Stream output to WebSocket client + buffer for replay
      ptyProcess.onData((data: string) => {
        const term = terminals.get(terminalId);
        if (!term) return;

        const chunk = Buffer.from(data);
        ringWrite(term, chunk);

        if (term.wsClient && term.wsClient.readyState === 1) {
          term.wsClient.send(JSON.stringify({
            type: 'terminal_output',
            terminalId,
            data: chunk.toString('base64'),
          }));
        }
      });

      ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        log.info('pty', `Tmux terminal ${terminalId} exited (code: ${exitCode}, signal: ${signal})`);
        broadcastToClient(terminalId, {
          type: 'terminal_closed',
          terminalId,
          reason: signal ? `signal ${signal}` : 'exited',
        });
        cleanup(terminalId);
      });

      // Send the tmux attach command after shell init
      // select-pane -t ensures we're looking at the right pane
      setTimeout(() => {
        // Pane ID is validated above as %N, safe to interpolate
        ptyProcess.write(`tmux select-pane -t '${tmuxPaneId}' && tmux attach\r`);
      }, 100);

      // Notify client terminal is ready
      if (wsClient && wsClient.readyState === 1) {
        wsClient.send(JSON.stringify({ type: 'terminal_ready', terminalId }));
      }

      resolve(terminalId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('pty', `Failed to attach to tmux pane ${tmuxPaneId}: ${msg}`);
      reject(err);
    }
  });
}

/**
 * Strip terminal response sequences that should never reach PTY stdin.
 * Focus events (\x1b[I / \x1b[O) and Device Attributes responses
 * (\x1b[?...c / \x1b[>...c) are emitted by xterm.js but are not user input.
 */
const TERMINAL_RESPONSE_RE = /\x1b\[I|\x1b\[O|\x1b\[\?[\d;]*c|\x1b\[>[\d;]*c/g;

export function writeToTerminal(terminalId: string, data: string): void {
  const term = terminals.get(terminalId);
  if (term && term.pty) {
    const cleaned = data.replace(TERMINAL_RESPONSE_RE, '');
    if (cleaned) term.pty.write(cleaned);
  }
}

/**
 * Write data to a terminal after its shell is ready.
 * Awaits the shell prompt detection before writing, so commands aren't lost
 * if SSH hasn't finished connecting yet.
 */
export async function writeWhenReady(terminalId: string, data: string): Promise<boolean> {
  const term = terminals.get(terminalId);
  if (!term) return false;
  if (term.shellReady) await term.shellReady;
  // Terminal might have been cleaned up while waiting
  const termNow = terminals.get(terminalId);
  if (!termNow || !termNow.pty) return false;
  termNow.pty.write(data);
  return true;
}

// #31: Returns error message on failure so wsManager can relay to client
export function resizeTerminal(terminalId: string, cols: number, rows: number): string | null {
  const term = terminals.get(terminalId);
  if (term && term.pty) {
    try {
      term.pty.resize(cols, rows);
      return null;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.debug('pty', `Resize failed for ${terminalId} (process may be dead): ${msg}`);
      return msg;
    }
  }
  return terminalId ? 'terminal not found' : null;
}

export function closeTerminal(terminalId: string): void {
  const term = terminals.get(terminalId);
  if (term) {
    if (term.pty) {
      try { term.pty.kill(); } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.debug('pty', `Kill failed for ${terminalId}: ${msg}`);
      }
    }
    cleanup(terminalId);
  }
}

export function linkSession(terminalId: string, sessionId: string): void {
  const term = terminals.get(terminalId);
  if (term) {
    term.sessionId = sessionId;
    log.info('pty', `Linked terminal ${terminalId} to session ${sessionId}`);
  }
}

/**
 * Find the workDir key in pendingLinks that matches `workDir` (with or without
 * trailing slash). Returns the actual key in the Map, or null.
 */
function findPendingLinksKey(workDir: string): string | null {
  if (pendingLinks.has(workDir)) return workDir;
  const normalized = workDir.replace(/\/$/, '');
  for (const dir of pendingLinks.keys()) {
    if (dir.replace(/\/$/, '') === normalized) return dir;
  }
  return null;
}

export function tryLinkByWorkDir(workDir: string, sessionId: string): string | null {
  const key = findPendingLinksKey(workDir);
  if (!key) return null;
  const arr = pendingLinks.get(key);
  if (!arr || arr.length === 0) {
    pendingLinks.delete(key);
    return null;
  }
  // FIFO — shift the front entry (oldest first registered)
  const link = arr.shift()!;
  if (arr.length === 0) pendingLinks.delete(key);
  linkSession(link.terminalId, sessionId);
  return link.terminalId;
}

/**
 * Consume (remove) a pending link for a given workDir.
 * Called after Priority 0 resume match to prevent stale links from
 * creating duplicate sessions at Priority 2.
 *
 * When `terminalId` is provided, removes only the entry whose terminalId
 * matches; otherwise removes the front (oldest) entry.
 * If the array becomes empty, the map key is deleted.
 */
export function consumePendingLink(workDir: string, terminalId?: string): void {
  if (!workDir) return;
  const key = findPendingLinksKey(workDir);
  if (!key) return;
  const arr = pendingLinks.get(key);
  if (!arr || arr.length === 0) {
    pendingLinks.delete(key);
    return;
  }
  if (terminalId) {
    const idx = arr.findIndex(l => l.terminalId === terminalId);
    if (idx >= 0) arr.splice(idx, 1);
  } else {
    arr.shift();
  }
  if (arr.length === 0) pendingLinks.delete(key);
}

export function getTerminalForSession(sessionId: string): string | null {
  for (const [terminalId, term] of terminals) {
    if (term.sessionId === sessionId) return terminalId;
  }
  return null;
}

// Find terminal whose pty is the parent of the given child PID
export function getTerminalByPtyChild(childPid: number): string | null {
  const validPid = validatePid(childPid);
  if (!validPid) return null;
  try {
    const ppid = parseInt(execSync(`ps -o ppid= -p ${validPid} 2>/dev/null`, { encoding: 'utf-8' }).trim(), 10);
    if (!ppid || ppid <= 0) return null;
    for (const [terminalId, term] of terminals) {
      if (term.pty && term.pty.pid === ppid) return terminalId;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.debug('pty', `getTerminalByPtyChild failed for pid=${validPid}: ${msg}`);
  }
  return null;
}

// #30: Returns boolean indicating whether terminal exists (for subscribe race check)
export function setWsClient(terminalId: string, wsClient: WebSocket | null): boolean {
  const term = terminals.get(terminalId);
  if (!term) return false;

  term.wsClient = wsClient;

  if (wsClient && wsClient.readyState === 1) {
    // Send terminal_ready so the frontend runs onTerminalReady (refit + resize sync).
    // This is important for REST-API-created terminals where the original terminal_ready
    // was sent to a null wsClient and never reached the browser.
    wsClient.send(JSON.stringify({ type: 'terminal_ready', terminalId }));

    // Replay buffered output so the client sees previous terminal content
    const snapshot = ringSnapshot(term);
    if (snapshot.length > 0) {
      wsClient.send(JSON.stringify({
        type: 'terminal_output',
        terminalId,
        data: snapshot.toString('base64'),
      }));
      log.debug('pty', `Replayed ${snapshot.length} bytes to new client for ${terminalId}`);
    }
  }
  return true;
}

/** Get the raw output ring buffer for a terminal (base64-encoded). */
export function getTerminalOutputBuffer(terminalId: string): string | null {
  const term = terminals.get(terminalId);
  if (!term || ringLength(term) === 0) return null;
  return ringSnapshot(term).toString('base64');
}

/**
 * Prepend saved output (base64) into a terminal's ring buffer.
 * Used during workspace import to restore previous terminal scrollback.
 * The saved output is prepended before any new PTY output.
 */
export function prefillTerminalOutput(terminalId: string, base64Data: string): boolean {
  const term = terminals.get(terminalId);
  if (!term) return false;
  const saved = Buffer.from(base64Data, 'base64');
  const existing = ringSnapshot(term);
  const combined = Buffer.concat([saved, existing]);
  const trimmed = combined.length > OUTPUT_BUFFER_MAX
    ? combined.slice(combined.length - OUTPUT_BUFFER_MAX)
    : combined;
  ringReset(term, trimmed);
  return true;
}

export function getTerminals(): TerminalInfo[] {
  const result: TerminalInfo[] = [];
  for (const [terminalId, term] of terminals) {
    result.push({
      terminalId,
      sessionId: term.sessionId,
      host: term.config.host,
      workingDir: term.config.workingDir,
      command: term.config.command,
      createdAt: term.createdAt,
    });
  }
  return result;
}

function broadcastToClient(terminalId: string, message: Record<string, unknown>): void {
  const term = terminals.get(terminalId);
  if (term && term.wsClient && term.wsClient.readyState === 1) {
    term.wsClient.send(JSON.stringify(message));
  }
}

function cleanup(terminalId: string): void {
  const term = terminals.get(terminalId);
  if (term) {
    // #19: Dispose event listeners to prevent memory leaks
    if (term.disposables) {
      for (const d of term.disposables) {
        try { d.dispose(); } catch { /* already disposed */ }
      }
      term.disposables = [];
    }
    for (const [key, arr] of pendingLinks) {
      const filtered = arr.filter(l => l.terminalId !== terminalId);
      if (filtered.length === 0) pendingLinks.delete(key);
      else if (filtered.length !== arr.length) pendingLinks.set(key, filtered);
    }
    terminals.delete(terminalId);
  }
}

// ---------------------------------------------------------------------------
// Test-only helpers — exposed so unit tests can manipulate pendingLinks
// without spawning real PTYs. These have no callers in production code paths.
// ---------------------------------------------------------------------------

/** @internal — test only */
export function __addPendingLinkForTest(workDir: string, link: PendingLink): void {
  addPendingLink(workDir, link);
}

/** @internal — test only */
export function __resetPendingLinksForTest(): void {
  pendingLinks.clear();
}

/** @internal — test only */
export function __getPendingLinksSizeForTest(): number {
  return pendingLinks.size;
}

/** @internal — test only */
export function __getPendingLinksForWorkDirForTest(workDir: string): PendingLink[] | undefined {
  const key = findPendingLinksKey(workDir);
  return key ? pendingLinks.get(key) : undefined;
}

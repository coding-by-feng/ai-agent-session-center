// sshManager.js — PTY-based terminal multiplexer using node-pty
// Manages terminal lifecycle for local and remote (via native ssh) sessions.
// Terminal I/O is relayed through WebSocket to xterm.js in the browser.

import pty from 'node-pty';
import { execFile, execSync } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import log from './logger.js';

// ---- Input Validation Helpers ----

// Shell metacharacters that indicate injection attempts
const SHELL_META_RE = /[;|&$`\\!><()\n\r{}[\]]/;

// tmuxSession names: alphanumeric, dash, underscore, dot only
const TMUX_SESSION_RE = /^[a-zA-Z0-9_.\-]+$/;

function validateWorkingDir(dir) {
  if (!dir) return null;
  if (typeof dir !== 'string') return 'workingDir must be a string';
  if (dir.length > 1024) return 'workingDir too long';
  // Allow ~ at start, then normal path chars
  if (SHELL_META_RE.test(dir.replace(/^~/, ''))) return 'workingDir contains invalid characters';
  return null;
}

function validateCommand(cmd) {
  if (!cmd) return null;
  if (typeof cmd !== 'string') return 'command must be a string';
  if (cmd.length > 512) return 'command too long';
  // Allow known CLI commands with flags, but reject shell metacharacters
  if (/[;|&$`\\!><()\n\r{}[\]]/.test(cmd)) return 'command contains invalid shell characters';
  return null;
}

function validateTmuxSession(name) {
  if (!name) return null;
  if (typeof name !== 'string') return 'tmuxSession must be a string';
  if (name.length > 128) return 'tmuxSession name too long';
  if (!TMUX_SESSION_RE.test(name)) return 'tmuxSession must be alphanumeric, dash, underscore, or dot only';
  return null;
}

function validatePid(pid) {
  const n = parseInt(pid, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Escape a string for safe use inside single quotes in shell commands
function shellEscapeSingleQuote(str) {
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
 *
 * @param {import('node-pty').IPty} ptyProcess
 * @param {string} terminalId - For logging
 * @param {number} timeoutMs - Max wait time before fallback
 * @returns {Promise<boolean>}
 */
function detectShellReady(ptyProcess, terminalId, timeoutMs) {
  let resolveFn;
  const promise = new Promise(r => { resolveFn = r; });
  let buffer = '';
  let done = false;
  let settleTimer = null;

  function finish(detected) {
    if (done) return;
    done = true;
    clearTimeout(fallbackTimer);
    clearTimeout(settleTimer);
    dataDisp.dispose();
    exitDisp.dispose();
    resolveFn(detected);
  }

  function checkPrompt() {
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

  const dataDisp = ptyProcess.onData((data) => {
    if (done) return;
    buffer += data;
    // Cap buffer to avoid memory issues with large MOTD output
    if (buffer.length > 4096) buffer = buffer.slice(-4096);
    // Wait for output to settle (100ms of silence) before checking —
    // MOTD lines arrive in bursts, but the final prompt is followed by silence
    clearTimeout(settleTimer);
    settleTimer = setTimeout(checkPrompt, 100);
  });

  const exitDisp = ptyProcess.onExit(() => {
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
export function listSshKeys() {
  const sshDir = join(homedir(), '.ssh');
  try {
    return readdirSync(sshDir)
      .filter(f => !f.endsWith('.pub') && !f.startsWith('known_hosts') && !f.startsWith('config') && !f.startsWith('authorized_keys') && !f.startsWith('.'))
      .map(f => ({ name: f, path: join('~', '.ssh', f) }));
  } catch {
    return [];
  }
}

// Active terminals: terminalId -> { pty, sessionId, config, wsClient, createdAt, outputBuffer }
const terminals = new Map();

// Ring buffer size for PTY output replay (128KB — enough for ~2 full screens of scrollback)
const OUTPUT_BUFFER_MAX = 128 * 1024;

// Pending links: workingDir -> { terminalId, host, createdAt }
// Used to match incoming SessionStart hooks to the terminal that launched Claude
const pendingLinks = new Map();

// Clean up stale pending links every 30s
setInterval(() => {
  const now = Date.now();
  for (const [key, link] of pendingLinks) {
    if (now - link.createdAt > 60000) {
      log.debug('pty', `Expired pending link for ${key}`);
      pendingLinks.delete(key);
    }
  }
}, 30000);

function resolveWorkDir(dir) {
  if (!dir || dir === '~') return homedir();
  return dir.replace(/^~/, homedir());
}

function isLocal(host) {
  return !host || host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function getDefaultShell() {
  return process.env.SHELL || '/bin/bash';
}

// Build SSH command args for remote connections (without -t for non-interactive)
function buildSshArgs(config, { allocatePty = false } = {}) {
  const args = [];
  if (allocatePty) args.push('-t');
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
export function listTmuxSessions(config) {
  return new Promise((resolve, reject) => {
    const tmuxFmt = 'tmux list-sessions -F "#{session_name}||#{session_attached}||#{session_created}||#{session_windows}" 2>/dev/null || echo "__no_tmux__"';

    let cmd, args;
    if (isLocal(config.host)) {
      cmd = 'bash';
      args = ['-c', tmuxFmt];
    } else {
      cmd = 'ssh';
      args = [...buildSshArgs(config), tmuxFmt];
    }

    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => {
      if (err) {
        if (err.killed) {
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

export function createTerminal(config, wsClient) {
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
    const command = config.command || 'claude';
    const skipAutoLaunch = config.command === '';
    const local = isLocal(config.host);

    try {
      let shell, args, cwd;
      // Build environment — API keys go here instead of shell command strings
      const env = { ...process.env, AGENT_MANAGER_TERMINAL_ID: terminalId };

      if (config.apiKey) {
        const envVar = command.startsWith('codex') ? 'OPENAI_API_KEY'
          : command.startsWith('gemini') ? 'GEMINI_API_KEY'
          : 'ANTHROPIC_API_KEY';
        env[envVar] = config.apiKey;
      }

      if (local) {
        shell = getDefaultShell();
        args = [];
        cwd = workDir;
      } else {
        // Spawn native ssh — uses system SSH config, agent, keys automatically
        shell = 'ssh';
        args = buildSshArgs(config, { allocatePty: true });
        cwd = homedir();
      }

      const ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd,
        env,
      });

      log.info('pty', `Spawned ${local ? 'local' : `remote (${config.host})`} terminal ${terminalId} (pid: ${ptyProcess.pid})`);

      // Detect when the shell is ready (prompt visible) before sending commands.
      // Local shells init in ~100-300ms; remote SSH can take seconds for key exchange.
      const shellReady = detectShellReady(ptyProcess, terminalId, local ? 5000 : 15000);

      terminals.set(terminalId, {
        pty: ptyProcess,
        sessionId: null,
        config: { ...config, workingDir: workDir },
        wsClient,
        createdAt: Date.now(),
        outputBuffer: Buffer.alloc(0),
        shellReady,
      });

      // Register pending link for session matching
      pendingLinks.set(workDir, { terminalId, host: config.host || 'localhost', createdAt: Date.now() });

      // Stream output to WebSocket client + buffer for replay
      ptyProcess.onData((data) => {
        const term = terminals.get(terminalId);
        if (!term) return;

        // Append to ring buffer for replay on (re)subscribe
        const chunk = Buffer.from(data);
        term.outputBuffer = Buffer.concat([term.outputBuffer, chunk]);
        if (term.outputBuffer.length > OUTPUT_BUFFER_MAX) {
          term.outputBuffer = term.outputBuffer.slice(term.outputBuffer.length - OUTPUT_BUFFER_MAX);
        }

        if (term.wsClient && term.wsClient.readyState === 1) {
          term.wsClient.send(JSON.stringify({
            type: 'terminal_output',
            terminalId,
            data: chunk.toString('base64'),
          }));
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        log.info('pty', `Terminal ${terminalId} exited (code: ${exitCode}, signal: ${signal})`);
        broadcastToClient(terminalId, {
          type: 'terminal_closed',
          terminalId,
          reason: signal ? `signal ${signal}` : 'exited',
        });
        cleanup(terminalId);
      });

      // Send the launch command once the shell is ready (prompt detected).
      // API keys are passed via env object to pty.spawn (above), not via shell commands.
      // For remote SSH sessions, we export the env var in the shell since env doesn't
      // propagate across SSH.
      // When skipAutoLaunch is true, the caller will write the command itself
      // (e.g., resume with || fallback that contains shell metacharacters).
      if (!skipAutoLaunch) {
        // Build the launch command eagerly — only the write is deferred
        let launchCmd;

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
        });
      }

      // Notify client terminal is ready
      if (wsClient && wsClient.readyState === 1) {
        wsClient.send(JSON.stringify({ type: 'terminal_ready', terminalId }));
      }

      resolve(terminalId);
    } catch (err) {
      log.error('pty', `Failed to create terminal: ${err.message}`);
      reject(err);
    }
  });
}

/**
 * Attach to an existing tmux pane, creating a terminal that views the pane's output.
 * Uses `tmux attach -t {paneId}` to attach to the session containing the pane.
 *
 * @param {string} tmuxPaneId - The tmux pane ID (e.g. "%5")
 * @param {object|null} wsClient - WebSocket client for output relay
 * @returns {Promise<string>} The new terminal ID
 */
export function attachToTmuxPane(tmuxPaneId, wsClient) {
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
      const env = { ...process.env, AGENT_MANAGER_TERMINAL_ID: terminalId };

      const ptyProcess = pty.spawn(shell, [], {
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
        outputBuffer: Buffer.alloc(0),
      });

      // Stream output to WebSocket client + buffer for replay
      ptyProcess.onData((data) => {
        const term = terminals.get(terminalId);
        if (!term) return;

        const chunk = Buffer.from(data);
        term.outputBuffer = Buffer.concat([term.outputBuffer, chunk]);
        if (term.outputBuffer.length > OUTPUT_BUFFER_MAX) {
          term.outputBuffer = term.outputBuffer.slice(term.outputBuffer.length - OUTPUT_BUFFER_MAX);
        }

        if (term.wsClient && term.wsClient.readyState === 1) {
          term.wsClient.send(JSON.stringify({
            type: 'terminal_output',
            terminalId,
            data: chunk.toString('base64'),
          }));
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
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
    } catch (err) {
      log.error('pty', `Failed to attach to tmux pane ${tmuxPaneId}: ${err.message}`);
      reject(err);
    }
  });
}

export function writeToTerminal(terminalId, data) {
  const term = terminals.get(terminalId);
  if (term && term.pty) {
    term.pty.write(data);
  }
}

/**
 * Write data to a terminal after its shell is ready.
 * Awaits the shell prompt detection before writing, so commands aren't lost
 * if SSH hasn't finished connecting yet.
 * @param {string} terminalId
 * @param {string} data
 * @returns {Promise<boolean>} true if written, false if terminal was gone
 */
export async function writeWhenReady(terminalId, data) {
  const term = terminals.get(terminalId);
  if (!term) return false;
  if (term.shellReady) await term.shellReady;
  // Terminal might have been cleaned up while waiting
  const termNow = terminals.get(terminalId);
  if (!termNow || !termNow.pty) return false;
  termNow.pty.write(data);
  return true;
}

export function resizeTerminal(terminalId, cols, rows) {
  const term = terminals.get(terminalId);
  if (term && term.pty) {
    try {
      term.pty.resize(cols, rows);
    } catch (e) {
      log.debug('pty', `Resize failed for ${terminalId} (process may be dead): ${e.message}`);
    }
  }
}

export function closeTerminal(terminalId) {
  const term = terminals.get(terminalId);
  if (term) {
    if (term.pty) {
      try { term.pty.kill(); } catch (e) {
        log.debug('pty', `Kill failed for ${terminalId}: ${e.message}`);
      }
    }
    cleanup(terminalId);
  }
}

export function linkSession(terminalId, sessionId) {
  const term = terminals.get(terminalId);
  if (term) {
    term.sessionId = sessionId;
    log.info('pty', `Linked terminal ${terminalId} to session ${sessionId}`);
  }
}

export function tryLinkByWorkDir(workDir, sessionId) {
  const link = pendingLinks.get(workDir);
  if (link) {
    linkSession(link.terminalId, sessionId);
    pendingLinks.delete(workDir);
    return link.terminalId;
  }
  // Also try matching with trailing slash variants
  const normalized = workDir.replace(/\/$/, '');
  for (const [dir, link] of pendingLinks) {
    if (dir.replace(/\/$/, '') === normalized) {
      linkSession(link.terminalId, sessionId);
      pendingLinks.delete(dir);
      return link.terminalId;
    }
  }
  return null;
}

/**
 * Consume (remove) a pending link for a given workDir.
 * Called after Priority 0 resume match to prevent stale links from
 * creating duplicate sessions at Priority 2.
 * @param {string} workDir
 */
export function consumePendingLink(workDir) {
  if (!workDir) return;
  if (pendingLinks.delete(workDir)) return;
  const normalized = workDir.replace(/\/$/, '');
  for (const [dir] of pendingLinks) {
    if (dir.replace(/\/$/, '') === normalized) {
      pendingLinks.delete(dir);
      return;
    }
  }
}

export function getTerminalForSession(sessionId) {
  for (const [terminalId, term] of terminals) {
    if (term.sessionId === sessionId) return terminalId;
  }
  return null;
}

// Find terminal whose pty is the parent of the given child PID
export function getTerminalByPtyChild(childPid) {
  const validPid = validatePid(childPid);
  if (!validPid) return null;
  try {
    const ppid = parseInt(execSync(`ps -o ppid= -p ${validPid} 2>/dev/null`, { encoding: 'utf-8' }).trim(), 10);
    if (!ppid || ppid <= 0) return null;
    for (const [terminalId, term] of terminals) {
      if (term.pty && term.pty.pid === ppid) return terminalId;
    }
  } catch (e) {
    log.debug('pty', `getTerminalByPtyChild failed for pid=${validPid}: ${e.message}`);
  }
  return null;
}

export function setWsClient(terminalId, wsClient) {
  const term = terminals.get(terminalId);
  if (term) {
    term.wsClient = wsClient;

    if (wsClient && wsClient.readyState === 1) {
      // Send terminal_ready so the frontend runs onTerminalReady (refit + resize sync).
      // This is important for REST-API-created terminals where the original terminal_ready
      // was sent to a null wsClient and never reached the browser.
      wsClient.send(JSON.stringify({ type: 'terminal_ready', terminalId }));

      // Replay buffered output so the client sees previous terminal content
      if (term.outputBuffer.length > 0) {
        wsClient.send(JSON.stringify({
          type: 'terminal_output',
          terminalId,
          data: term.outputBuffer.toString('base64'),
        }));
        log.debug('pty', `Replayed ${term.outputBuffer.length} bytes to new client for ${terminalId}`);
      }
    }
  }
}

export function getTerminals() {
  const result = [];
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

function broadcastToClient(terminalId, message) {
  const term = terminals.get(terminalId);
  if (term && term.wsClient && term.wsClient.readyState === 1) {
    term.wsClient.send(JSON.stringify(message));
  }
}

function cleanup(terminalId) {
  const term = terminals.get(terminalId);
  if (term) {
    for (const [key, link] of pendingLinks) {
      if (link.terminalId === terminalId) pendingLinks.delete(key);
    }
    terminals.delete(terminalId);
  }
}

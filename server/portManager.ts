/**
 * @module portManager
 * Resolves the server listen port (--port flag > PORT env > config > 3333) and provides
 * killPortProcess() to detect and terminate processes occupying the target port via lsof/netstat.
 */
import { execSync, execFile } from 'child_process';
import type { ServerConfig } from '../src/types/settings.js';

/**
 * Resolve which port to listen on.
 * Priority: --port flag > PORT env > config file > 3333
 */
export function resolvePort(cliArgs: string[], config: ServerConfig): number {
  const portArgIdx = cliArgs.indexOf('--port');
  if (portArgIdx >= 0 && cliArgs[portArgIdx + 1]) {
    const p = parseInt(cliArgs[portArgIdx + 1], 10);
    if (p > 0) return p;
  }
  if (process.env.PORT) {
    const p = parseInt(process.env.PORT, 10);
    if (p > 0) return p;
  }
  return config.port || 3333;
}

/**
 * Kill any process currently occupying the given port.
 */
export function killPortProcess(port: number): void {
  try {
    if (process.platform === 'win32') {
      const output = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const pids = [...new Set(
        output.trim().split('\n')
          .map(line => line.trim().split(/\s+/).pop())
          .filter(Boolean)
      )];
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'pipe' }); } catch { /* already dead */ }
      }
    } else {
      // macOS & Linux
      const output = execSync(`lsof -ti:${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const pids = output.trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already dead */ }
      }
    }
  } catch {
    // No process found on port — nothing to kill
  }
}

/** How long the port-holder lookup may take before it gives up. */
const PORT_HOLDER_LOOKUP_TIMEOUT_MS = 3000;

/**
 * Who listens on `port`, for the message when a headless server refuses a busy port (it never kills
 * the holder). Read-only: `lsof` as an argument array, no shell. Resolves to e.g. "pid 4121 (node)",
 * or a generic phrase when lsof is missing or finds nothing.
 */
export function describePortHolder(port: number): Promise<string> {
  const unknown = 'another process';
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || process.platform === 'win32') {
    return Promise.resolve(unknown);
  }
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { timeout: PORT_HOLDER_LOOKUP_TIMEOUT_MS }, (err, stdout) => {
      if (err && !stdout) { resolve(unknown); return; }
      const pid = /^p(\d+)$/m.exec(stdout)?.[1];
      const command = /^c(.+)$/m.exec(stdout)?.[1];
      resolve(pid ? `pid ${pid}${command ? ` (${command})` : ''}` : unknown);
    });
  });
}

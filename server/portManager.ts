/**
 * @module portManager
 * Resolves the server listen port (--port flag > PORT env > config > 3333) and provides
 * killPortProcess() to detect and terminate processes occupying the target port via lsof/netstat.
 */
import { execSync } from 'child_process';
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

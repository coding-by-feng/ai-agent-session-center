/**
 * `aasc-server logs [-n <lines>] [--no-follow]` (terminal-editions plan §8.1): the systemd journal
 * when the service is installed, otherwise <data>/logs/server.log, followed like `tail -f`.
 *
 * journalctl is spawned with an argument array and this terminal (no shell); the log file is read
 * here, so the command also works where there is no `tail`.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'fs';
import { join } from 'path';
import { EXIT } from './http.js';
import { UNIT_NAME } from './service.js';

export const DEFAULT_LINES = 50;
const FOLLOW_POLL_MS = 500;

export interface LogsDeps {
  dataDir: string;
  platform: NodeJS.Platform;
  /** The systemd user unit is installed (service.ts unitPath exists). */
  serviceInstalled: boolean;
  lines: number;
  follow: boolean;
  /** Run a command attached to this terminal; resolves with its exit code. */
  spawnAttached(command: string, args: string[]): Promise<number>;
  write(text: string): void;
  sleep(ms: number): Promise<void>;
  /** Aborted on Ctrl-C. */
  cancelled: AbortSignal;
}

export function journalArgs(lines: number, follow: boolean): string[] {
  return ['--user', '-u', UNIT_NAME, '-n', String(lines), '--no-pager', ...(follow ? ['-f'] : [])];
}

function readRange(path: string, from: number, to: number): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(to - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The last `lines` lines of the file and where they end, reading at most the last 1 MB. */
function tail(path: string, lines: number): { text: string; end: number } {
  const size = statSync(path).size;
  const from = Math.max(0, size - 1024 * 1024);
  const chunk = readRange(path, from, size).split('\n');
  if (chunk[chunk.length - 1] === '') chunk.pop();
  return { text: chunk.slice(-lines).map((l) => `${l}\n`).join(''), end: size };
}

export async function runLogs(deps: LogsDeps): Promise<number> {
  if (deps.platform === 'linux' && deps.serviceInstalled) {
    return deps.spawnAttached('journalctl', journalArgs(deps.lines, deps.follow));
  }
  const path = join(deps.dataDir, 'logs', 'server.log');
  if (!existsSync(path)) {
    deps.write(`No log yet at ${path}. The server writes it once it starts.\n`);
    return EXIT.FAILED;
  }
  let { text, end } = tail(path, deps.lines);
  deps.write(text);
  while (deps.follow && !deps.cancelled.aborted) {
    await deps.sleep(FOLLOW_POLL_MS);
    let size: number;
    try { size = statSync(path).size; } catch { continue; }
    // Rotated or truncated: start again from its beginning.
    if (size < end) end = 0;
    if (size > end) {
      text = readRange(path, end, size);
      end = size;
      deps.write(text);
    }
  }
  return EXIT.OK;
}

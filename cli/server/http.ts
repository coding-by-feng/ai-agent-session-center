/**
 * The admin CLI's way into its own server (terminal-editions plan §8.2): read the owner token from
 * <data>/owner.token and call http://127.0.0.1:<port> with it.
 *
 * The token is read from the file on every run, never taken from argv or the environment, and never
 * printed. The request carries no Origin and no Sec-Fetch-Site (a tool, not a page), names
 * 127.0.0.1 as its Host, and declares `X-AASC-Role: cli`, so it is never the workspace writer (D10).
 */
import { lstatSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { readLock } from '../../server/instanceLock.js';
import { resolvePort } from '../../server/portManager.js';
import type { ServerConfig } from '../../src/types/settings.js';

/** §8.1: 0 done · 1 failed or cancelled · 2 the server isn't running · 3 folder locked · 4 port busy · 64 bad usage (EX_USAGE). */
export const EXIT = { OK: 0, FAILED: 1, NOT_RUNNING: 2, LOCKED: 3, PORT_BUSY: 4, USAGE: 64 } as const;

export class AdminError extends Error {
  readonly exitCode: number;
  constructor(exitCode: number, message: string) {
    super(message);
    this.name = 'AdminError';
    this.exitCode = exitCode;
  }
}

const OWNER_TOKEN_RE = /^[0-9a-f]{64}$/;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Text a device or the server chose (a phone's label, an error message), made safe to print:
 * control characters could otherwise move the cursor, rewrite the screen or retitle the terminal,
 * and format characters (bidi overrides, zero-width marks) could make a label read as something it
 * isn't. Line and paragraph separators become spaces, so a label can't start a line of its own.
 */
export function safeText(value: unknown): string {
  return String(value ?? '').replace(/[\t\n\r\u2028\u2029]+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '');
}

export function readConfig(dataDir: string): ServerConfig {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'server-config.json'), 'utf8')) as ServerConfig;
  } catch {
    return {} as ServerConfig;
  }
}

/**
 * <dataDir>/owner.token, only when it is a regular file of ours that nobody else can read: a token
 * someone else could have read or swapped is not proof of anything.
 */
export function readOwnerToken(dataDir: string, { uid = process.getuid?.() ?? null }: { uid?: number | null } = {}): string {
  const path = join(dataDir, 'owner.token');
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new AdminError(EXIT.NOT_RUNNING, `There is no owner.token in ${dataDir}: the server isn't running there, or it writes none. Start it with \`aasc-server serve\` (pass the right --data-dir); a desktop app writes one only with AASC_OWNER_TOKEN=1 or "ownerToken": true.`);
  }
  if (!stat.isFile()) throw new AdminError(EXIT.FAILED, `${path} is not a regular file. Remove it and restart the server.`);
  if (uid !== null && stat.uid !== uid) throw new AdminError(EXIT.FAILED, `${path} belongs to another user. Run aasc-server as the user the server runs as.`);
  if ((stat.mode & 0o077) !== 0) throw new AdminError(EXIT.FAILED, `${path} can be read by other users. Run \`chmod 600 ${path}\`, then restart the server: it may have been copied.`);
  const token = readFileSync(path, 'utf8').trim();
  if (!OWNER_TOKEN_RE.test(token)) throw new AdminError(EXIT.FAILED, `${path} is damaged. Restart the server to write a new one.`);
  return token;
}

const PortSchema = z.coerce.number().int().min(1).max(65535);

/** --port, then the live server's folder lock, then PORT and server-config.json as the server reads them (resolvePort). */
export function resolveAdminPort({ dataDir, flagPort, env }: { dataDir: string; flagPort: string | undefined; env: NodeJS.ProcessEnv }): number {
  if (flagPort !== undefined) {
    const parsed = PortSchema.safeParse(flagPort);
    if (!parsed.success) throw new AdminError(EXIT.FAILED, `--port must be a port number (1-65535), not ${JSON.stringify(flagPort)}.`);
    return parsed.data;
  }
  const lock = readLock(join(dataDir, 'server.lock'));
  if (lock) return lock.port;
  return resolvePort(env.PORT !== undefined ? ['--port', env.PORT] : [], readConfig(dataDir));
}

export interface AdminResponse {
  status: number;
  // The server's JSON, read field by field by each command.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface AdminClient {
  request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<AdminResponse>;
}

export function createAdminClient({ port, token, fetchImpl = fetch }: { port: number; token: string; fetchImpl?: typeof fetch }): AdminClient {
  return {
    async request(method, path, body) {
      let res: Response;
      try {
        res = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            'x-aasc-role': 'cli',
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new AdminError(EXIT.NOT_RUNNING, `Nothing answers on 127.0.0.1:${port}: the server isn't running there. Check \`aasc-server status\`, or pass --port.`);
      }
      if (res.status === 401) {
        throw new AdminError(EXIT.FAILED, 'The server refused the owner token. It may have restarted since it was read: try again.');
      }
      const text = await res.text();
      let parsed: unknown = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text.slice(0, 200) }; }
      return { status: res.status, body: parsed };
    },
  };
}

/** The server's own error message for a refused request, safe to print. */
export function errorOf(res: AdminResponse, fallback: string): string {
  const message = res.body && typeof res.body === 'object' ? (res.body as { error?: unknown }).error : undefined;
  return typeof message === 'string' && message ? safeText(message) : `${fallback} (HTTP ${res.status})`;
}

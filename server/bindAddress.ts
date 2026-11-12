// bindAddress.ts — which interface the main listener binds (terminal-editions plan §7.3, §7.6).
//
// Every interface by default, as before. `AASC_BIND_ADDRESS` (or `bindAddress` in
// server-config.json; the env var wins) binds one, such as the box's Tailscale address, so the
// port stays off the Internet without a firewall rule. A reverse proxy (Caddy) never points at the
// main listener: it points at the remote-only listener (remoteListener.ts, plan §7.6), where every
// request counts as remote. On the main port, a proxy that adds no forwarding headers would pass as
// this machine (requestLocality.ts).
//
// A value that is not an IP address stops the start (EX_CONFIG 78). Falling back to every interface
// would do the opposite of what the owner asked for, silently.
//
// A specific address other than 127.0.0.1 also gets a loopback listener on the same port
// (startLoopbackCompanion). Several things on this machine only ever dial 127.0.0.1: the hook
// script's HTTP fallback, MCP centrals (mcp/launch.ts), the folder lock's liveness probe and the
// admin CLI with its owner token. That listener is NOT remote-only: its requests are as local as
// they are on today's every-interface bind, and the same isLocalRequest rule judges them.

import { createServer, type Server } from 'http';
import type { Express } from 'express';
import type { WebSocketServer } from 'ws';
import { z } from 'zod';
import { StartupError, EXIT_CODES } from './startupGuard.js';
import log from './logger.js';

const IpAddress = z.union([z.ipv4(), z.ipv6()]);

const LOOPBACK_V4 = '127.0.0.1';
/** Binds that already answer on 127.0.0.1: every interface, or loopback itself. */
const SERVES_LOOPBACK = new Set(['0.0.0.0', '::', LOOPBACK_V4]);

/** The address to bind, or null for every interface. Throws StartupError on an invalid value. */
export function resolveBindAddress(envValue: string | undefined, configValue: unknown): string | null {
  const fromEnv = envValue !== undefined && envValue.trim() !== '';
  const raw = fromEnv ? envValue : configValue;
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;
  const parsed = IpAddress.safeParse(typeof raw === 'string' ? raw.trim() : raw);
  if (!parsed.success) {
    throw new StartupError(
      EXIT_CODES.CONFIG,
      `${fromEnv ? 'AASC_BIND_ADDRESS' : 'bindAddress in server-config.json (AASC_BIND_ADDRESS)'} must be an IP address `
        + `such as 127.0.0.1 or this machine's Tailscale address, not ${JSON.stringify(raw)}.`,
    );
  }
  return parsed.data;
}

/** True when the main listener won't answer on 127.0.0.1 by itself. */
export function needsLoopbackCompanion(bindAddress: string | null): boolean {
  return bindAddress !== null && !SERVES_LOOPBACK.has(bindAddress);
}

/** Serve the same app and WebSocket server on 127.0.0.1:port. Resolves once listening. */
export function startLoopbackCompanion(app: Express, wss: WebSocketServer, port: number): Promise<Server> {
  const server = createServer(app);
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
  return new Promise<Server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK_V4, () => {
      server.off('error', reject);
      log.info('server', `Also listening on ${LOOPBACK_V4}:${port} for this machine's own tools (hooks, centrals, aasc-server)`);
      resolve(server);
    });
  });
}

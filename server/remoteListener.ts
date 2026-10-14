// remoteListener.ts — an optional second listener where every request is remote.
//
// Off by default. When enabled it binds 127.0.0.1 only, serves the same Express
// app and WebSocket server as the main port, and marks every connection remote
// (requestLocality.ts). It is the one place a tunnel (Cloudflare Tunnel,
// `tailscale serve`, a relay connector) may point: through it the password,
// session visibility and the localhost-only gates all apply.
//
// Enable with `remoteListenerPort` in server-config.json or the
// AASC_REMOTE_LISTENER_PORT environment variable (the env var wins).

import { createServer, type Server } from 'http';
import type { Express } from 'express';
import type { WebSocketServer } from 'ws';
import { markRemoteOnlyServer } from './requestLocality.js';
import log from './logger.js';

export const REMOTE_LISTENER_HOST = '127.0.0.1';

/**
 * Resolve the configured port, or null when the listener is disabled.
 * Invalid values and a port equal to the main one disable it with a warning
 * rather than starting a listener nobody asked for.
 */
export function resolveRemoteListenerPort(
  envValue: string | undefined,
  configValue: number | null | undefined,
  mainPort: number,
): number | null {
  const raw = envValue !== undefined && envValue.trim() !== '' ? Number(envValue) : configValue;
  if (raw === undefined || raw === null) return null;
  if (!Number.isInteger(raw) || raw < 1 || raw > 65535) {
    log.warn('remote-listener', `Ignoring invalid remote listener port: ${String(raw)}`);
    return null;
  }
  if (raw === mainPort) {
    log.warn('remote-listener', `Remote listener port ${raw} equals the main port; not starting it`);
    return null;
  }
  return raw;
}

/** Start the remote-only listener. Resolves with the server once it is listening. */
export function startRemoteListener(app: Express, wss: WebSocketServer, port: number): Promise<Server> {
  const server = createServer(app);
  markRemoteOnlyServer(server);
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
  return new Promise<Server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, REMOTE_LISTENER_HOST, () => {
      server.off('error', reject);
      log.info('remote-listener', `Remote-only listener on ${REMOTE_LISTENER_HOST}:${port} (every request is treated as remote)`);
      resolve(server);
    });
  });
}

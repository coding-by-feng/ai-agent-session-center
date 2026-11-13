/**
 * From a stored server to a signed-in connection: an origin to call and a bearer token.
 *
 *   paired  challenge → HMAC(SHA-256(device key), nonce) → /session, at the first address
 *           that answers: home LAN → Tailscale → public (only if added with --insecure).
 *           The session token lives in memory for this command; only the device key is on disk.
 *   ssh     the owner token, read over SSH, through a fresh `ssh -L` tunnel to the server's
 *           loopback: a private Unix socket (TCP only for aasc open). close() kills the tunnel.
 *
 * A call that fails on the wire (no answer, a dropped tunnel, an answer past its size cap)
 * becomes exit 2, or 5 over SSH: never the generic exit 1.
 */
import { randomBytes } from 'crypto';
import { hostname } from 'os';
import {
  fetchPaths, signIn, type FetchLike, type RemoteClientDeps, type RemoteTarget, type Via,
} from '../../electron/remote/remoteClient.js';
import { createRequester, unixSocketFetch, type ApiAuth, type Requester } from './http.js';
import { openTunnel, parseSshTarget, readOwnerToken, type SpawnLike } from './ssh.js';
import type { ServerRecord, Store } from './store.js';
import { CliError, EXIT } from './exitCodes.js';

export interface Connection {
  server: ServerRecord;
  auth: ApiAuth;
  via: Via | 'ssh';
  /** Set when the tunnel's local end is a Unix socket: HTTP and the WebSocket go through it. */
  socketPath?: string;
  request: Requester;
  close(): void;
}

export interface ConnectDeps {
  store: Store;
  fetch?: FetchLike;
  spawn?: SpawnLike;
  /** SSH only: 'tcp' for aasc open (a browser can't dial a socket). Default: a Unix socket. */
  transport?: 'unix' | 'tcp';
}

/** Turn a failure on the wire into the right exit code; an HTTP status still comes back as an answer. */
function guarded(request: Requester, server: ServerRecord, via: Via | 'ssh'): Requester {
  return async (method, path, body) => {
    try {
      return await request(method, path, body);
    } catch (err) {
      const code = via === 'ssh' ? EXIT.SSH : EXIT.UNREACHABLE;
      const tooLarge = err instanceof Error && err.message === 'answer too large';
      throw new CliError(code, tooLarge
        ? `${server.name} sent an answer too large to read.`
        : `Lost the connection to ${server.name}${via === 'ssh' ? ' (the ssh tunnel)' : ''}.`);
    }
  };
}

const VIA_LABEL: Record<Via | 'ssh', string> = { lan: 'home LAN', tailnet: 'Tailscale', public: 'public address', https: 'hosted HTTPS', ssh: 'SSH' };
export const viaLabel = (via: Via | 'ssh'): string => VIA_LABEL[via];

/** `aasc on <hostname>`: how this computer is named in the server's devices list and presence. */
export function clientLabel(): string {
  const host = hostname().replace(/\.local$/i, '').replace(/[\x00-\x1F\x7F\p{Cf}]/gu, '').trim().slice(0, 64);
  return `aasc on ${host || 'a terminal'}`;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init) as ReturnType<FetchLike>;

export function remoteDeps(f: FetchLike = defaultFetch): RemoteClientDeps {
  return { fetch: f, randomHex: (n) => randomBytes(n).toString('hex') };
}

export function targetOf(server: ServerRecord): RemoteTarget {
  return {
    lan: server.addresses?.lan ?? null,
    tailnet: server.addresses?.tailnet ?? null,
    publicAddress: server.addresses?.public ?? null,
    port: server.port,
  };
}

function reachNames(server: ServerRecord): string {
  const names = [
    server.addresses?.lan ? 'the home LAN' : null,
    server.addresses?.tailnet ? 'Tailscale' : null,
    server.addresses?.public ? 'its public address' : null,
  ].filter(Boolean);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : (names[0] ?? 'any address');
}

async function connectPaired(server: ServerRecord, deps: ConnectDeps): Promise<Connection> {
  const key = deps.store.readKey(server.id);
  if (!key || !server.deviceId) {
    throw new CliError(EXIT.NOT_SIGNED_IN, `${server.name} has no device key here. Remove it and add it again with a new pairing link.`);
  }
  const rd = remoteDeps(deps.fetch);
  const creds = { deviceId: server.deviceId, deviceToken: key };
  const r = await signIn(rd, targetOf(server), creds);
  if (r.state === 'offline') throw new CliError(EXIT.UNREACHABLE, `Can’t reach ${server.name} on ${reachNames(server)}.`);
  if (r.state === 'pending') throw new CliError(EXIT.NOT_SIGNED_IN, `Press Allow on ${server.name} first.`);
  if (r.state === 'revoked') {
    throw new CliError(EXIT.NOT_SIGNED_IN, r.verified
      ? `${server.name} revoked this computer. aasc remove ${server.name}, then add it again with a new link.`
      : `${server.name} doesn’t know this computer any more. aasc remove ${server.name}, then add it again with a new link.`);
  }
  if (r.state === 'error') throw new CliError(EXIT.NOT_SIGNED_IN, `${server.name}: ${r.message}`);

  // Like the desktop: keep the Tailscale address current, but only on the server's proof.
  const paths = await fetchPaths(rd, r.origin, r.token, creds);
  if (paths && paths.port === server.port && paths.tailnet !== (server.addresses?.tailnet ?? null)) {
    try {
      deps.store.updateServer({ ...server, addresses: { lan: server.addresses?.lan ?? null, public: server.addresses?.public ?? null, tailnet: paths.tailnet } });
    } catch { /* a refresh is best effort */ }
  }

  const auth: ApiAuth = { origin: r.origin, bearer: r.token, clientId: server.clientId, label: clientLabel() };
  return { server, auth, via: r.via, request: guarded(createRequester({ fetch: rd.fetch }, auth), server, r.via), close: () => {} };
}

async function connectSsh(server: ServerRecord, deps: ConnectDeps): Promise<Connection> {
  const target = server.sshTarget ? parseSshTarget(server.sshTarget) : null;
  if (!target) throw new CliError(EXIT.USAGE, `${server.name}’s SSH target isn’t valid. Remove it and add it again.`);
  try {
    const token = await readOwnerToken(target, { spawn: deps.spawn, remoteDataDir: server.remoteDataDir });
    const tunnel = await openTunnel(target, { remotePort: server.port, spawn: deps.spawn, transport: deps.transport });
    const socketPath = tunnel.socketPath;
    const auth: ApiAuth = {
      origin: socketPath ? 'http://localhost' : `http://127.0.0.1:${tunnel.port}`,
      bearer: token, clientId: server.clientId, label: clientLabel(),
    };
    const fetchVia = deps.fetch ?? (socketPath ? unixSocketFetch(socketPath) : defaultFetch);
    return {
      server, auth, via: 'ssh', socketPath,
      request: guarded(createRequester({ fetch: fetchVia }, auth), server, 'ssh'),
      close: () => tunnel.close(),
    };
  } catch (err) {
    if (err instanceof CliError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.SSH, message);
  }
}

export function connect(server: ServerRecord, deps: ConnectDeps): Promise<Connection> {
  return server.mode === 'ssh' ? connectSsh(server, deps) : connectPaired(server, deps);
}

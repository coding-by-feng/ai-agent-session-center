/**
 * `aasc watch [<server>] [--notify]`: live status changes from every server, until Ctrl-C (plan §9.9).
 *
 * A dropped network can leave a socket that looks open and never speaks again, so each socket
 * is pinged every PING_MS; one that misses a pong is ended, and watch reconnects with backoff
 * (signing in again: a paired session token expires).
 */
import WebSocket from 'ws';
import { buildWsUrl, openWebSocket } from './attach.js';
import { connect, viaLabel, type Connection } from './connect.js';
import { identityHeaders } from './http.js';
import { serversFor } from './sessionCommands.js';
import { applyWatchMessage, createWatchState, formatWatchLine, notifySequence, type WatchState } from './watch.js';
import { clock, plural } from './render.js';
import { flagBool, type ParsedArgs } from './args.js';
import { CliError, EXIT } from './exitCodes.js';
import type { ServerRecord } from './store.js';
import type { Ctx } from './context.js';

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const BELL = '\x07';
const PING_MS = 30_000;

/** One socket's life: resolves when it closes. Paired sign-ins expire, so each reconnect signs in again. */
export function watchSocket(
  ctx: Pick<Ctx, 'out' | 'err' | 'now' | 'env'>, conn: Connection, state: WatchState, notify: boolean,
  opts: { pingMs?: number } = {},
): Promise<void> {
  return new Promise((resolve) => {
    const ws = openWebSocket(
      buildWsUrl(conn.auth.origin, { clientId: conn.auth.clientId, label: conn.auth.label }, conn.socketPath),
      identityHeaders(conn.auth),
    );
    // Heartbeat: no pong since the last ping means the connection is gone, whatever it looks like.
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      try { ws.ping(); } catch { /* not open yet, or already closing */ }
    }, opts.pingMs ?? PING_MS);
    ws.on('pong', () => { alive = true; });
    const name = conn.server.name;
    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: unknown;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if ((msg as { type?: unknown })?.type === 'snapshot') {
        applyWatchMessage(state, name, msg, ctx.now());
        ctx.out(`${clock(ctx.now())}  ${name} · connected · ${viaLabel(conn.via)} · ${plural(state.get(name)?.size ?? 0, 'session')}`);
        return;
      }
      for (const ev of applyWatchMessage(state, name, msg, ctx.now())) {
        let line = formatWatchLine(ev);
        if (ev.attention) {
          line += BELL;
          if (notify) line += notifySequence(`${name}: ${ev.title} needs you (${ev.to})`, ctx.env);
        }
        ctx.out(line);
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      ctx.err(`${clock(ctx.now())}  ${name} · refused (${res.statusCode ?? '?'})`);
    });
    ws.on('error', () => { /* 'close' follows */ });
    ws.on('close', () => {
      clearInterval(heartbeat);
      resolve();
    });
  });
}

async function watchServer(ctx: Ctx, server: ServerRecord, state: WatchState, notify: boolean): Promise<never> {
  let delay = RETRY_MIN_MS;
  for (;;) {
    let conn: Connection | null = null;
    try {
      conn = await connect(server, { store: ctx.store, fetch: ctx.fetch, spawn: ctx.spawn });
      const started = ctx.now();
      await watchSocket(ctx, conn, state, notify);
      // A socket that stayed up a while earns a quick retry.
      if (ctx.now() - started > RETRY_MAX_MS) delay = RETRY_MIN_MS;
      ctx.err(`${clock(ctx.now())}  ${server.name} · disconnected; retrying in ${Math.round(delay / 1000)} s`);
    } catch (err) {
      ctx.err(`${clock(ctx.now())}  ${server.name} · ${err instanceof Error ? err.message : String(err)} Retrying in ${Math.round(delay / 1000)} s.`);
    } finally {
      conn?.close();
    }
    await ctx.sleep(delay);
    delay = Math.min(RETRY_MAX_MS, delay * 2);
  }
}

export async function cmdWatch(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const servers = serversFor(ctx, args.positionals[0]);
  const notify = flagBool(args, 'notify');
  ctx.err(`Watching ${servers.map((s) => s.name).join(', ')}. Ctrl-C stops.`);
  const state = createWatchState();
  await Promise.all(servers.map((s) => watchServer(ctx, s, state, notify)));
  throw new CliError(EXIT.UNREACHABLE, 'watch ended');
}

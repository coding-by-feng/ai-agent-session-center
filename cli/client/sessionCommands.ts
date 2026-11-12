/** `aasc ls`, `attach`, `send` and `queue` (plan §9.4, §9.6, §9.8). */
import { sessionDisplayTitle } from '../../src/lib/sessionDisplayTitle.js';
import { attach, buildWsUrl, type AttachIo } from './attach.js';
import { onCleanup } from './cleanup.js';
import { cleanText, safeJson } from './sanitize.js';
import { connect, viaLabel, type Connection } from './connect.js';
import { identityHeaders } from './http.js';
import { renderSessionTable, cleanCell, plural } from './render.js';
import { matchSession, orderSessions, parseSessions, resolveRef, type RemoteSession } from './sessions.js';
import { queuePrompt, sendNow } from './send.js';
import type { LastLsEntry, ServerRecord } from './store.js';
import { flagBool, type ParsedArgs } from './args.js';
import { CliError, EXIT } from './exitCodes.js';
import type { Ctx } from './context.js';

export function serversFor(ctx: Ctx, name: string | undefined): ServerRecord[] {
  const all = ctx.store.listServers();
  if (all.length === 0) {
    throw new CliError(EXIT.USAGE, 'No servers yet. Add one:  aasc add \'<pairing link>\'   or   aasc add --ssh you@host');
  }
  if (name === undefined) return all;
  const one = all.find((s) => s.name === name);
  if (!one) throw new CliError(EXIT.USAGE, `No server called "${name}". Run aasc servers.`);
  return [one];
}

async function fetchSessions(conn: Connection): Promise<RemoteSession[]> {
  const a = await conn.request('GET', '/api/sessions');
  if (a.status === 401) throw new CliError(EXIT.NOT_SIGNED_IN, `${conn.server.name} didn’t accept this computer’s sign-in.`);
  if (a.status !== 200) throw new CliError(EXIT.UNREACHABLE, `${conn.server.name} answered ${a.status} for its session list.`);
  try {
    return parseSessions(a.data);
  } catch {
    throw new CliError(EXIT.UNREACHABLE, `${conn.server.name} sent a session list aasc can’t read.`);
  }
}

type ServerListing =
  | { server: ServerRecord; ok: true; via: string; sessions: RemoteSession[] }
  | { server: ServerRecord; ok: false; code: number; error: string };

async function listOne(ctx: Ctx, server: ServerRecord): Promise<ServerListing> {
  let conn: Connection | null = null;
  try {
    conn = await connect(server, { store: ctx.store, fetch: ctx.fetch, spawn: ctx.spawn });
    const sessions = orderSessions(await fetchSessions(conn));
    return { server, ok: true, via: viaLabel(conn.via), sessions };
  } catch (err) {
    const code = err instanceof CliError ? err.code : EXIT.UNREACHABLE;
    return { server, ok: false, code, error: err instanceof Error ? err.message : String(err) };
  } finally {
    conn?.close();
  }
}

export async function cmdLs(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const servers = serversFor(ctx, args.positionals[0]);
  const listings = await Promise.all(servers.map((s) => listOne(ctx, s)));
  const covered = new Set(servers.map((s) => s.name));
  const numbered: LastLsEntry[] = ctx.store.readLastLs().filter((e) => !covered.has(e.server));
  for (const l of listings) {
    if (l.ok) l.sessions.forEach((s, i) => numbered.push({ n: i + 1, server: l.server.name, sessionId: s.sessionId }));
  }
  ctx.store.writeLastLs(numbered);

  if (flagBool(args, 'json')) {
    // The raw entries, every field the server sent, escaped for the terminal.
    ctx.out(safeJson({
      servers: listings.map((l) => (l.ok
        ? { name: l.server.name, online: true, via: l.via, sessions: l.sessions }
        : { name: l.server.name, online: false, error: l.error })),
    }));
  } else {
    const now = ctx.now();
    listings.forEach((l, i) => {
      if (i > 0) ctx.out('');
      if (!l.ok) { ctx.out(`${l.server.name} · offline: ${l.error}`); return; }
      const count = l.server.mode === 'ssh' ? plural(l.sessions.length, 'session') : `${l.sessions.length} shared`;
      ctx.out(`${l.server.name} · online · ${l.via} · ${count}`);
      ctx.out(l.sessions.length ? renderSessionTable(l.sessions, now) : '  (no sessions)');
    });
  }
  const failed = listings.filter((l): l is Extract<ServerListing, { ok: false }> => !l.ok);
  return failed.length === listings.length ? failed[0].code : EXIT.OK;
}

interface Resolved {
  conn: Connection;
  session: RemoteSession;
  /** How to name it in messages: `vps:2`, or `vps:<id prefix>`. */
  label: string;
}

/** A session ref → a connected server and the session, or a CliError with the right exit code. */
export async function resolveSession(ctx: Ctx, ref: string | undefined): Promise<Resolved> {
  if (!ref) throw new CliError(EXIT.USAGE, 'Name a session: a number from aasc ls, an id prefix, or words from its title.');
  const servers = ctx.store.listServers();
  if (servers.length === 0) throw new CliError(EXIT.USAGE, 'No servers yet. Add one with aasc add.');
  const lastLs = ctx.store.readLastLs();
  const r = resolveRef(ref, { serverNames: servers.map((s) => s.name), lastLs });
  if (!r.ok) throw new CliError(EXIT.USAGE, r.error);
  const candidates = r.server ? servers.filter((s) => s.name === r.server) : servers;
  if (candidates.length === 0) throw new CliError(EXIT.USAGE, `No server called "${r.server}". Run aasc servers.`);
  if ('sessionId' in r) {
    const server = candidates[0];
    const conn = await connect(server, { store: ctx.store, fetch: ctx.fetch, spawn: ctx.spawn });
    try {
      const session = (await fetchSessions(conn)).find((s) => s.sessionId === r.sessionId && s.status !== 'ended');
      const n = lastLs.find((e) => e.server === server.name && e.sessionId === r.sessionId)?.n;
      const label = `${server.name}:${n ?? cleanText(r.sessionId).slice(0, 8)}`;
      if (!session) {
        throw new CliError(EXIT.NOT_FOUND, server.mode === 'paired'
          ? `${label} isn’t shared with this computer (or has ended). Run aasc ls.`
          : `${label} isn’t running on ${server.name} any more. Run aasc ls.`);
      }
      return { conn, session, label };
    } catch (err) {
      conn.close();
      throw err;
    }
  }
  return resolveQuery(ctx, candidates, r.query, lastLs);
}

async function resolveQuery(ctx: Ctx, servers: ServerRecord[], query: string, lastLs: LastLsEntry[]): Promise<Resolved> {
  const conns: Connection[] = [];
  const hits: { conn: Connection; session: RemoteSession }[] = [];
  const errors: CliError[] = [];
  let kept: Connection | null = null;
  try {
    for (const server of servers) {
      try {
        const conn = await connect(server, { store: ctx.store, fetch: ctx.fetch, spawn: ctx.spawn });
        conns.push(conn);
        const m = matchSession(query, orderSessions(await fetchSessions(conn)));
        if (m.ok) hits.push({ conn, session: m.session });
        else if (m.reason === 'ambiguous') throw new CliError(EXIT.USAGE, `${server.name}: ${m.error}`);
      } catch (err) {
        if (err instanceof CliError && err.code === EXIT.USAGE) throw err;
        errors.push(err instanceof CliError ? err : new CliError(EXIT.UNREACHABLE, String(err)));
      }
    }
    if (hits.length > 1) {
      throw new CliError(EXIT.USAGE, `"${query}" matches sessions on ${hits.map((h) => h.conn.server.name).join(' and ')}. Prefix the server, e.g. ${hits[0].conn.server.name}:${query}`);
    }
    if (hits.length === 0) {
      if (errors.length === servers.length && errors[0]) throw errors[0];
      throw new CliError(EXIT.NOT_FOUND, `No session matches "${query}". Run aasc ls.`);
    }
    const { conn, session } = hits[0];
    kept = conn;
    const n = lastLs.find((e) => e.server === conn.server.name && e.sessionId === session.sessionId)?.n;
    return { conn, session, label: `${conn.server.name}:${n ?? cleanText(session.sessionId).slice(0, 8)}` };
  } finally {
    for (const c of conns) if (c !== kept) c.close();
  }
}

function processAttachIo(): AttachIo {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    // 0 × 0 means the tty doesn't know its size (e.g. under script(1)): assume the classic 80 × 24.
    size: () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
    onResize: (cb) => {
      process.stdout.on('resize', cb);
      return () => process.stdout.off('resize', cb);
    },
    // Exit, SIGINT, SIGTERM and SIGHUP all restore the terminal (cleanup.ts), like the tunnel.
    onExit: onCleanup,
  };
}

export async function cmdAttach(ctx: Ctx, args: ParsedArgs): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError(EXIT.USAGE, 'aasc attach needs a terminal on both stdin and stdout.');
  const { conn, session, label } = await resolveSession(ctx, args.positionals[0]);
  try {
    if (!session.terminalId) throw new CliError(EXIT.NOT_FOUND, `${label} has no terminal to attach to.`);
    ctx.err(`Attaching to ${label} “${cleanCell(sessionDisplayTitle(session))}”. Ctrl-] detaches.`);
    const result = await attach({
      url: buildWsUrl(conn.auth.origin, { clientId: conn.auth.clientId, label: conn.auth.label }, conn.socketPath),
      headers: identityHeaders(conn.auth),
      terminalId: session.terminalId,
      io: processAttachIo(),
    });
    ctx.err(result.message ? `${result.message} (${label})` : `Detached from ${label}.`);
    return result.code;
  } finally {
    conn.close();
  }
}

/** Everything after the session ref, as one prompt. */
function promptText(args: ParsedArgs): string {
  return args.positionals.slice(1).join(' ');
}

export async function cmdSend(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const text = promptText(args);
  if (!text) throw new CliError(EXIT.USAGE, 'Usage: aasc send <session> "text"');
  const { conn, session, label } = await resolveSession(ctx, args.positionals[0]);
  try {
    return await sendNow(
      { request: conn.request, sleep: ctx.sleep, confirm: ctx.confirm, out: ctx.out },
      { ref: label, session }, text, { force: flagBool(args, 'force') },
    );
  } finally {
    conn.close();
  }
}

export async function cmdQueue(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const text = promptText(args);
  if (!text) throw new CliError(EXIT.USAGE, 'Usage: aasc queue <session> "text"');
  const { conn, session, label } = await resolveSession(ctx, args.positionals[0]);
  try {
    return await queuePrompt({ request: conn.request, out: ctx.out }, { ref: label, session }, text);
  } finally {
    conn.close();
  }
}

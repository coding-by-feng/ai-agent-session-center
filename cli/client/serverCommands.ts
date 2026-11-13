/** `aasc add`, `aasc servers` and `aasc remove` (plan §9.1–§9.3, §9.5). */
import { readRemotePairingLink, type RemotePairingLink } from '../../electron/remote/pairingLinkRules.js';
import { pair, signIn, unpair, unreachableMessage } from '../../electron/remote/remoteClient.js';
import { clientLabel, connect, remoteDeps, targetOf } from './connect.js';
import { parseSessions } from './sessions.js';
import { isValidServerName, type ServerRecord } from './store.js';
import { parseSshTarget, remoteTokenPath } from './ssh.js';
import { flagBool, flagString, parsePort, type ParsedArgs } from './args.js';
import { CliError, EXIT } from './exitCodes.js';
import type { Ctx } from './context.js';
import { cleanText, safeJson } from './sanitize.js';
import { plural } from './render.js';

/** The server's default port when the user names none (= the app's own default). */
export const DEFAULT_SERVER_PORT = 3333;
const ALLOW_POLL_MS = 2_000;
/** A pairing link lives 10 minutes; waiting longer than that for Allow is pointless. */
const ALLOW_WAIT_MS = 10 * 60_000;

/** A server name from a link's name or a host: lowercase, [a-z0-9-], ≤ 32. */
export function slugName(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return slug || 'server';
}

function chooseName(ctx: Ctx, wanted: string | undefined, fallback: string): string {
  const name = wanted ?? slugName(fallback);
  if (!isValidServerName(name)) throw new CliError(EXIT.USAGE, `"${name}" isn’t a usable name: letters, digits, - or _.`);
  if (ctx.store.getServer(name)) {
    throw new CliError(EXIT.USAGE, `A server called "${name}" is already added. Pick another with --name, or aasc remove ${name}.`);
  }
  return name;
}

/** 482913 → "482 913", the way the server shows it. */
const spaced = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

/** A public address is plain HTTP over the Internet: kept only with --insecure. */
function linkForThisClient(link: RemotePairingLink, insecure: boolean): RemotePairingLink {
  if (!link.publicAddress || insecure) return link;
  if (!link.lan && !link.tailnet) {
    throw new CliError(EXIT.USAGE,
      'This link names only a public address: plain HTTP over the Internet, where your sign-in and terminal bytes travel unencrypted. '
      + 'Use Tailscale or aasc add --ssh instead, or add --insecure to accept that.');
  }
  const { publicAddress: _dropped, ...rest } = link;
  return rest;
}

async function waitForAllow(ctx: Ctx, server: ServerRecord, deviceToken: string): Promise<number> {
  const deps = remoteDeps(ctx.fetch);
  const deadline = ctx.now() + ALLOW_WAIT_MS;
  let saidOffline = false;
  while (ctx.now() < deadline) {
    const r = await signIn(deps, targetOf(server), { deviceId: server.deviceId ?? '', deviceToken });
    if (r.state === 'ok') {
      ctx.out(`✓ Paired. ${server.name} shares only the sessions marked shared there.`);
      return EXIT.OK;
    }
    if (r.state === 'revoked') {
      ctx.store.removeServer(server.name);
      ctx.out(`✕ ${server.name} denied this computer. Nothing was kept.`);
      return EXIT.NOT_SIGNED_IN;
    }
    if ((r.state === 'offline' || r.state === 'error') && !saidOffline) {
      saidOffline = true;
      ctx.err(`(${r.message} Still waiting.)`);
    }
    await ctx.sleep(ALLOW_POLL_MS);
  }
  ctx.out(`Still not allowed after 10 minutes. ${server.name} stays added: press Allow there, then run aasc ls.`);
  return EXIT.NOT_SIGNED_IN;
}

async function addPaired(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const raw = args.positionals[0];
  if (!raw) throw new CliError(EXIT.USAGE, 'Usage: aasc add \'<pairing link>\' [--name vps]   or   aasc add --ssh you@host');
  const read = readRemotePairingLink(raw);
  if (!read.ok) throw new CliError(EXIT.USAGE, read.error);
  const link = linkForThisClient(read.link, flagBool(args, 'insecure'));
  // Check the name before pairing: pairing spends the link's one-time code.
  const name = chooseName(ctx, flagString(args, 'name'), link.name);
  const target = { lan: link.lan, tailnet: link.tailnet, publicAddress: link.publicAddress ?? null, port: link.port };
  const paired = await pair(remoteDeps(ctx.fetch), link, clientLabel());
  if (!paired.ok) {
    throw new CliError(paired.error === unreachableMessage(target) ? EXIT.UNREACHABLE : EXIT.USAGE, paired.error);
  }
  const server = ctx.store.addServer({
    name, mode: 'paired', deviceId: paired.deviceId, port: link.port,
    addresses: { lan: link.lan, tailnet: link.tailnet, public: link.publicAddress ?? null },
  }, paired.deviceToken);
  const shown = cleanText(link.name);
  ctx.out(`Added "${name}" (${shown}).`);
  ctx.out(`Check ${shown} shows ${spaced(paired.confirmCode)}, then press Allow there.`);
  ctx.out('Waiting for Allow… (Ctrl-C stops waiting; the server stays added)');
  return waitForAllow(ctx, server, paired.deviceToken);
}

async function addSsh(ctx: Ctx, args: ParsedArgs, rawTarget: string): Promise<number> {
  const target = parseSshTarget(rawTarget);
  if (!target) throw new CliError(EXIT.USAGE, '--ssh needs user@host or user@host:port (letters, digits, . _ - only).');
  const remoteDataDir = flagString(args, 'remote-data-dir');
  if (remoteDataDir !== undefined) remoteTokenPath(remoteDataDir); // throws on a bad folder
  const name = chooseName(ctx, flagString(args, 'name'), target.host.split('.')[0]);
  const server = ctx.store.addServer({
    name, mode: 'ssh', sshTarget: rawTarget, port: parsePort(flagString(args, 'port'), DEFAULT_SERVER_PORT),
    ...(remoteDataDir !== undefined ? { remoteDataDir } : {}),
  });
  ctx.out(`Checking ${target.destination} over SSH…`);
  try {
    const conn = await connect(server, { store: ctx.store, fetch: ctx.fetch, spawn: ctx.spawn });
    try {
      const a = await conn.request('GET', '/api/sessions');
      if (a.status !== 200) throw new CliError(EXIT.NOT_SIGNED_IN, `The server refused the owner token (${a.status}). Is it new enough to accept SSH owners?`);
      ctx.out(`✓ Added "${name}" (SSH, owner): ${plural(parseSessions(a.data).length, 'session')}.`);
      return EXIT.OK;
    } finally {
      conn.close();
    }
  } catch (err) {
    ctx.store.removeServer(name);
    throw err;
  }
}

export function cmdAdd(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const ssh = flagString(args, 'ssh');
  return ssh !== undefined ? addSsh(ctx, args, ssh) : addPaired(ctx, args);
}

function describe(s: ServerRecord): string {
  if (s.mode === 'ssh') return `ssh ${s.sshTarget ?? '?'} · port ${s.port}${s.remoteDataDir ? ` · ${s.remoteDataDir}` : ''}`;
  const where = [
    s.addresses?.lan ? `LAN ${s.addresses.lan}` : null,
    s.addresses?.tailnet ? `Tailscale ${s.addresses.tailnet}` : null,
    s.addresses?.public ? `public ${s.addresses.public} (insecure)` : null,
  ].filter(Boolean).join(' · ');
  return `paired · ${where} · port ${s.port}`;
}

export async function cmdServers(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const list = ctx.store.listServers();
  if (flagBool(args, 'json')) {
    ctx.out(safeJson(list.map(({ clientId: _c, ...rest }) => rest)));
    return EXIT.OK;
  }
  if (list.length === 0) {
    ctx.out('No servers yet. Add one:  aasc add \'<pairing link>\'   or   aasc add --ssh you@host');
    return EXIT.OK;
  }
  const width = Math.max(...list.map((s) => s.name.length));
  for (const s of list) ctx.out(`${s.name.padEnd(width)}  ${describe(s)}  · added ${s.pairedAt.slice(0, 10)}`);
  return EXIT.OK;
}

export async function cmdRemove(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const name = args.positionals[0];
  if (!name) throw new CliError(EXIT.USAGE, 'Usage: aasc remove <server>');
  const server = ctx.store.getServer(name);
  if (!server) throw new CliError(EXIT.USAGE, `No server called "${name}". Run aasc servers.`);
  if (server.mode === 'paired') {
    let key: string | null = null;
    try { key = ctx.store.readKey(server.id); } catch { key = null; }
    const unpaired = key && server.deviceId
      ? await unpair(remoteDeps(ctx.fetch), targetOf(server), { deviceId: server.deviceId, deviceToken: key })
      : false;
    ctx.store.removeServer(name);
    ctx.out(unpaired
      ? `✓ Unpaired from ${name} and forgot it.`
      : `Forgot ${name} here, but couldn’t reach it to unpair. On that server, run: aasc-server devices revoke`);
    return EXIT.OK;
  }
  ctx.store.removeServer(name);
  ctx.out(`✓ Forgot ${name}. (SSH access itself is unchanged.)`);
  return EXIT.OK;
}

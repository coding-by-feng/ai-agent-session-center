/**
 * `aasc open [<server>]`: the server's web UI in a browser. Paired, that's the address that
 * answered (sign in there with the dashboard password). Over SSH it's the tunnel's local
 * address, kept open until Ctrl-C; the server then treats the browser as local.
 *
 * A browser can't dial a Unix socket, so this is the one command whose SSH tunnel is a TCP
 * port on 127.0.0.1, which other local users can reach while it's open. The dashboard
 * password still guards it; the owner token never travels through it.
 */
import { execFile } from 'child_process';
import { connect } from './connect.js';
import { onCleanup } from './cleanup.js';
import { serversFor } from './sessionCommands.js';
import type { ParsedArgs } from './args.js';
import { CliError, EXIT } from './exitCodes.js';
import type { Ctx } from './context.js';

/** The platform's URL opener, as an argument array: no shell. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+\/?$/.test(url)) throw new CliError(EXIT.USAGE, 'Refusing to open an unexpected URL.');
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

function openBrowser(ctx: Ctx, url: string): void {
  const [cmd, args] = browserCommand(url);
  execFile(cmd, args, { shell: false }, (err) => {
    if (err) ctx.err(`Couldn’t start a browser (${cmd}). Open ${url} yourself.`);
  });
}

export async function cmdOpen(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const servers = serversFor(ctx, args.positionals[0]);
  if (servers.length > 1) throw new CliError(EXIT.USAGE, `Name one: aasc open ${servers.map((s) => s.name).join(' | ')}`);
  const conn = await connect(servers[0], { store: ctx.store, fetch: ctx.fetch, spawn: ctx.spawn, transport: 'tcp' });
  const url = `${conn.auth.origin}/`;
  if (conn.via !== 'ssh') {
    conn.close();
    ctx.out(`Opening ${url}. Sign in there with ${servers[0].name}’s dashboard password.`);
    openBrowser(ctx, url);
    return EXIT.OK;
  }
  ctx.out(`Tunnel open: ${url}  (sign in with the dashboard password). Ctrl-C closes it.`);
  ctx.out('While it is open, other users on this computer can reach that port too.');
  openBrowser(ctx, url);
  // Ctrl-C ends the process through cleanup.ts (exit 130), which runs this.
  onCleanup(() => {
    conn.close();
    ctx.out('Tunnel closed.');
  });
  return new Promise<number>(() => { /* until a signal */ });
}

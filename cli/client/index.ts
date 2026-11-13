/**
 * `aasc`: the AASC terminal client (terminal editions plan §9). List, attach to, send to,
 * queue for and watch the agent sessions on AASC servers, from any terminal.
 *
 * Two ways to reach a server: pairing (a computer token, shared sessions only, revocable)
 * or `--ssh` owner mode (the server's owner token read over SSH, through an SSH tunnel).
 */
import { parseArgs, type ParsedArgs } from './args.js';
import { processCtx, type Ctx } from './context.js';
import { CliError, EXIT } from './exitCodes.js';
import { createStore } from './store.js';
import { cmdAdd, cmdRemove, cmdServers } from './serverCommands.js';
import { cmdAttach, cmdLs, cmdQueue, cmdSend } from './sessionCommands.js';
import { cmdWatch } from './watchCommand.js';
import { cmdOpen } from './openCommand.js';
import { cleanText } from './sanitize.js';

declare const __AASC_VERSION__: string | undefined;
export const VERSION = typeof __AASC_VERSION__ === 'string' ? __AASC_VERSION__ : 'dev';

export const HELP = `aasc ${VERSION}: the AASC terminal client

Usage:
  aasc add '<pairing link>' [--name vps] [--insecure]
                                  pair as a computer; waits for Allow on the server
  aasc add --ssh you@host[:port] [--name vps] [--port 3333] [--remote-data-dir DIR]
                                  owner mode over SSH: no pairing, every session
  aasc servers [--json]           the servers added here
  aasc remove <server>            unpair and forget a server
  aasc ls [<server>] [--json]     sessions and their status
  aasc attach <session>           this terminal on the session's; Ctrl-] detaches,
                                  Ctrl-] twice types one Ctrl-]
  aasc send <session> "text"      type the prompt and press Enter [--force]
  aasc queue <session> "text"     add a paused item to the session's queue
  aasc watch [<server>] [--notify]
                                  status changes as they happen; bell on approval/input
  aasc open [<server>]            the server's web UI in your browser; with an --ssh
                                  server it opens a TCP port on 127.0.0.1 (a browser
                                  can't use a socket), reachable by this computer's
                                  other users while open. Every other command tunnels
                                  over a private Unix socket.

A session is its number in the last aasc ls, an id prefix, or words from its title.
With several servers, prefix the server: vps:2, vps:migrate db.

--insecure accepts a pairing link's public address: plain HTTP over the Internet.

Exit codes: 0 done · 1 usage · 2 unreachable · 3 not signed in · 4 session not found
            or not shared · 5 SSH failed
Files: $XDG_CONFIG_HOME/aasc (default ~/.config/aasc), 0700; keys are 0600 files.`;

type Command = (ctx: Ctx, args: ParsedArgs) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  add: cmdAdd,
  servers: cmdServers,
  remove: cmdRemove,
  ls: cmdLs,
  attach: cmdAttach,
  send: cmdSend,
  queue: cmdQueue,
  watch: cmdWatch,
  open: cmdOpen,
};

/** Run one `aasc` command; resolves with its exit code. Never throws. */
export async function main(argv: string[], makeCtx: () => Ctx = () => processCtx(createStore())): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.USAGE;
  }
  if (args.flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (args.flags.help || args.command === null || args.command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return EXIT.OK;
  }
  const command = COMMANDS[args.command];
  if (!command) {
    process.stderr.write(`Unknown command "${args.command.slice(0, 40)}". Run aasc --help.\n`);
    return EXIT.USAGE;
  }
  let ctx: Ctx | null = null;
  try {
    ctx = makeCtx();
    return await command(ctx, args);
  } catch (err) {
    // Messages can quote what a server or a link said: printed line by line, cleaned.
    const message = (err instanceof Error ? err.message : String(err)).split('\n').map(cleanText).join('\n');
    (ctx?.err ?? ((l: string) => process.stderr.write(`${l}\n`)))(message);
    return err instanceof CliError ? err.code : EXIT.USAGE;
  }
}

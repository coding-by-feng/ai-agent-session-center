// launch.ts — how a central's launch line points its CLI at AASC's own /mcp endpoint.
//
// A central is an ordinary agent terminal (types.ts) launched with two extra things:
//   - flags that add one MCP server, `aasc`, to that launch: Claude's `--mcp-config '<json>'`, or
//     Codex's `-c 'mcp_servers.aasc.…'` overrides;
//   - the central's bearer token, in the PTY's environment as AASC_MCP_TOKEN.
// The token is never in a flag. Claude is given the text `${AASC_MCP_TOKEN}` in its Authorization header
// and expands it itself, which the shell must not do first, so the JSON is single-quoted; Codex is
// given the variable's NAME (`bearer_token_env_var`) and reads it. A command line, `ps` and a stored
// startup command therefore never hold a token.
//
// Like the status-line tap (config.ts), the flags exist only in the line typed into the PTY and are
// never stored. A stored command can still carry them, though: the hook records the live CLI's `ps`
// args, where the quotes are gone. So `stripCentralLaunch` also runs where a stored command comes in
// (sessionStore's capture, apiRouter's startupCommand) and on the line the resume route builds, and
// it finds the flags as text, not as shell words, because a session title ahead of the flag can hold
// shell syntax that hides it from the word reading. `applyCentralLaunch` swaps whatever of its own flags
// a line already has for fresh ones, so a relaunch is neither doubled nor left naming an old port.
// sshManager's two launch paths strip every launch that is not a wired central, so a clone of a
// central, or a central restored with MCP switched off, never types a flag that names a token it does
// not have. Only a bare `claude` or `codex` command word counts, the same rule as `applyStatusLineTap`
// and `applyCodexNoDaemon`.

import { simpleCommands, type ShellWord } from '../config.js';
import log from '../logger.js';
import { centrals } from './centrals.js';
import { getMcpPort, isMcpEnabled, isTcpPort } from './runtime.js';
import type { SessionCentralMarker } from './types.js';

/** The environment variable that carries a central's token into its PTY. */
export const MCP_TOKEN_ENV = 'AASC_MCP_TOKEN';

/** What the server is called in the CLI: Claude shows its tools as `mcp__aasc__…`. */
const MCP_SERVER_NAME = 'aasc';

/** What every Codex override of ours starts with: the server's keys in Codex's config. */
const CODEX_KEY_PREFIX = `mcp_servers.${MCP_SERVER_NAME}.`;

// ---------------------------------------------------------------------------
// The flags
// ---------------------------------------------------------------------------

/** The URL of /mcp on the loopback port. `port` is unchecked here: `mcpUrl` checks, the pattern builder passes a mark. */
const urlFor = (port: number | string): string => `http://127.0.0.1:${port}/mcp`;

function mcpUrl(port: number): string {
  if (!isTcpPort(port)) throw new RangeError(`Not a TCP port: ${String(port)}`);
  return urlFor(port);
}

/** `text` as one shell word that expands nothing: single quotes, closing and reopening around any inside. */
function singleQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function claudeConfigJson(url: string): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url,
        headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` },
      },
    },
  });
}

/**
 * The JSON Claude's `--mcp-config` takes: the `aasc` server over HTTP on the loopback port, with the
 * token left as the literal `${AASC_MCP_TOKEN}`, which Claude expands from its own environment. It
 * has no single quote in it, so it can be single-quoted whole (`applyCentralLaunch` does).
 */
export function claudeMcpConfigJson(port: number): string {
  return claudeConfigJson(mcpUrl(port));
}

/** Codex's settings for the server, as `[key, TOML value]` pairs, for the URL given. */
function codexSettings(url: string): ReadonlyArray<readonly [key: string, tomlValue: string]> {
  return [
    ['url', JSON.stringify(url)],
    ['bearer_token_env_var', JSON.stringify(MCP_TOKEN_ENV)],
    ['tool_timeout_sec', '120'],
    ['startup_timeout_sec', '20'],
    // P5-41: AASC's own card is where the person approves. Codex's default ("auto") asks again for any tool marked
    // destructive or open-world, and under `approval_policy = "never"` refuses it before AASC sees the call.
    // P6-38: it covers every AASC tool, so with the cloud toolset turned on its writes with no card (a project pull or
    // copy, an alias reconcile, an install restore) run with no Codex prompt either, as they do for a Claude central.
    ['default_tools_approval_mode', JSON.stringify('approve')],
  ];
}

/**
 * Codex's `-c` overrides for the same server: its URL, the NAME of the variable that holds the token,
 * two timeouts (a tool may wait on another session, and the server may still be waking up), and Codex's approval mode
 * for its tools (AASC asks the person itself, P5-41).
 * Each element is a whole `-c '<key>=<TOML value>'` fragment, ready to join with spaces.
 */
export function codexMcpFlags(port: number): string[] {
  return codexSettings(mcpUrl(port)).map(
    ([key, value]) => `-c ${singleQuote(`mcp_servers.${MCP_SERVER_NAME}.${key}=${value}`)}`,
  );
}

// ---------------------------------------------------------------------------
// Our exact flags, found as text
// ---------------------------------------------------------------------------
//
// Reading a line as shell words (below) is how flags are put on it and how a person's own are told
// from ours. It is the wrong way to find ours in a stored command. `ps` prints a session's title
// ahead of the flag with its quotes gone, and the title is untrusted text: `Central (main)`, `R&D` and
// `a;b` hold separators, `Kason's boss` and `5" pipe` a quote that never closes, and any of them stops
// the flag being a word of the `claude` command (or swallows it into another word). A flag the
// words cannot see is a flag that stays in the stored command, and replayed into a live shell that
// holds the token it expands the token into argv. So the flags this module generates are first found
// as text, whatever the rest of the line makes of them.

/** Stands in for the port while a pattern is built from the generators; no flag text can hold it. */
const PORT_MARK = '@port@';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text`, written with PORT_MARK where the port goes, as a regex source: the port is any run of digits. */
const patternOf = (text: string): string => text.split(PORT_MARK).map(escapeRegExp).join('\\d+');

/**
 * What a flag's value looks like on a line, as a regex source: as typed (single-quoted), as `ps`
 * prints it (the shell has eaten the single quotes, the value's own double quotes stay), and as `ps`
 * prints it with those gone too.
 */
const valueForms = (text: string): string =>
  [`'${patternOf(text)}'`, patternOf(text), patternOf(text.replaceAll('"', ''))].join('|');

/**
 * One generated flag anywhere in a line: after the start or blanks, then the flag, `=` or blanks,
 * then exactly the generated value for any port, and then the end of the line or something that
 * ends a word. Everything else, a person's own `--mcp-config ./mine.json` or `-c model=…` or a
 * config for another server, is not it. Global, so one pass removes every occurrence.
 */
const flagPattern = (flag: string, values: readonly string[]): RegExp =>
  new RegExp(
    `(?:^|[ \\t]+)${flag}(?:[ \\t]+|=)(?:${values.map(valueForms).join('|')})(?=$|[\\s;&|)])`,
    'g',
  );

const CLAUDE_FLAG_RE = flagPattern('--mcp-config', [claudeConfigJson(urlFor(PORT_MARK))]);
const CODEX_FLAG_RE = flagPattern(
  '(?:-c|--config)',
  codexSettings(urlFor(PORT_MARK)).map(
    ([key, value]) => `mcp_servers.${MCP_SERVER_NAME}.${key}=${value}`,
  ),
);

/**
 * Remove every flag of ours that can be found as text, with the blanks in front of it: Claude's
 * config in each form it can take, and the five Codex overrides, on any command word, a bare
 * `codex` or the path `ps` prints for Codex's native binary.
 */
function removeExactFlags(line: string): string {
  return line.replace(CLAUDE_FLAG_RE, '').replace(CODEX_FLAG_RE, '');
}

// ---------------------------------------------------------------------------
// Putting them on a line, and taking them off
// ---------------------------------------------------------------------------

type Cli = 'claude' | 'codex';

interface Edit {
  start: number;
  end: number;
  text: string;
}

const wordText = (line: string, word: ShellWord): string => line.slice(word.start, word.end);

/** The range that removes a word together with the blanks in front of it. */
function removal(line: string, word: ShellWord): Edit {
  let start = word.start;
  while (start > 0 && (line[start - 1] === ' ' || line[start - 1] === '\t')) start--;
  return { start, end: word.end, text: '' };
}

/** Apply edits that do not overlap, in one pass left to right; at one offset an insertion goes first. */
function applyEdits(line: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let copied = 0;
  for (const edit of ordered) {
    out += line.slice(copied, edit.start) + edit.text;
    copied = edit.end;
  }
  return out + line.slice(copied);
}

/** A Codex `-c` value that sets one of this server's keys: as typed (quoted) or as `ps` shows it (bare). */
const CODEX_OWN_SETTING = new RegExp(`^['"]?mcp_servers\\.${MCP_SERVER_NAME}\\.`);

/**
 * The words of one command, after the command word, that are flags this module adds. A flag and its
 * value are two words, and both are returned. What marks a flag as ours is what only ours says: the
 * token variable in a Claude config, a `mcp_servers.aasc.` key in a Codex override. A person's own
 * `--mcp-config ./mine.json` or `-c model=…` is not ours.
 */
function ownFlagWords(line: string, cli: Cli, args: readonly ShellWord[]): ShellWord[] {
  const own: ShellWord[] = [];
  for (let i = 0; i < args.length; i++) {
    const text = wordText(line, args[i]);
    const next = i + 1 < args.length ? args[i + 1] : null;
    const value = next === null ? '' : wordText(line, next);
    if (cli === 'claude') {
      if (text === '--mcp-config' && next !== null && value.includes(MCP_TOKEN_ENV)) {
        own.push(args[i], next);
        i++;
      } else if (text.startsWith('--mcp-config=') && text.includes(MCP_TOKEN_ENV)) {
        own.push(args[i]);
      }
    } else if (
      (text === '-c' || text === '--config') &&
      next !== null &&
      CODEX_OWN_SETTING.test(value)
    ) {
      own.push(args[i], next);
      i++;
    }
  }
  return own;
}

/**
 * Where Claude's flag goes: after the last word of the command, before the `||` / `&&` / `;` / carriage
 * return that ends it, and before a bare `--`, after which every word is a positional. `--mcp-config`
 * takes any number of values (`claude --help`: `<configs...>`), so anything after it that is not itself
 * a flag, an initial prompt, would be read as one more config; with nothing after it, nothing can be.
 */
function endOfOptions(line: string, first: ShellWord, args: readonly ShellWord[]): number {
  const dashDash = args.findIndex((word) => wordText(line, word) === '--');
  const last = dashDash === -1 ? args.length - 1 : dashDash - 1;
  return last >= 0 ? args[last].end : first.end;
}

/**
 * Walk the line's simple commands and, for each bare `claude` / `codex`, remove the flags of ours it
 * carries, then (with `flags`) insert fresh ones: Claude's at the end of its options (`endOfOptions`),
 * Codex's right after the command word (each `-c` takes exactly one value, so nothing can be taken).
 * Everything else, including the typed carriage return, is kept as it was.
 */
function rewrite(line: string, flags: Readonly<Record<Cli, string>> | null): string {
  const edits: Edit[] = [];
  for (const [first, ...args] of simpleCommands(line)) {
    if (!first) continue;
    const word = wordText(line, first);
    if (word !== 'claude' && word !== 'codex') continue;
    for (const own of ownFlagWords(line, word, args)) edits.push(removal(line, own));
    if (flags !== null) {
      const at = word === 'claude' ? endOfOptions(line, first, args) : first.end;
      edits.push({ start: at, end: at, text: flags[word] });
    }
  }
  return edits.length > 0 ? applyEdits(line, edits) : line;
}

/**
 * Point every `claude` / `codex` command on a launch line at /mcp: `claude --model opus` →
 * `claude --model opus --mcp-config '<json>'`, `codex --yolo` → `codex -c '…' … --yolo`.
 *
 * Works on a whole line, not just a command (a resume is typed as `claude … --resume 'id' || claude …`,
 * after a `cd … &&` on remote hosts, and ends in the carriage return that submits it) and decides per
 * command, so both halves of a fallback get the flags. A command word that is not a bare `claude` or
 * `codex` (a path, `echo claude`, a quoted one) is left alone, and so is a line with none. Idempotent:
 * flags of ours already on the line are replaced, not added to. Claude's flag goes at the END of the
 * command, so a prompt word after `claude` is never taken for a config (`endOfOptions`).
 *
 * Call it only for the string about to be typed into the LOCAL terminal of a central that has a token
 * in its environment (`centralWiringFor`), and never store the result. Throws `RangeError` for a
 * `port` that is not a TCP port.
 */
export function applyCentralLaunch(line: string, opts: { port: number }): string {
  return rewrite(removeExactFlags(line), {
    claude: ` --mcp-config ${singleQuote(claudeMcpConfigJson(opts.port))}`,
    codex: ` ${codexMcpFlags(opts.port).join(' ')}`,
  });
}

/**
 * Remove the flags `applyCentralLaunch` adds, in the form it types them and the form `ps` shows (the
 * shell has eaten the quotes, the title ahead of the flag has lost its own), whatever port they name.
 * A command must not carry them into a shell that was not given a token for them: the bare JSON is
 * mangled there, and `${AASC_MCP_TOKEN}` in it would be expanded onto the command line if the terminal
 * did have a token.
 *
 * Two passes. First the exact flags we generate are found as text (`removeExactFlags`), which does not
 * depend on how the words before them read, so a session title with shell syntax in it cannot hide
 * one. Then the word reading, which also takes a flag in some other quoting, as long as it names the
 * token variable or a `mcp_servers.aasc.` key. A command that has none of ours comes back exactly as it
 * was, a person's own `--mcp-config` included. Idempotent.
 */
export function stripCentralLaunch(line: string): string {
  // Every flag either pass removes names the token variable or an `aasc` key, so a line that names
  // neither has none of ours: it goes back as it came. Checked first because the text pass's pattern
  // costs time quadratic in a run of blanks, and a stored command (the hook's capture) can be long.
  if (!line.includes(MCP_TOKEN_ENV) && !line.includes(CODEX_KEY_PREFIX)) return line;
  return rewrite(removeExactFlags(line), null);
}

// ---------------------------------------------------------------------------
// Which launches carry them
// ---------------------------------------------------------------------------

/** What a launch needs to carry its central: the port to name in the flags, the token for the environment. */
export interface CentralWiring {
  port: number;
  token: string;
}

/**
 * Where the agent will run, as far as a central's token is concerned. Only `local` gets one: a remote
 * host is not this Mac, and inside tmux the token would outlive the central: a tmux server keeps the
 * environment it was started with for every session it creates later.
 */
export type LaunchPlace = 'local' | 'remote' | 'tmux';

/**
 * What the launch is for. A line typed into an existing terminal (`writeWhenReady`) is wired only if the
 * central is attached to that very terminal, because that PTY's environment is where the token is. A
 * terminal about to be spawned is wired only if the central is not attached to a terminal that is still
 * alive (`isTerminalLive`), because the token goes into its environment and one PTY is enough: a second
 * live copy is a second place for it to leak from.
 */
export type WiringTarget =
  | { terminalId: string }
  | { isTerminalLive: (terminalId: string) => boolean };

let warnedNoPort = false;

/**
 * Does this launch carry a central's wiring, and with what? Null when it does not: the terminal is not
 * a central's (`marker` is null or undefined: a config that went through JSON says `null`), MCP is
 * switched off (silently), the agent runs on a remote host or in tmux, the registry no longer holds the
 * central, the target rule above fails, or the server has not said which port it listens on. All of
 * those launch anyway, as an ordinary agent without the `aasc` server, and say why in the log (the port
 * once only).
 */
export function centralWiringFor(
  marker: SessionCentralMarker | null | undefined,
  place: LaunchPlace,
  target: WiringTarget,
): CentralWiring | null {
  if (marker == null || !isMcpEnabled()) return null;
  const id = marker.centralId;
  if (place === 'remote') {
    log.warn(
      'mcp',
      `Central ${id} is launching on a remote host: no MCP flags and no token (centrals run on this Mac only)`,
    );
    return null;
  }
  if (place === 'tmux') {
    log.warn(
      'mcp',
      `Central ${id} is launching in tmux: no MCP flags and no token (a tmux server keeps its environment for every later session)`,
    );
    return null;
  }
  const record = centrals.byId(id);
  if (record === null) {
    log.warn('mcp', `Central ${id} is not in the registry: launching without MCP flags or a token`);
    return null;
  }
  if ('terminalId' in target) {
    if (record.terminalId !== target.terminalId) {
      log.warn(
        'mcp',
        `Central ${id} is not attached to terminal ${target.terminalId}: its line is typed without MCP flags`,
      );
      return null;
    }
  } else if (record.terminalId !== null && target.isTerminalLive(record.terminalId)) {
    log.warn(
      'mcp',
      `Central ${id} already runs in terminal ${record.terminalId}: a second terminal launches without MCP flags or a token`,
    );
    return null;
  }
  const port = getMcpPort();
  if (port === null) {
    if (!warnedNoPort) {
      warnedNoPort = true;
      log.warn(
        'mcp',
        'The /mcp port is not known yet: centrals launch without MCP flags or a token',
      );
    }
    return null;
  }
  return { port, token: record.token };
}

/** @internal — test only: let the once-only warnings be heard again. */
export function __resetLaunchWarningsForTest(): void {
  warnedNoPort = false;
}

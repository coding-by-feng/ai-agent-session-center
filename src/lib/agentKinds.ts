/**
 * @module agentKinds
 * The agent CLIs AASC can host in a terminal and follow through hooks (Nov 23 2026), in one list.
 * Pure and import-free, so the server, the hook installer's callers and the browser share it.
 *
 * - claude       Claude Code: settings.json hooks (dashboard-hook.sh)
 * - codex        Codex: config.toml hooks (dashboard-hook-codex.sh)
 * - opencode     OpenCode 2.x: an AASC server plugin (hooks/opencode-plugin/server.js). OpenCode runs its
 *                agent on a shared background server unless the TUI is started with `--standalone`, and that
 *                server's plugin has no terminal: it has the pid, tty and AGENT_MANAGER_TERMINAL_ID of
 *                whichever terminal first started it. So a dashboard launch always adds `--standalone`
 *                (withOpencodeStandalone), which puts the plugin in an `opencode serve --stdio` child of the
 *                TUI on this PTY. Verified against OpenCode 2.3.2 in a tmux probe.
 * - antigravity  Google Antigravity CLI (`agy`): ~/.gemini/config/hooks.json (dashboard-hook-agy.sh).
 *
 * `AgentCli` (types/cliVersions.ts) stays 'claude' | 'codex': it names the agents whose version, sign-in,
 * plan usage and command lists AASC also manages. Everything here is about launching and following one.
 */

export type AgentKind = 'claude' | 'codex' | 'opencode' | 'antigravity';

export interface AgentKindInfo {
  readonly id: AgentKind;
  /** What a person calls it. */
  readonly label: string;
  /** The executable a launch line starts with. */
  readonly command: string;
  /** The `cli_source` its hooks send (Claude's hook script sends none). */
  readonly hookSource: string;
}

export const AGENT_KINDS: readonly AgentKindInfo[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude', hookSource: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex', hookSource: 'codex' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', hookSource: 'opencode' },
  { id: 'antigravity', label: 'Antigravity', command: 'agy', hookSource: 'antigravity' },
];

/** The agents added after Claude and Codex: launched and followed, without version/plan/command support. */
export const EXTRA_AGENT_KINDS: readonly AgentKind[] = ['opencode', 'antigravity'];

const BY_ID: ReadonlyMap<string, AgentKindInfo> = new Map(AGENT_KINDS.map((a) => [a.id, a]));

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && BY_ID.has(value);
}

export function agentKindInfo(kind: AgentKind): AgentKindInfo {
  return BY_ID.get(kind) as AgentKindInfo;
}

/** The label for a kind, or for a `cli_source` string; null when it names no known agent. */
export function agentLabel(kind: string | null | undefined): string | null {
  const info = kind ? BY_ID.get(kind.toLowerCase()) : undefined;
  return info ? info.label : null;
}

/** First word of a launch line, without a directory (`/opt/homebrew/bin/agy` → `agy`); '' for none. */
function firstCommandWord(command: string | null | undefined): string {
  const first = (command || '').trim().split(/\s+/)[0] || '';
  return first.slice(first.lastIndexOf('/') + 1).toLowerCase();
}

/** The agent a launch line starts; undefined for anything else (a shell, empty). */
export function agentKindOfCommand(command: string | null | undefined): AgentKind | undefined {
  const word = firstCommandWord(command);
  if (!word) return undefined;
  return AGENT_KINDS.find((a) => a.command === word)?.id;
}

/** The agent whose name appears anywhere in a launch line (`ssh box claude`, `npx … opencode`). */
export function agentKindInCommand(command: string | null | undefined): AgentKind | undefined {
  const text = (command || '').toLowerCase();
  if (!text) return undefined;
  return AGENT_KINDS.find((a) => new RegExp(`(^|\\s|/)${a.command}(\\s|$)`).test(text))?.id;
}

/** OpenCode subcommands that do not start the TUI: their lines are left alone. */
const OPENCODE_NON_TUI = new Set([
  'upgrade', 'update', 'uninstall', 'acp', 'api', 'debug', 'auth', 'mcp', 'plugin', 'models', 'stats',
  'run', 'session', 'service', 'serve', 'mini',
]);

export const OPENCODE_STANDALONE_FLAG = '--standalone';

/**
 * A local `opencode` TUI line with `--standalone` added right after the executable, so its agent runs in a
 * private server child of this PTY (see the module note). A line that already picks a server (`--standalone`,
 * `--server`), runs a subcommand, or is not OpenCode is returned as it was. Commands chained after the first
 * (`opencode && …`) are left alone: only the line's first command is OpenCode's.
 */
export function withOpencodeStandalone(line: string): string {
  const match = /^(\s*)(\S+)(.*)$/s.exec(line);
  if (!match) return line;
  const [, lead, exe, rest] = match;
  if (firstCommandWord(exe) !== 'opencode') return line;
  const words = rest.trim().split(/\s+/).filter(Boolean);
  if (words.some((w) => w === OPENCODE_STANDALONE_FLAG || w === '--server' || w.startsWith('--server='))) return line;
  const firstArg = words.find((w) => !w.startsWith('-'));
  if (firstArg && OPENCODE_NON_TUI.has(firstArg) && words.indexOf(firstArg) === 0) return line;
  return `${lead}${exe} ${OPENCODE_STANDALONE_FLAG}${rest}`;
}

/** Session ids each agent accepts back on its command line. Anything else is never typed into a shell. */
const RESUME_ID_RE: Readonly<Record<'opencode' | 'antigravity', RegExp>> = {
  opencode: /^ses_[A-Za-z0-9]{8,64}$/,
  antigravity: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};

/**
 * The line that reopens an OpenCode or Antigravity session in its own TUI: `opencode -s <id>` /
 * `agy --conversation <id>`, after `base` (the stored launch line, kept for its flags). Null when the id is
 * not one the agent issues, so a hostile or mangled id never reaches a shell.
 */
export function extraAgentResumeLine(kind: 'opencode' | 'antigravity', sessionId: string, base?: string | null): string | null {
  if (!RESUME_ID_RE[kind].test(sessionId)) return null;
  const info = agentKindInfo(kind);
  const baseLine = base && agentKindOfCommand(base) === kind ? stripResumeArgs(kind, base) : info.command;
  return kind === 'opencode' ? `${baseLine} -s ${sessionId}` : `${baseLine} --conversation ${sessionId}`;
}

/** The stored launch line of an OpenCode / Antigravity session without its resume arguments (a fresh start). */
export function extraAgentFreshLine(kind: 'opencode' | 'antigravity', base?: string | null): string {
  return base && agentKindOfCommand(base) === kind ? stripResumeArgs(kind, base) : agentKindInfo(kind).command;
}

/** A launch line without its own resume arguments (`-s <id>`, `-c`, `--conversation <id>`, `--prompt <text>`). */
function stripResumeArgs(kind: 'opencode' | 'antigravity', line: string): string {
  const words = line.trim().split(/\s+/);
  const valueFlags = kind === 'opencode' ? new Set(['-s', '--session']) : new Set(['--conversation']);
  // A stored line is the live process's `ps` args, quotes gone: a prompt's words can't be told from later
  // arguments, so a prompt flag ends the line (seen live: `opencode --standalone --auto --prompt Use the shell…`).
  const promptFlags = kind === 'opencode' ? new Set(['--prompt']) : new Set(['-p', '--prompt', '--print']);
  const dropFlags = new Set(['-c', '--continue']);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (promptFlags.has(w) || [...promptFlags].some((f) => w.startsWith(`${f}=`))) break;
    if (valueFlags.has(w)) { i += 1; continue; }
    if (dropFlags.has(w) || [...valueFlags].some((f) => w.startsWith(`${f}=`))) continue;
    out.push(w);
  }
  return out.join(' ');
}

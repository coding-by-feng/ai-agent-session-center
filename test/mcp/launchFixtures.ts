// test/mcp/launchFixtures.ts — what the launch tests share: the exact flags a central's launch line
// carries for port 3333, as the design spells them, and helpers that build such a line.
import { execFileSync } from 'node:child_process';

export const PORT = 3333;

export const CLAUDE_JSON =
  '{"mcpServers":{"aasc":{"type":"http","url":"http://127.0.0.1:3333/mcp","headers":{"Authorization":"Bearer ${AASC_MCP_TOKEN}"}}}}';
export const CLAUDE_FLAG = ` --mcp-config '${CLAUDE_JSON}'`;

export const CODEX_FLAGS = [
  `-c 'mcp_servers.aasc.url="http://127.0.0.1:3333/mcp"'`,
  `-c 'mcp_servers.aasc.bearer_token_env_var="AASC_MCP_TOKEN"'`,
  `-c 'mcp_servers.aasc.tool_timeout_sec=120'`,
  `-c 'mcp_servers.aasc.startup_timeout_sec=20'`,
  // P5-41: AASC's own card is the person's approval; Codex's "auto" would ask again for a destructive or open-world
  // tool, and under approval_policy "never" refuse it before AASC ever sees the call (seen in the P5 live check).
  `-c 'mcp_servers.aasc.default_tools_approval_mode="approve"'`,
];
export const CODEX_FLAG = ` ${CODEX_FLAGS.join(' ')}`;

/**
 * `claude <rest>` as a central launches it: the config flag goes at the END of the command, after
 * every other word, so `--mcp-config` (a variadic option in Claude's CLI) can never take a word that
 * follows it.
 */
export const claude = (rest = ''): string => `claude${rest}${CLAUDE_FLAG}`;
/** `codex <rest>` as a central launches it: the overrides go right after the binary (one value each). */
export const codex = (rest = ''): string => `codex${CODEX_FLAG}${rest}`;

/**
 * Session titles that hold shell syntax. A title is untrusted text (the default is `<folder> #N`, a folder
 * can be called anything, and `sessionTitle` takes 500 characters). `ps` prints it unquoted, ahead of
 * the central's flag, so these are what anything reading that text meets before it reaches the flag: a
 * separator (`( ) ; & |`), a quote that never closes (`'`, `"`) and a backslash that eats what follows.
 */
export const AWKWARD_TITLES = [
  'My title',
  'Notes #1',
  'Central (main)',
  "Kason's boss",
  'R&D',
  'a;b',
  'a|b',
  '5" pipe',
  'back\\',
  'a (b); c & d | "e" \'f\' g\\',
];

/**
 * What `ps -o args=` shows for a process started by one launch line: the arguments a real shell builds
 * from it, joined by single spaces (`ps` cannot tell where one argument ends). The hook records this as
 * a session's `startupCommand`. The shell is asked to print its words with `printf` standing in for the
 * CLI, so nothing but a shell is run.
 */
export function psRendering(line: string): string {
  const argv = execFileSync(
    '/bin/sh',
    ['-c', line.replace(/^(claude|codex)/, "printf '%s\\n' $1")],
    {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    },
  )
    .trimEnd()
    .split('\n');
  return argv.join(' ');
}

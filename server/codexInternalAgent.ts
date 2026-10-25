/**
 * Hooks from Codex's own background agents, which are not user work.
 *
 * With `features.memories` on, Codex runs a "Memory Writing Agent" inside the
 * user's Codex process: same pid, same tty, same AGENT_TERMINAL_ID, but its own
 * session id and cwd `$CODEX_HOME/memories`. Its SessionStart matched the user's
 * terminal as a resume, so the card was re-keyed to the memory agent (and its
 * project path became ~/.codex/memories), the real turn's Stop then belonged to
 * no card, and the card stayed "working": the queue never auto-sent (Oct 19 and
 * Oct 22 2026). Its cwd is fixed by Codex, so that is the marker.
 */
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/** True when this hook comes from one of Codex's internal background agents. */
export function isCodexInternalAgentHook(hookData: { cwd?: string | null }): boolean {
  const cwd = hookData.cwd;
  if (typeof cwd !== 'string' || cwd === '') return false;
  const memories = resolve(codexHome(), 'memories');
  const dir = resolve(cwd);
  return dir === memories || dir.startsWith(memories + sep);
}

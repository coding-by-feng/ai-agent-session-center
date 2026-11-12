/**
 * The terminal toolbar's 🎙 button drives the agent CLI's OWN voice feature (Nov 11 2026):
 *
 * - Claude Code: hold-to-talk dictation (`voice.enabled`, default key Space = `voice:pushToTalk`).
 *   Claude tells a held key from a tap by the key's auto-repeat, so holding the button writes a
 *   Space at key-repeat cadence and stopping the writes is the release.
 * - Codex: `/voice` starts a spoken conversation, `/voice stop` ends it.
 *
 * Both CLIs record from the microphone of the machine they run on, so the button is offered only
 * where that machine is this one: a page served from loopback, a terminal not on a remote SSH host,
 * and never on a phone. macOS also needs the app's `device.audio-input` entitlement.
 */
import type { CliName } from './cliDetect';

/** Space, Claude's default `voice:pushToTalk` binding. */
export const CLAUDE_TALK_KEY = ' ';
/** Close to macOS's default key repeat, so Claude reads the button as a held key. */
export const CLAUDE_TALK_REPEAT_MS = 50;
export const CODEX_VOICE_START = '/voice\r';
export const CODEX_VOICE_STOP = '/voice stop\r';

export type AgentVoiceKind = 'hold' | 'toggle';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(host: string | null | undefined): boolean {
  return LOOPBACK_HOSTS.has((host ?? '').trim().toLowerCase());
}

export interface AgentVoiceContext {
  cli: CliName | null;
  /** `window.location.hostname` of the page showing the terminal. */
  pageHost: string;
  /** The session's SSH host; absent or loopback = a terminal on this machine. */
  sshHost?: string | null;
  isPhone: boolean;
}

/** Which kind of voice button this terminal gets, or null for none. */
export function agentVoiceKind(ctx: AgentVoiceContext): AgentVoiceKind | null {
  if (ctx.isPhone) return null;
  if (!isLoopbackHost(ctx.pageHost)) return null;
  if (ctx.sshHost && !isLoopbackHost(ctx.sshHost)) return null;
  if (ctx.cli === 'claude') return 'hold';
  if (ctx.cli === 'codex') return 'toggle';
  return null;
}

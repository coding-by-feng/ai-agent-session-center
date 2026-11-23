/**
 * CLI detection utility.
 * Determines which AI CLI (Claude, Codex) a session belongs to
 * based on the model name and event types.
 *
 * Shared by SessionRobot (badge rendering) and AlarmEngine (per-CLI sound profiles).
 */
import type { Session } from '@/types';
import { agentKindOfCommand, isAgentKind, type AgentKind } from './agentKinds';

/** Supported CLI identifiers matching SoundSettings.perCli keys */
export type CliName = 'claude' | 'codex';

/**
 * Detect which CLI a session belongs to.
 * 1. Check session.model for CLI-specific keywords
 * 2. Fallback: check event types for CLI-specific events
 * Returns null if the CLI cannot be determined.
 */
export function detectCli(session: Partial<Pick<Session, 'cliSource' | 'startupCommand' | 'sshCommand' | 'sshConfig' | 'model' | 'events'>>): CliName | null {
  const explicit = (session.cliSource || '').toLowerCase();
  if (explicit === 'claude' || explicit === 'codex') {
    return explicit;
  }
  // OpenCode / Antigravity (Nov 23 2026) are neither: null keeps every Claude- or Codex-only action (`/model`,
  // `/effort`, Codex `$skill`, plan usage) away from them. Their mark and label come from detectAgentKind.
  if (explicit && isAgentKind(explicit)) return null;
  if (isExtraAgentCommand(session)) return null;

  const command = [
    session.startupCommand,
    session.sshCommand,
    session.sshConfig?.command,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/(^|\s|\/)claude(\s|$)/.test(command)) return 'claude';
  if (/(^|\s|\/)codex(\s|$)/.test(command)) return 'codex';

  const model = (session.model || '').toLowerCase();

  // Model-based detection (most reliable)
  if (model.includes('claude') || model.includes('opus') || model.includes('sonnet') || model.includes('haiku')) {
    return 'claude';
  }
  if (model.includes('gpt') || model.includes('codex') || model.includes('o1') || model.includes('o3') || model.includes('o4')) {
    return 'codex';
  }

  // Event-type fallback
  const events = session.events || [];

  const hasCodexEvent = events.some(e => e.type === 'agent-turn-complete' || e.type.startsWith('Codex'));
  if (hasCodexEvent) return 'codex';

  const hasClaudeEvent = events.some(e =>
    e.type === 'SessionStart' || e.type === 'PreToolUse' ||
    e.type === 'PostToolUse' || e.type === 'UserPromptSubmit'
  );
  if (hasClaudeEvent) return 'claude';

  return null;
}

type AgentSessionFields = Partial<Pick<Session, 'cliSource' | 'startupCommand' | 'sshCommand' | 'sshConfig' | 'model' | 'events'>>;

function launchCommandOf(session: AgentSessionFields): string {
  return session.startupCommand || session.sshCommand || session.sshConfig?.command || '';
}

function isExtraAgentCommand(session: AgentSessionFields): boolean {
  const kind = agentKindOfCommand(launchCommandOf(session));
  return kind === 'opencode' || kind === 'antigravity';
}

/**
 * Which agent a session runs, any of the four (src/lib/agentKinds.ts): for its mark and label. Behaviour that
 * only Claude or Codex has must keep reading `detectCli`.
 */
export function detectAgentKind(session: AgentSessionFields): AgentKind | null {
  const explicit = (session.cliSource || '').toLowerCase();
  if (isAgentKind(explicit)) return explicit;
  return agentKindOfCommand(launchCommandOf(session)) ?? detectCli(session);
}

/**
 * The CLIs a launcher button can start, with their brand marks. One list for
 * the DIRS dropdown and the session strip's project frames, so a CLI added here
 * appears in both. (Not in CliBrandIcons.tsx: a component file that also exports
 * a list loses fast refresh.)
 *
 * `CLI_LAUNCHERS` (Claude, Codex) is every surface's list, the phone's too: a paired phone may start only
 * `claude` / `codex` (server/mobile/phoneProfile.ts). OpenCode and the Antigravity CLI (Nov 23 2026) join the
 * desktop menus only once enabled in Settings → Hooks (`useLaunchers`). `kind` is the session's agent
 * (`src/lib/agentKinds.ts`): it differs from the command for Antigravity (`agy`).
 */
import type { AgentKind } from '@/lib/agentKinds';
import { AntigravityIcon, ClaudeIcon, CodexIcon, OpenCodeIcon } from './CliBrandIcons';

export const CLI_LAUNCHERS = [
  { command: 'claude', kind: 'claude', label: 'Claude', Icon: ClaudeIcon },
  { command: 'codex', kind: 'codex', label: 'Codex', Icon: CodexIcon },
] as const;

export const EXTRA_LAUNCHERS = [
  { command: 'opencode', kind: 'opencode', label: 'OpenCode', Icon: OpenCodeIcon },
  { command: 'agy', kind: 'antigravity', label: 'Antigravity', Icon: AntigravityIcon },
] as const;

export const ALL_LAUNCHERS = [...CLI_LAUNCHERS, ...EXTRA_LAUNCHERS] as const;

export type CliCommand = (typeof CLI_LAUNCHERS)[number]['command'];
export type LauncherCommand = (typeof ALL_LAUNCHERS)[number]['command'];
export type Launcher = (typeof ALL_LAUNCHERS)[number];

/** The mark and label of a session's agent, or undefined for an unknown one. */
export function launcherForKind(kind: AgentKind | null | undefined): Launcher | undefined {
  return kind ? ALL_LAUNCHERS.find((l) => l.kind === kind) : undefined;
}

/** The core launchers plus each extra one whose agent is in `enabledClis`. */
export function launchersFor(enabledClis: readonly string[] | null | undefined): readonly Launcher[] {
  const enabled = new Set(enabledClis ?? []);
  return [...CLI_LAUNCHERS, ...EXTRA_LAUNCHERS.filter((l) => enabled.has(l.kind))];
}

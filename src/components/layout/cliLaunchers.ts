/**
 * The CLIs a launcher button can start, with their brand marks. One list for
 * the DIRS dropdown and the session strip's project frames, so a CLI added here
 * appears in both. (Not in CliBrandIcons.tsx: a component file that also exports
 * a list loses fast refresh.)
 */
import { ClaudeIcon, CodexIcon } from './CliBrandIcons';

export const CLI_LAUNCHERS = [
  { command: 'claude', label: 'Claude', Icon: ClaudeIcon },
  { command: 'codex', label: 'Codex', Icon: CodexIcon },
] as const;

export type CliCommand = (typeof CLI_LAUNCHERS)[number]['command'];

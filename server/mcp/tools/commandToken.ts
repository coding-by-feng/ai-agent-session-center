// tools/commandToken.ts — the words to type to run a command or skill, as the client's own rules write them. A leaf
// module: command_list (prompts.ts) shows them and command_run (commandRun.ts) types them, and neither can import the
// other's file.

import type { CommandEntry } from '../../commandIndex.js';

/** What an entry's token needs: the fields src/lib/commandIndex.ts `entryToken` reads. */
export type TokenEntry = Pick<CommandEntry, 'name' | 'cli' | 'kind' | 'source' | 'pluginName'>;

/** `/` or `$`: Codex addresses its skills with `$` (a queued `/skill` does nothing there); everything else is `/`. */
export const sigilOf = (entry: Pick<CommandEntry, 'cli' | 'kind'>): '/' | '$' =>
  entry.cli === 'codex' && entry.kind === 'skill' ? '$' : '/';

/** The name without its sigil: a plugin's entry is `<plugin>:<name>`, as a person would type it. */
export const displayName = (entry: Pick<CommandEntry, 'name' | 'source' | 'pluginName'>): string =>
  entry.source === 'plugin' && entry.pluginName ? `${entry.pluginName}:${entry.name}` : entry.name;

/**
 * The words to type to run an entry, sigil included: `/name`, a plugin's `/plugin:name`, and `$name` for a Codex
 * skill. A copy of `entryToken` in src/lib/commandIndex.ts, which the server build cannot import;
 * test/mcp/tools.requests.test.ts runs a table of entries through both.
 */
export const invokeToken = (entry: TokenEntry): string => sigilOf(entry) + displayName(entry);

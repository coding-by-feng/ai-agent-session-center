// respawnLine.ts — the Claude command the headless respawn (server/index.ts `respawnSshTerminals`,
// AASC_SERVER_AUTORESPAWN=1) resumes a card with after an AASC restart. The stored command is the live CLI's `ps`
// args, where a title launched as `-n "x mcp add e npx p"` came back as loose words; typed as they are, `-n` takes
// `x` and claude runs `mcp add …`. So, like every other relaunch (mcp/relaunchRule.ts `relaunchLineOf`), the name is
// rebuilt, quoted, from the card's title (Ruling P3-39), after the session flags are taken off and the permission
// flags put back.

import { reconstructPermissionFlags } from './config.js';
import { relaunchLineOf } from './mcp/relaunchRule.js';

/**
 * `originalCmd` (a Claude command, or empty) as the respawn's base: a bare `claude` with no `--resume` / `--continue`,
 * the permission flags of `permissionMode`, and its name rebuilt from `title`.
 */
export function respawnClaudeBase(originalCmd: string, session: { title?: string | null; permissionMode?: string | null }): string {
  const bare = (originalCmd || 'claude')
    .replace(/^(\S*\/)claude/, 'claude')
    .replace(/\s+--(?:resume\s+'[^']*'|resume\s+\S+|continue)\b/g, '')
    .trim();
  return relaunchLineOf(reconstructPermissionFlags(bare, session.permissionMode), session.title);
}

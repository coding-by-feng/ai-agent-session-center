// completion.ts — what `completion/complete` offers for a session id, in a resource's URI and in a prompt's
// argument: the sessions in the central's scope that session_list shows by default (no ended cards, no AI popups),
// newest activity first, each as the reference a tool takes: its 8-character short id, or the whole id where short
// ids collide (define.ts `refOf`, the same words the tools' own answers use).

import log from '../logger.js';
import { contextFor, neverAborted } from './callContext.js';
import type { McpDeps } from './server.js';
import { refOf } from './tools/define.js';
import { ToolError } from './types.js';

/** Newest activity first, ties by id: the order session_list uses. (The SDK keeps the first 100 of a completion.) */
const NEWEST_FIRST = (
  a: { lastActivityAt: number; sessionId: string },
  b: { lastActivityAt: number; sessionId: string },
): number => b.lastActivityAt - a.lastActivityAt || a.sessionId.localeCompare(b.sessionId);

/**
 * The completer for the central `centralId`: given what has been typed, the references of the sessions it may see
 * that start with it. A central that is no longer live (`contextFor` says UNAVAILABLE) completes nothing, quietly:
 * its MCP session is ending. Any other failure also completes nothing, but is said in the log.
 */
export function sessionCompleter(centralId: string, deps: McpDeps): (typed: string) => string[] {
  return (typed) => {
    try {
      const ctx = contextFor(centralId, deps, neverAborted);
      const ref = refOf(ctx);
      const refs = ctx
        .scopedSessions()
        .filter((s) => !s.isFloating && s.status !== 'ended')
        .sort(NEWEST_FIRST)
        .map((s) => ref(s.sessionId));
      return [...new Set(refs)].filter((r) => r.startsWith(typed));
    } catch (err) {
      if (err instanceof ToolError && err.code === 'UNAVAILABLE') return [];
      log.warn(
        'mcp',
        `Completing a session id for central ${centralId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  };
}

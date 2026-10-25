// tools/historyScope.ts — what the history tools share: which rows a central may see (Rulings 32 and 36), and how
// they read a date and a rate limit. (How a page of rows is read for a central that sees only part of them is
// historyRead.ts.)
//
// A global central sees all of it. For a row of a session that has ENDED (or that the store no longer holds), the rule
// is the folder rule, Ruling 32: a PROJECT central sees only rows whose folder is its scope folder or inside it
// (`folderInScope`); a ROOM central only rows whose folder is exactly one of the folders of its in-scope sessions, no
// folder below them, because a room's reach into history is its own sessions' work, not a project's; a kind this build
// does not know sees nothing; a row with no folder is shown to a global central only.
//
// A session that is still LIVE (the store has it, and it is not ended) follows session scope instead, Ruling 36: its
// rows are seen exactly when the session is in the central's scope, whatever its folder says. A live session outside
// the scope stays out of history even when it runs in a folder the rule above would allow, the same as note_list and
// queue_get refuse it; a live session in scope is seen even where it has no folder.

import { z } from 'zod';
import { SESSION_STATUS } from '../../constants.js';
import type { InternalResponse } from '../client.js';
import { normalizeFolder } from '../paths.js';
import type { ToolContext } from '../registry.js';
import { ToolError } from '../types.js';
import { folderInScope, unwrap } from './define.js';
import { ISO_DATE } from './shape.js';

/** May this central see a row filed under this folder? A value that is not a folder is never allowed to a scoped central. */
export type FolderCheck = (folder: unknown) => boolean;

/** A folder: text with something in it. */
export const isFolder = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The folder rule (Ruling 32) alone: for a folder, and for a row of a session that has ended. */
export function historyAllows(ctx: ToolContext): FolderCheck {
  const { kind } = ctx.central;
  if (kind === 'global') return () => true;
  if (kind === 'project') return (folder) => isFolder(folder) && folderInScope(ctx, folder);
  const folders = new Set(
    ctx
      .scopedSessions()
      .map((s) => s.projectPath)
      .filter(isFolder)
      .map(normalizeFolder),
  );
  return (folder) => isFolder(folder) && folders.has(normalizeFolder(folder));
}

/** May this central see a row of session `sessionId`, filed under `folder`? */
export type RowCheck = (sessionId: unknown, folder: unknown) => boolean;

/**
 * The rule for one history row (Rulings 32 and 36): a live session's row is seen when the session is in scope; any other
 * row (an ended session, or one only the history knows) when its folder passes the folder rule. `ctx.sessions()` is the
 * store's whole list, in scope or not: that a session is live is a fact about it, not about this central's reach.
 */
export function historyVisible(ctx: ToolContext): RowCheck {
  if (ctx.central.kind === 'global') return () => true;
  const folderRule = historyAllows(ctx);
  const inScope = new Set(ctx.scopedSessions().map((s) => s.sessionId));
  const live = new Set(
    ctx
      .sessions()
      .filter((s) => s.status !== SESSION_STATUS.ENDED)
      .map((s) => s.sessionId),
  );
  return (sessionId, folder) => (typeof sessionId === 'string' && live.has(sessionId) ? inScope.has(sessionId) : folderRule(folder));
}

/** Is this central cut to part of the history? */
export const isScoped = (ctx: ToolContext): boolean => ctx.central.kind !== 'global';

/** The harness's own turns arrive through the prompt hook too: every one starts with `<` once white space is gone. */
export const isHarnessText = (text: string): boolean => /^\s*</.test(text);

// ---------------------------------------------------------------------------
// What the history routes take and give
// ---------------------------------------------------------------------------

/** A date or time as an agent writes one. */
export const DATE_INPUT = z.string().min(1).max(40);

/** An ISO date or time as epoch milliseconds, or a refusal that does not repeat it. */
export function dateMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = ISO_DATE.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new ToolError('INVALID', 'A date is an ISO date or time.', 'Write it like 2026-10-01 or 2026-10-24T12:00:00Z.');
  }
  return ms;
}

/** What a history route answered, without its envelope; the search routes' rate limit says to wait, not that AASC broke. */
export function readHistory<T = unknown>(r: InternalResponse<unknown>): T {
  if (!r.ok && r.status === 429) {
    throw new ToolError('UNAVAILABLE', 'AASC limits how fast the history can be searched.', 'Wait a second, then ask again.');
  }
  return unwrap<T>(r);
}

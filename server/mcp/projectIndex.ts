// projectIndex.ts — what AASC knows about project folders, for the router (router.ts) and the project tools.
//
// `listProjects` is the union, by normalized folder, of three sources:
//   live        the cards AASC holds now (local, and a project's own work: not a floating popup, an external card, an
//               SSH session, a subagent or a central, whose folder and constant activity say nothing about a project)
//   discovered  the Library scan (GET /resources .projects): what Claude and Codex have worked in, minus a folder that
//               is gone and a linked worktree (the checkout it belongs to stands for it). Skipped while the scan runs
//   history     every folder the history DB has a session for (GET /db/projects)
// cut to what the calling central may know: a project central its folder and below, a room central every project (its
// own room's marked in `roomIds`), a global central every project; the home folder and everything above it never.
//
// `profileOf` is what a new session in a folder should start as: the CLI, model, effort and room of the folder's
// newest live card, else of its newest history row (the DB keeps no CLI, effort or room: the CLI is read from the
// model's name), else nothing.
//
// Folders are normalized text (`normalizeFolder`), never resolved against the disk: this module reads no file. The
// launch rule and the existence check belong to whoever opens a session there (launchRule.ts, openWorker.ts).
// Answers from the routes are checked row by row with zod: a row that is not what a route promises is dropped, never
// the whole answer. No source failing fails the index; a source that does not answer simply adds nothing.

import { homedir } from 'node:os';
import { basename } from 'node:path';
import { z } from 'zod';
import type { Session } from '../../src/types/session.js';
import { planCliOf } from '../planUsageCodec.js';
import { bodyOf, rowsOf } from './apiBody.js';
import { expandHomePath } from './launchRule.js';
import { normalizeFolder } from './paths.js';
import type { ToolContext } from './registry.js';
import { isLocalSession, isWithin, toSessionCard } from './scope.js';
import type { CliKind } from './types.js';

export type ProjectSource = 'live' | 'discovered' | 'history';

/** The order a project's sources are listed in. */
const SOURCE_ORDER: readonly ProjectSource[] = ['live', 'discovered', 'history'];

export interface KnownProject {
  /** The normalized folder. */
  folder: string;
  /** The folder's own name (its last segment). */
  name: string;
  sources: readonly ProjectSource[];
  /** The newest `lastActivityAt` of its live cards; null when no live card is there (the other sources keep no time). */
  lastActiveAt: number | null;
  /** The rooms that list one of its live cards, in the room list's order. */
  roomIds: readonly string[];
}

export interface ProjectProfile {
  folder: string;
  cli: CliKind | null;
  model: string | null;
  effort: string | null;
  roomId: string | null;
  from: 'live' | 'history' | 'none';
}

export interface ProjectIndexDeps {
  /** The home folder: it and everything above it is dropped. Defaults to this user's. */
  home?: string;
}

// ---------------------------------------------------------------------------
// What a route answered
// ---------------------------------------------------------------------------

const catalogSchema = z.object({ state: z.string().optional(), projects: z.array(z.unknown()).optional() });
const resourceProjectSchema = z.object({
  path: z.string().min(1),
  exists: z.boolean().optional(),
  worktreeOf: z.string().nullish(),
});
const historyProjectSchema = z.object({ project_path: z.string().min(1) });
const historyPageSchema = z.object({ sessions: z.array(z.unknown()) });
const historyRowSchema = z.object({ model: z.string().nullish() });

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

/** A card that is a project's own work: it counts toward the folder being a project, and toward its profile. */
export function isProjectCard(s: Session): boolean {
  return !s.isFloating && !s.isExternal && !s.isSubagent && !s.central && isLocalSession(s) && s.projectPath.trim() !== '';
}

interface Draft {
  sources: Set<ProjectSource>;
  lastActiveAt: number | null;
  liveIds: string[];
}

const newest = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/** The folders the central may know about, as a predicate (a project central: its folder and below). */
function scopeTest(ctx: ToolContext): (folder: string) => boolean {
  const { kind, scopeRef } = ctx.central;
  if (kind === 'global' || kind === 'room') return () => true;
  if (kind !== 'project' || scopeRef === null || scopeRef.trim() === '') return () => false;
  const root = normalizeFolder(scopeRef);
  return (folder) => isWithin(folder, root);
}

/** Every project the central may know of, newest live activity first, then by folder. */
export async function listProjects(ctx: ToolContext, deps: ProjectIndexDeps = {}): Promise<KnownProject[]> {
  const home = normalizeFolder(deps.home ?? homedir());
  const inScope = scopeTest(ctx);
  const drafts = new Map<string, Draft>();
  const note = (folder: string, source: ProjectSource, at: number | null, liveId?: string): void => {
    if (folder === home || isWithin(home, folder) || !inScope(folder)) return;
    const draft = drafts.get(folder) ?? { sources: new Set<ProjectSource>(), lastActiveAt: null, liveIds: [] };
    drafts.set(folder, {
      sources: new Set([...draft.sources, source]),
      lastActiveAt: newest(draft.lastActiveAt, at),
      liveIds: liveId === undefined ? draft.liveIds : [...draft.liveIds, liveId],
    });
  };

  const [catalogAnswer, historyAnswer] = await Promise.all([ctx.client.get('/resources'), ctx.client.get('/db/projects')]);

  for (const s of ctx.sessions()) {
    if (isProjectCard(s)) note(normalizeFolder(s.projectPath), 'live', s.lastActivityAt, s.sessionId);
  }

  const catalog = catalogSchema.safeParse(bodyOf(catalogAnswer));
  if (catalog.success && catalog.data.state !== 'scanning') {
    for (const p of rowsOf(catalog.data.projects, resourceProjectSchema)) {
      if (p.exists === false || p.worktreeOf) continue;
      const folder = expandHomePath(p.path, home);
      if (folder !== null) note(normalizeFolder(folder), 'discovered', null);
    }
  }

  for (const p of rowsOf(bodyOf(historyAnswer), historyProjectSchema)) {
    const folder = expandHomePath(p.project_path, home);
    if (folder !== null) note(normalizeFolder(folder), 'history', null);
  }

  const rooms = ctx.rooms();
  return [...drafts.entries()]
    .map(([folder, d]): KnownProject => ({
      folder,
      name: basename(folder),
      sources: SOURCE_ORDER.filter((source) => d.sources.has(source)),
      lastActiveAt: d.lastActiveAt,
      roomIds: rooms.filter((r) => r.sessionIds.some((id) => d.liveIds.includes(id))).map((r) => r.id),
    }))
    .sort((a, b) => {
      if (a.lastActiveAt !== b.lastActiveAt) return (b.lastActiveAt ?? -Infinity) - (a.lastActiveAt ?? -Infinity);
      return a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0;
    });
}

// ---------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------

/** The room most of the cards sit in (cards are newest first, so a tie goes to the room of the newest card). */
function usualRoom(roomIds: ReadonlyArray<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const id of roomIds) if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  let best: string | null = null;
  for (const [id, count] of counts) if (best === null || count > (counts.get(best) ?? 0)) best = id;
  return best;
}

const NO_PROFILE = (folder: string): ProjectProfile => ({ folder, cli: null, model: null, effort: null, roomId: null, from: 'none' });

/** What a new session in `folder` should start as. See the header for where each field comes from. */
export async function profileOf(ctx: ToolContext, folder: string): Promise<ProjectProfile> {
  const target = normalizeFolder(folder);
  const rooms = ctx.rooms();
  const cards = ctx
    .sessions()
    .filter((s) => isProjectCard(s) && normalizeFolder(s.projectPath) === target)
    .map((s) => ({ at: s.lastActivityAt, card: toSessionCard(s, rooms) }))
    .filter((c) => c.card.cli !== null)
    .sort((a, b) => b.at - a.at);
  if (cards.length > 0) {
    const { card } = cards[0];
    return { folder: target, cli: card.cli, model: card.model, effort: card.effort, roomId: usualRoom(cards.map((c) => c.card.roomId)), from: 'live' };
  }

  const answer = await ctx.client.get('/db/sessions', { project: target, sortBy: 'last_activity_at', sortDir: 'desc', pageSize: 1, archived: 'all' });
  const page = historyPageSchema.safeParse(answer.ok ? answer.data : null);
  const row = page.success ? historyRowSchema.safeParse(page.data.sessions[0]) : null;
  if (row === null || !row.success) return NO_PROFILE(target);
  const model = row.data.model?.trim() || null;
  return { folder: target, cli: model === null ? null : planCliOf({ model }), model, effort: null, roomId: null, from: 'history' };
}

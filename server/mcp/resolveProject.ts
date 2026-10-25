// resolveProject.ts — which project a task is about. Router.ts re-exports it; the replay scorer (replay.ts) calls it
// with fixture projects, so it is pure over its inputs: the disk is reached only through the `exists` and `realpath`
// the caller hands in (defaults: the real ones).
//
// The order, best evidence first (the spec's "Project resolution"):
//   hint   a folder or a name the caller gave                            high (several matches: medium)
//   path   an absolute or `~/` path written in the task                  high (several projects: medium)
//   name   a project's name written in the task as whole words           high (several projects: medium)
//   room   the room's projects, for a room central                       medium
//   recent the most recently active folder                               low
// and `none` when there is nothing to go on. A project central never resolves: its project is its folder (high).
//
// What counts as a project here: one a central could open a session in (the launch rule, on the real path, and the
// folder exists), or one with a live session (reusing a person's session in `/tmp/x` is no launch). A history folder
// that is gone, hidden or outside home never makes a name match, so a junk folder called `test` cannot swallow every
// task that says "test". A name is its folder's last segment split on `-_. ` (any non-letter, non-digit), matched as
// whole words in any case, also spelled together (`AgentManager`); names under three letters never match. Words that
// only make up a longer project's name (`site` inside `rangi site`) are covered by it. Paths do not feed the names:
// the folders along `~/code/x/src` are not mentions of projects called `code` or `src`.
//
// "No evidence" is `none`, never a guess: a project with no recorded activity is not "most recent", and a path that
// is a file or does not exist counts only through the known project it sits in.

import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { expandHomePath, launchRefusal } from './launchRule.js';
import { normalizeFolder } from './paths.js';
import type { KnownProject } from './projectIndex.js';
import type { CentralRecord } from './types.js';

export type ProjectConfidence = 'high' | 'medium' | 'low' | 'none';

/** Where a ranked project came from. `own` is a project central's folder. */
export type ProjectBy = 'own' | 'hint' | 'path' | 'name' | 'room' | 'recent';

export interface ProjectHints {
  /** An absolute or `~/` folder the caller named. */
  folder?: string;
  /** A project name the caller gave. */
  name?: string;
}

export interface RankedProject {
  folder: string;
  /** 0-100, never rising down the list. */
  score: number;
  /** In AASC's words: the kind of evidence. Never the task's or the folder's own text. */
  why: string;
  by: ProjectBy;
}

export interface ProjectResolution {
  /** At most ten, best first, each folder once. Empty with `none`. */
  ranked: RankedProject[];
  confidence: ProjectConfidence;
}

/** What `resolveProject` needs from its caller: who is routing, and (for a pure run) a stand-in for the disk. */
export interface ResolveEnv {
  central: Pick<CentralRecord, 'kind' | 'scopeRef'>;
  /** The real home folder (default: this user's). */
  home?: string;
  /** The known project roots, which the launch rule lets sit in a hidden folder. */
  known?: readonly string[];
  /** Is there a folder here? */
  exists?: (folder: string) => boolean;
  /** The real path of a folder (links followed), or null. */
  realpath?: (folder: string) => string | null;
}

/** The disk, as the defaults reach it. */
export const fsExists = (folder: string): boolean => {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
};
export const fsRealpath = (folder: string): string | null => {
  try {
    return realpathSync.native(folder);
  } catch {
    return null;
  }
};

const MAX_RANKED = 10;
/** The task is read up to the ledger's own limit; nothing more is scanned. */
const TASK_SCAN_MAX = 60_000;
const MIN_NAME_CHARS = 3;

const TIERS: Record<ProjectBy, { top: number; floor: number; why: string }> = {
  own: { top: 100, floor: 100, why: 'this central’s own project' },
  hint: { top: 100, floor: 96, why: 'the project you named' },
  path: { top: 95, floor: 90, why: 'a path in the task' },
  name: { top: 85, floor: 60, why: 'its name is in the task' },
  room: { top: 55, floor: 40, why: 'one of this room’s projects' },
  recent: { top: 35, floor: 10, why: 'the most recently active project' },
};

const ranked = (by: ProjectBy, folders: readonly string[]): RankedProject[] =>
  folders.map((folder, i) => ({ folder, by, why: TIERS[by].why, score: Math.max(TIERS[by].floor, TIERS[by].top - i) }));

// ---------------------------------------------------------------------------
// Words and paths
// ---------------------------------------------------------------------------

const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** A path written in a task: absolute or `~/…`, starting where a word could (not inside a URL), up to a space or a closing quote or bracket. */
const PATH_TOKEN = /(?:^|[\s"'`(\[{<=,;])((?:~|\/)[^\s"'`)\]}>,;]*)/g;

function pathTokens(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PATH_TOKEN)) {
    const token = match[1].replace(/[.:!?]+$/, '');
    if (token !== '') found.push(token);
  }
  return found;
}

/** The task with its paths blanked out, so the folders along a path are not read as project names. */
const withoutPaths = (text: string): string =>
  text.replace(PATH_TOKEN, (whole, path: string) => `${whole.slice(0, whole.length - path.length)} `);

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

const byRecency = (a: KnownProject, b: KnownProject): number => {
  if (a.lastActiveAt !== b.lastActiveAt) return (b.lastActiveAt ?? -Infinity) - (a.lastActiveAt ?? -Infinity);
  return a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0;
};

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

// The work here follows the words of the task, never how often a name repeats in it: a pasted log can name one project
// thousands of times, and several projects can share a name (`web`, `app`). Projects that share a name are matched
// once, every mention is judged against the longer names in one pass over the words, and the disk is asked about each
// project at most once. test/mcp/routerResolveWork.test.ts counts the operations.

/** A run of the task's words: `start` up to, not including, `end`. */
export interface Span {
  start: number;
  end: number;
}

/** A project name that is in the task: the usable projects that bear it, how many words it has, and where it appears. */
export interface NameMention {
  projects: readonly KnownProject[];
  /** How many words the name has: a longer name is the more specific mention. */
  rank: number;
  spans: readonly Span[];
}

/** The places a name appears in the task's words: as its words in a row, or written together (`AgentManager`). */
function spansOf(words: readonly string[], positions: ReadonlyMap<string, readonly number[]>, taskWords: readonly string[]): Span[] {
  const spans: Span[] = [];
  // Walk the name's rarest word, not its first: the `my` of `my-app-17` may be all over a task, the `17` is not.
  let rare = 0;
  for (let k = 1; k < words.length; k += 1) {
    if ((positions.get(words[k])?.length ?? 0) < (positions.get(words[rare])?.length ?? 0)) rare = k;
  }
  for (const at of positions.get(words[rare]) ?? []) {
    const start = at - rare;
    if (words.every((word, k) => taskWords[start + k] === word)) spans.push({ start, end: start + words.length });
  }
  if (words.length > 1) {
    for (const at of positions.get(words.join('')) ?? []) spans.push({ start: at, end: at + 1 });
  }
  return spans;
}

/** The names that are in the task and have a project that passes `usable`; a project is asked once, and only if its name matched. */
function mentionedNames(taskWords: readonly string[], projects: readonly KnownProject[], usable: (folder: string) => boolean): NameMention[] {
  const positions = new Map<string, number[]>();
  taskWords.forEach((word, i) => {
    const at = positions.get(word);
    if (at === undefined) positions.set(word, [i]);
    else at.push(i);
  });

  const bearers = new Map<string, { words: string[]; projects: KnownProject[] }>();
  for (const project of projects) {
    const words = tokens(project.name);
    if (words.join('').length < MIN_NAME_CHARS) continue;
    const key = words.join(' ');
    const bearing = bearers.get(key);
    if (bearing === undefined) bearers.set(key, { words, projects: [project] });
    else bearing.projects.push(project);
  }

  const mentioned: NameMention[] = [];
  for (const { words, projects: bearing } of bearers.values()) {
    const spans = spansOf(words, positions, taskWords);
    if (spans.length === 0) continue;
    const usableOnes = bearing.filter((p) => usable(p.folder));
    if (usableOnes.length > 0) mentioned.push({ projects: usableOnes, rank: words.length, spans });
  }
  return mentioned;
}

/**
 * The names with a mention that no longer name's mention holds: `site` inside `rangi site` is `rangi site`'s, but a
 * `site` anywhere else in the task is `site`'s own. Names are judged longest first, each against the longer ones only.
 * `furthest[p]` is the furthest end of a longer name's mention that starts at word `p` or before it, so a mention is
 * held when `furthest` at its start gets to its end: two passes over the mentions, however many there are.
 */
export function openNames(names: readonly NameMention[], wordCount: number): NameMention[] {
  const byRank = new Map<number, NameMention[]>();
  for (const name of names) {
    const same = byRank.get(name.rank);
    if (same === undefined) byRank.set(name.rank, [name]);
    else same.push(name);
  }
  const furthest = new Int32Array(wordCount + 1);
  const open: NameMention[] = [];
  for (const rank of [...byRank.keys()].sort((a, b) => b - a)) {
    const group = byRank.get(rank) ?? [];
    for (const name of group) {
      if (name.spans.some((s) => furthest[s.start] < s.end)) open.push(name);
    }
    // The next, shorter names are judged against this one too.
    for (const name of group) {
      for (const s of name.spans) furthest[s.start] = Math.max(furthest[s.start], s.end);
    }
    for (let p = 1; p < furthest.length; p += 1) furthest[p] = Math.max(furthest[p], furthest[p - 1]);
  }
  return open;
}

/**
 * The projects a mention names, most specific first (the longer name, then the more recently active project): a
 * mention inside a longer project name's is that project's. Only a project that passes `usable` is a mention (and
 * covers one), and it is asked only once its name has matched.
 */
export function namedProjects(taskWords: readonly string[], projects: readonly KnownProject[], usable: (folder: string) => boolean): KnownProject[] {
  return openNames(mentionedNames(taskWords, projects, usable), taskWords.length)
    .flatMap((name) => name.projects.map((project) => ({ project, rank: name.rank })))
    .sort((a, b) => b.rank - a.rank || byRecency(a.project, b.project))
    .map((entry) => entry.project);
}

// ---------------------------------------------------------------------------
// The resolution
// ---------------------------------------------------------------------------

type Group = { by: ProjectBy; folders: string[] };

/** Is this the central's own project? It is the answer, whatever else is said. */
function ownProject(central: ResolveEnv['central']): ProjectResolution {
  if (central.scopeRef === null || central.scopeRef.trim() === '') return { ranked: [], confidence: 'none' };
  return { ranked: ranked('own', [normalizeFolder(central.scopeRef)]), confidence: 'high' };
}

/** Which project `task` is about, best evidence first. See the header. */
export function resolveProject(
  task: string,
  hints: ProjectHints,
  projects: readonly KnownProject[],
  env: ResolveEnv,
): ProjectResolution {
  const { central } = env;
  if (central.kind === 'project') return ownProject(central);

  const home = normalizeFolder(env.home ?? homedir());
  const known = env.known ?? [];
  const exists = env.exists ?? fsExists;
  const realpath = env.realpath ?? fsRealpath;
  const live = new Set(projects.filter((p) => p.sources.includes('live')).map((p) => p.folder));

  const openable = new Map<string, boolean>();
  /**
   * A folder a central could open a session in (judged on its real path), or one with a live session. It reads the
   * disk, so it is asked only of the folders that matter (a name that matched, a room's project, the few most recent),
   * never of every project the index holds.
   */
  const usable = (folder: string): boolean => {
    const cached = openable.get(folder);
    if (cached !== undefined) return cached;
    const ok =
      live.has(folder) ||
      (launchRefusal(folder, known, home) === null &&
        exists(folder) &&
        launchRefusal(realpath(folder) ?? folder, known, home) === null);
    openable.set(folder, ok);
    return ok;
  };

  const scanned = typeof task === 'string' ? task.slice(0, TASK_SCAN_MAX) : '';
  const groups: Group[] = [];

  // hint: the folder is exactly what was named; the name is matched like one in the task.
  const hinted: string[] = [];
  if (typeof hints.folder === 'string' && hints.folder.trim() !== '') {
    const written = expandHomePath(hints.folder, home);
    const folder = written === null ? null : normalizeFolder(written);
    if (folder !== null && usable(folder)) hinted.push(folder);
  }
  if (typeof hints.name === 'string' && hints.name.trim() !== '') {
    hinted.push(...namedProjects(tokens(hints.name.slice(0, TASK_SCAN_MAX)), projects, usable).map((p) => p.folder));
  }
  groups.push({ by: 'hint', folders: unique(hinted) });

  // path: a folder written in the task is the known project it sits in (the deepest one), else itself. A path is
  // looked up by walking up its own folders, not by reading every project.
  const knownFolders = new Set(projects.map((p) => p.folder));
  const holder = (path: string): string | null => {
    let dir = path;
    for (;;) {
      if (knownFolders.has(dir) && usable(dir)) return dir;
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  };
  const written: string[] = [];
  for (const token of pathTokens(scanned)) {
    const absolute = expandHomePath(token, home);
    if (absolute === null) continue;
    const path = normalizeFolder(absolute);
    const inside = holder(path);
    if (inside !== null) written.push(inside);
    else if (usable(path)) written.push(path);
  }
  groups.push({ by: 'path', folders: unique(written) });

  // name: whole words, longest name first.
  groups.push({ by: 'name', folders: namedProjects(tokens(withoutPaths(scanned)), projects, usable).map((p) => p.folder) });

  // room: a room central tries its own room's projects.
  if (central.kind === 'room' && central.scopeRef !== null) {
    const room = central.scopeRef;
    groups.push({
      by: 'room',
      folders: projects.filter((p) => p.roomIds.includes(room) && usable(p.folder)).sort(byRecency).map((p) => p.folder),
    });
  }

  // recent: the most recently active folders, for those that have a time at all: only as many as are listed.
  const recent: string[] = [];
  for (const p of projects.filter((p) => p.lastActiveAt !== null).sort(byRecency)) {
    if (recent.length >= MAX_RANKED) break;
    if (usable(p.folder)) recent.push(p.folder);
  }
  groups.push({ by: 'recent', folders: recent });

  const first = groups.find((g) => g.folders.length > 0);
  if (first === undefined) return { ranked: [], confidence: 'none' };

  // A folder is listed once, at its best evidence.
  const list: RankedProject[] = [];
  for (const entry of groups.flatMap((g) => ranked(g.by, g.folders))) {
    if (!list.some((p) => p.folder === entry.folder)) list.push(entry);
  }
  const confidence: ProjectConfidence =
    first.by === 'room' ? 'medium' : first.by === 'recent' ? 'low' : first.folders.length === 1 ? 'high' : 'medium';
  return { ranked: list.slice(0, MAX_RANKED), confidence };
}

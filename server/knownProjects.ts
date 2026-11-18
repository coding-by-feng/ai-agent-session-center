// knownProjects.ts — the project folders Claude Code has worked in (~/.claude/projects/).
//
// The quick-launch list, and (AASC-28) the folders a paired phone may start a
// session in even when they sit in a hidden folder; since AASC-54 a phone may
// also start in any other folder under home that isn't hidden or private
// (mobile/homeFolders.ts). One function, so the list a phone is shown and the
// list it is checked against can't drift apart.

import { readdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Decode a Claude Code project directory name back to a real filesystem path.
 * Encoding: leading `-` = `/`, `--` = `.`, other `-` = `/` (but ambiguous
 * when folder names contain hyphens like `agent-manager`).
 * We resolve ambiguity by greedily matching against the actual filesystem.
 */
export function decodeProjectDir(encoded: string): string | null {
  if (!encoded.startsWith('-')) return null;

  // Replace `--` with a placeholder for `.` before splitting
  const DOT = '\x00';
  const prepared = encoded.slice(1).replace(/--/g, DOT);
  const parts = prepared.split('-').map((p) => p.replaceAll(DOT, '.'));

  // A name the encoding turned `-` (`_`, a space …): the entry of `dir` that encodes to the candidate.
  const listed = new Map<string, string[]>();
  const entriesOf = (dir: string): string[] => {
    let names = listed.get(dir);
    if (names === undefined) {
      try {
        names = readdirSync(dir);
      } catch {
        names = [];
      }
      listed.set(dir, names);
    }
    return names;
  };
  const encodeName = (name: string): string => name.replace(/[^A-Za-z0-9]/g, '-');

  // Greedily resolve: try longest segment match against filesystem first
  function resolve(current: string, idx: number): string | null {
    if (idx >= parts.length) return current;
    for (let end = parts.length; end > idx; end--) {
      const candidate = parts.slice(idx, end).join('-');
      const exact = join(current, candidate);
      const names = existsSync(exact)
        ? [candidate]
        : entriesOf(current).filter((name) => encodeName(name) === encodeName(candidate));
      for (const name of names) {
        const result = resolve(join(current, name), end);
        if (result !== null) return result;
      }
    }
    return null;
  }

  return resolve('/', 0);
}

/** Every known project folder, in path order; worktrees and `/` left out. Empty when the folder is missing. */
export function listKnownProjects(): string[] {
  try {
    const entries = readdirSync(join(homedir(), '.claude', 'projects'), { withFileTypes: true });
    const paths: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.includes('worktrees')) continue;
      const decoded = decodeProjectDir(entry.name);
      if (decoded && decoded !== '/') paths.push(decoded);
    }
    return paths.sort();
  } catch {
    return [];
  }
}

/** How far back a folder's sessions count toward its rank in New session's recent projects. */
export const PROJECT_ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** One folder's use, from the sessions table: sessions started inside the window, and the newest activity ever. */
export interface ProjectActivity {
  project_path: string;
  recent: number;
  last: number | null;
}

/**
 * The known folders, most used first: sessions in the window, then the newest activity, then path.
 * This orders the RESOURCES Projects list; New session's suggestions use `rankRecentProjects`.
 * A folder no session has used goes last, in path order. Only `paths` are ranked; the activity
 * rows never add a folder (the list a phone is shown must stay the list it is checked against).
 */
export function rankProjects(paths: readonly string[], activity: readonly ProjectActivity[]): string[] {
  const byPath = new Map(activity.map((a) => [a.project_path, a]));
  const recent = (p: string): number => byPath.get(p)?.recent ?? 0;
  const last = (p: string): number => byPath.get(p)?.last ?? -Infinity;
  return [...paths].sort((a, b) => {
    if (recent(a) !== recent(b)) return recent(b) - recent(a);
    if (last(a) !== last(b)) return last(b) - last(a);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** A session's folder inside one of a project's worktrees (`<project>/.claude/worktrees/<name>`). */
const WORKTREE_RE = /[\\/]\.claude[\\/]worktrees[\\/]/;

/** The project a session's folder counts toward: a worktree counts toward the project it belongs to. */
function projectOf(path: string): string {
  const at = path.search(WORKTREE_RE);
  return at > 0 ? path.slice(0, at) : path;
}

/**
 * The sessions in memory, as activity rows. The stored `last_activity_at` can lag a session that is
 * running, so the folder being worked in this minute is ranked by the live time. Each row counts no
 * session (`recent: 0`): the table already counted it.
 */
export function liveProjectActivity(
  sessions: Iterable<{ projectPath?: string | null; lastActivityAt?: number | null }>,
): ProjectActivity[] {
  const rows: ProjectActivity[] = [];
  for (const s of sessions) {
    if (s.projectPath && typeof s.lastActivityAt === 'number' && s.lastActivityAt > 0) {
      rows.push({ project_path: s.projectPath, recent: 0, last: s.lastActivityAt });
    }
  }
  return rows;
}

/**
 * The known folders for New session's recent projects (Nov 18 2026, by request): the folder a session
 * was active in most recently first, then sessions in the window, then path. Ranking by the count alone
 * (`rankProjects`) kept the month's busiest folder on top long after work had moved elsewhere. Several
 * rows for one folder are merged (newest time, counts added), and a session in a project's worktree
 * counts toward the project. As in `rankProjects`, a folder no session has used goes last in path
 * order, and the rows never add a folder.
 */
export function rankRecentProjects(paths: readonly string[], activity: readonly ProjectActivity[]): string[] {
  const byProject = new Map<string, { recent: number; last: number }>();
  for (const row of activity) {
    const key = projectOf(row.project_path);
    const seen = byProject.get(key) ?? { recent: 0, last: -Infinity };
    byProject.set(key, {
      recent: seen.recent + (Number(row.recent) || 0),
      last: Math.max(seen.last, row.last ?? -Infinity),
    });
  }
  const recent = (p: string): number => byProject.get(p)?.recent ?? 0;
  const last = (p: string): number => byProject.get(p)?.last ?? -Infinity;
  return [...paths].sort((a, b) => {
    if (last(a) !== last(b)) return last(b) - last(a);
    if (recent(a) !== recent(b)) return recent(b) - recent(a);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

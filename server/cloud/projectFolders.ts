/**
 * projectFolders — this Mac's project folders for the Projects tab (Oct 29 2026). The catalog's
 * folders (the Library's project list, ≤ 500) are each read for a GitHub origin a few at a time
 * and matched with the saved project of that repository and branch; a folder whose origin is not
 * on GitHub stays in the list with no repository. `rankFolders` orders them like `/known-projects`:
 * sessions started in the last 30 days, then the latest activity, then path.
 */
import { rankProjects, type ProjectActivity } from '../knownProjects.js';
import type { ProjectCandidate, ProjectFolder, ProjectRecord } from '../../src/types/cloudProjects.js';
import type { FolderBlock, GithubOrigin } from './git.js';
import { confinedProjectPath } from './projectPaths.js';

/** At most this many folders are read; at most this many at once. */
const MAX_FOLDERS = 500;
const CONCURRENCY = 6;

export interface ScannedFolder {
  path: string;
  repository: ProjectCandidate['repository'] | null;
  projectId: string | null;
  blocked?: FolderBlock['blocked'];
}

/** Each folder inside home (anything else is skipped), its GitHub origin and its saved project. */
export async function scanFolders(options: {
  paths: readonly string[];
  home: string;
  saved: readonly ProjectRecord[];
  readOrigin: (root: string) => Promise<GithubOrigin | FolderBlock | null>;
}): Promise<ScannedFolder[]> {
  const paths = [...new Set(options.paths)].slice(0, MAX_FOLDERS);
  const found: ScannedFolder[] = [];
  let next = 0;
  async function worker() {
    while (next < paths.length) {
      const path = paths[next++];
      let real: string;
      try {
        real = await confinedProjectPath(path, options.home);
      } catch {
        continue;
      }
      const read = await options.readOrigin(real);
      const origin = read && !('blocked' in read) ? read : null;
      found.push({
        path: real,
        repository: origin ? { provider: 'github', ...origin } : null,
        projectId: origin
          ? (options.saved.find(
              (p) => p.repository.url === origin.url && p.repository.branch === origin.branch,
            )?.id ?? null)
          : null,
        ...(read && 'blocked' in read ? { blocked: read.blocked } : {}),
      });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** The folders whose origin is on GitHub: what saving and auto-linking work from. */
export const githubFolders = (found: readonly ScannedFolder[]): ProjectCandidate[] =>
  found.flatMap((f) =>
    f.repository ? [{ path: f.path, repository: f.repository, projectId: f.projectId }] : [],
  );

const epochMs = (value: unknown): number | null => {
  const n = Number(value);
  return value !== null && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
};

/** Most used first, with how recently agents worked in each folder. */
export function rankFolders(
  found: readonly ScannedFolder[],
  activity: readonly ProjectActivity[],
): ProjectFolder[] {
  const byPath = new Map(activity.map((a) => [a.project_path, a]));
  const byFolder = new Map(found.map((f) => [f.path, f]));
  return rankProjects([...byFolder.keys()], activity).map((path) => {
    const a = byPath.get(path);
    return {
      ...byFolder.get(path)!,
      recent: Math.max(0, Math.trunc(Number(a?.recent ?? 0)) || 0),
      lastActivityAt: epochMs(a?.last ?? null),
    };
  });
}

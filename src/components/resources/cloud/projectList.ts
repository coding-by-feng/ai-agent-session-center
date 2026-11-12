/**
 * projectList — RESOURCES → Projects as one list (Oct 29 2026). This Mac's project folders come
 * first, in the server's /known-projects order (sessions in the last 30 days, then the latest
 * activity, then path), each saved one shown as its project; favourites lead. The saved projects
 * with no checkout here follow: favourites, then by name. A saved project that two folders here
 * could be is listed as those folders, to link one, not as a project to clone. Pure, so the order
 * and the filters are tested without a page.
 */
import type {
  LocalProject,
  ProjectFolder,
  ProjectMeta,
  ProjectMetaChange,
  ProjectRecord,
} from '@/types/cloudProjects';

/** A folder on this Mac that is not a saved project's checkout here. */
export type FolderState =
  /** Its origin is on GitHub and no saved project has that repository and branch: Save. */
  | 'unsaved'
  /** A saved project has its repository and branch but no checkout here: Link. */
  | 'unlinked'
  /** A saved project has its repository and branch, checked out in another folder: Open. */
  | 'copy'
  /** Its origin is not on GitHub: Open. */
  | 'plain';

export type ProjectRow =
  | {
      kind: 'saved';
      key: string;
      project: ProjectRecord;
      /** Its checkout here, or the folder it is about to link to; null when not on this Mac. */
      path: string | null;
      lastActivityAt: number | null;
      meta: ProjectMeta | null;
    }
  | {
      kind: 'folder';
      key: string;
      folder: ProjectFolder;
      state: FolderState;
      /** The saved project of its repository and branch ('unlinked' and 'copy'). */
      project: ProjectRecord | null;
      /** That project's ♥ and tags on an 'unlinked' folder, which stands for it until one is linked. */
      meta: ProjectMeta | null;
    };

interface Use {
  path: string;
  recent: number;
  lastActivityAt: number | null;
}
/** `rankProjects` (server/knownProjects.ts): most sessions, then latest activity, then path. */
const byUse = (a: Use, b: Use) =>
  b.recent - a.recent ||
  (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1) ||
  (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export function buildProjectRows({
  folders,
  projects,
  locals,
  metas,
}: {
  /** This Mac's folders, as the server ranked them. */
  folders: readonly ProjectFolder[];
  /** The saved projects (none deleted). */
  projects: readonly ProjectRecord[];
  locals: Readonly<Record<string, LocalProject>>;
  metas: Readonly<Record<string, ProjectMeta>>;
}): ProjectRow[] {
  const saved = new Map(projects.map((p) => [p.id, p]));
  const repoKey = (r: { url: string; branch: string }) => `${r.url}#${r.branch}`;
  const byRepo = new Map(projects.map((p) => [repoKey(p.repository), p.id]));
  const fav = (id: string) => metas[id]?.favorite === true;
  const savedRow = (p: ProjectRecord, path: string | null, lastActivityAt: number | null) =>
    ({
      kind: 'saved',
      key: p.id,
      project: p,
      path,
      lastActivityAt,
      meta: metas[p.id] ?? null,
    }) as const;
  // Where each saved project is here: its linked checkout, else (while that is still being read)
  // the first folder with its repository and branch, which the server links it to.
  const checkoutAt = new Map<string, string>(),
    homeOf = new Map<string, string>();
  for (const p of projects) {
    // A checkout that is gone ('missing') holds the project no longer: another clone can.
    const local = locals[p.id],
      path = local?.state === 'missing' ? null : local?.path;
    if (path) {
      checkoutAt.set(path, p.id);
      homeOf.set(p.id, path);
    }
  }
  // The folder's linked project, else the saved one with its repository and branch: matched here
  // too, since the server may have scanned before it read the saved list.
  const savedFor = (f: ProjectFolder) =>
    checkoutAt.get(f.path) ??
    (f.repository ? byRepo.get(repoKey(f.repository)) : undefined) ??
    (f.projectId && saved.has(f.projectId) ? f.projectId : null);
  for (const f of folders) {
    const id = savedFor(f);
    if (id && !locals[id] && !homeOf.has(id)) homeOf.set(id, f.path);
  }

  const here: { row: ProjectRow; use: Use; fav: boolean }[] = [];
  // `standIn`: projects whose 'unlinked' folders here stand for them, so they get no Clone row.
  const placed = new Set<string>(),
    standIn = new Set<string>();
  for (const f of folders) {
    const id = savedFor(f);
    const p = id ? saved.get(id)! : null;
    if (p && homeOf.get(p.id) === f.path && !placed.has(p.id)) {
      placed.add(p.id);
      here.push({ row: savedRow(p, f.path, f.lastActivityAt), use: f, fav: fav(p.id) });
    } else {
      const state: FolderState = p
        ? homeOf.has(p.id)
          ? 'copy'
          : 'unlinked'
        : f.repository
          ? 'unsaved'
          : 'plain';
      const stands = state === 'unlinked' ? p : null;
      if (stands) standIn.add(stands.id);
      here.push({
        row: {
          kind: 'folder',
          key: f.path,
          folder: f,
          state,
          project: p,
          meta: stands ? (metas[stands.id] ?? null) : null,
        },
        use: f,
        fav: !!stands && fav(stands.id),
      });
    }
  }
  // A checkout no agent has worked in is not in the catalog, and is still here.
  for (const p of projects) {
    const path = homeOf.get(p.id);
    if (!path || placed.has(p.id)) continue;
    placed.add(p.id);
    here.push({
      row: savedRow(p, path, null),
      use: { path, recent: 0, lastActivityAt: null },
      fav: fav(p.id),
    });
  }
  here.sort((a, b) => Number(b.fav) - Number(a.fav) || byUse(a.use, b.use));
  const away = projects
    .filter((p) => !placed.has(p.id) && !standIn.has(p.id))
    .sort(
      (a, b) =>
        Number(fav(b.id)) - Number(fav(a.id)) ||
        a.name.localeCompare(b.name) ||
        (a.id < b.id ? -1 : 1),
    )
    .map((p) => savedRow(p, null, null));
  return [...here.map((h) => h.row), ...away];
}

export interface ProjectFilter {
  query: string;
  favOnly: boolean;
  /** Rows with any of these tags. */
  tags: readonly string[];
}

function searchable(row: ProjectRow): string[] {
  const repo = row.kind === 'saved' ? row.project.repository : row.folder.repository;
  return [
    ...(row.kind === 'saved'
      ? [row.project.name, row.path ?? '']
      : [row.folder.path, row.project?.name ?? '']),
    ...(row.meta?.tags ?? []),
    ...(repo ? [`${repo.owner}/${repo.name}`, repo.branch] : []),
  ];
}

export function filterProjectRows(rows: readonly ProjectRow[], f: ProjectFilter): ProjectRow[] {
  const q = f.query.trim().toLowerCase().replace(/^#/, '');
  return rows.filter((row) => {
    const meta = row.meta;
    if (f.favOnly && !meta?.favorite) return false;
    if (f.tags.length > 0 && !f.tags.some((t) => meta?.tags.includes(t))) return false;
    return !q || searchable(row).some((s) => s.toLowerCase().includes(q));
  });
}

/**
 * Each tag on the listed projects, most used first (the Library's Filters menu order). A project
 * counts once, whether by its own row or by the folders that stand for it.
 */
export function projectTagChoices(rows: readonly ProjectRow[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>(),
    seen = new Set<string>();
  for (const { meta } of rows) {
    if (!meta || seen.has(meta.projectId)) continue;
    seen.add(meta.projectId);
    for (const tag of meta.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** `~/code/app` for a folder in the home folder. */
export function displayPath(path: string, home: string | null): string {
  if (!home) return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** A folder's own name, as the list shows it: `/Users/me/code/app` → `app`. */
export const folderName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

/**
 * A ♥ or tag change as the row shows it until the cloud answers (the answer then replaces it).
 * `id` names the project when it has no ♥ or tag yet.
 */
export function applyMetaChange(
  meta: ProjectMeta | null,
  change: ProjectMetaChange,
  id = meta?.projectId ?? '',
): ProjectMeta {
  const base = meta ?? { projectId: id, version: 1, favorite: false, tags: [] };
  const tags = new Set(base.tags);
  for (const t of change.addTags ?? []) tags.add(t);
  for (const t of change.removeTags ?? []) tags.delete(t);
  return { ...base, favorite: change.favorite ?? base.favorite, tags: [...tags].sort() };
}

/** The newer of two answers for one project's ♥ and tags (the higher version wins). */
export function newerMeta(a: ProjectMeta | undefined, b: ProjectMeta | undefined) {
  if (!a) return b;
  if (!b) return a;
  return b.version >= a.version ? b : a;
}

/**
 * A reload's ♥ and tags over what the tab has: per project the newer one, so a list read before
 * a change landed does not undo it (code review, Oct 29 2026).
 */
export function mergeMetas(
  had: Readonly<Record<string, ProjectMeta>>,
  loaded: Readonly<Record<string, ProjectMeta>>,
): Record<string, ProjectMeta> {
  const out: Record<string, ProjectMeta> = {};
  for (const id of new Set([...Object.keys(had), ...Object.keys(loaded)])) {
    const m = newerMeta(had[id], loaded[id]);
    if (m) out[id] = m;
  }
  return out;
}

/** What a row shows: the cloud's last answer with the changes still on their way applied. */
export function withPendingMeta(
  confirmed: Readonly<Record<string, ProjectMeta>>,
  pending: Readonly<Record<string, readonly ProjectMetaChange[]>>,
): Record<string, ProjectMeta> {
  const out = { ...confirmed };
  for (const [id, changes] of Object.entries(pending)) {
    let m: ProjectMeta | null = confirmed[id] ?? null;
    for (const c of changes) m = applyMetaChange(m, c, id);
    if (m) out[id] = m;
  }
  return out;
}

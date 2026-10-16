/**
 * folderBrowser — the phone's "Browse folders on the Mac" (AASC-54): reads
 * `GET /api/folders`, which lists the folders (names only, no files, no hidden
 * or private folders) in a folder under the Mac's home folder, and the helpers
 * the browser and the new-folder confirm share.
 *
 * Pure and import-free apart from `fetch`, so the desktop's eager NewSessionModal
 * can use `isKnownFolder` without pulling the phone kit into its chunk.
 */

export interface FolderEntry {
  name: string;
  path: string;
}

export interface FolderListing {
  /** The real folder listed. */
  path: string;
  /** The Mac's real home folder. */
  home: string;
  /** The folder above, or null at the home folder. */
  parent: string | null;
  folders: FolderEntry[];
  truncated: boolean;
}

export type FolderResult = { ok: true; data: FolderListing } | { ok: false; status: number; message: string };

/** The folders in `path` (absolute or `~/…`); no path is the home folder. Never throws but for an abort. */
export async function fetchFolders(path?: string | null, signal?: AbortSignal): Promise<FolderResult> {
  const url = path ? `/api/folders?${new URLSearchParams({ path })}` : '/api/folders';
  let res: Response;
  try {
    res = await fetch(url, { signal, cache: 'no-store' });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    return { ok: false, status: 0, message: 'Couldn’t reach your Mac.' };
  }
  const body = (await res.json().catch(() => null)) as { success?: boolean; data?: FolderListing } | null;
  if (res.ok && body?.success && body.data) return { ok: true, data: body.data };
  return {
    ok: false,
    status: res.status,
    message: res.status === 404
      ? 'This folder can’t be opened from the phone. Only folders in your home folder that aren’t hidden or private can.'
      : 'Couldn’t list this folder.',
  };
}

export interface Crumb {
  label: string;
  path: string;
}

/** Home › Documents › claude: one crumb per folder from the home folder down to `path`. */
export function folderCrumbs(path: string, home: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'Home', path: home }];
  if (path === home || !path.startsWith(`${home}/`)) return crumbs;
  let at = home;
  for (const name of path.slice(home.length + 1).split('/').filter(Boolean)) {
    at = `${at}/${name}`;
    crumbs.push({ label: name, path: at });
  }
  return crumbs;
}

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/**
 * Has an agent worked in `dir` before (a known project, a folder this device
 * used, a live session's project)? When not, the phone asks "Start in a new
 * folder?" before it starts one there. `home` expands a `~/…` path when known.
 */
export function isKnownFolder(dir: string, known: Iterable<string>, home?: string | null): boolean {
  const expand = (p: string): string => {
    const t = trimSlash(p.trim());
    if (!home) return t;
    if (t === '~') return home;
    return t.startsWith('~/') ? `${home}/${t.slice(2)}` : t;
  };
  const target = expand(dir);
  if (!target) return false;
  for (const k of known) if (expand(k) === target) return true;
  return false;
}

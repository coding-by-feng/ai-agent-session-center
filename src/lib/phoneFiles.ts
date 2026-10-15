/**
 * phoneFiles — the phone project browser's reads of `/api/files/*` (AASC-20).
 * Read-only by construction: there is no write, mkdir, delete, reveal or
 * open-external here, because a paired phone may call none of them.
 *
 * Unlike `ApiFileSystemProvider`, every call keeps the HTTP status, so a
 * refused path (a paired phone's plain 404) can be told apart from a server
 * error and explained on the screen. Network failures are status 0.
 */
export type FilesResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

export interface DirItem {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: string;
}

export interface FileData {
  path: string;
  name: string;
  size: number;
  ext?: string;
  content?: string;
  binary?: boolean;
  streamable?: boolean;
}

export interface NameHit {
  path: string;
  name: string;
  type: 'dir' | 'file';
}

export interface TextHit {
  file: string;
  line: number;
  text: string;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<FilesResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    return { ok: false, status: 0, message: 'Network error' };
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) {
    return { ok: false, status: res.status, message: typeof body?.error === 'string' ? body.error : res.statusText };
  }
  return { ok: true, data: body as T };
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export function listDir(root: string, path: string, signal?: AbortSignal): Promise<FilesResult<{ path: string; items: DirItem[] }>> {
  return getJson(`/api/files/list?${q({ root, path })}`, signal);
}

export function readFile(root: string, path: string, signal?: AbortSignal): Promise<FilesResult<FileData>> {
  return getJson(`/api/files/read?${q({ root, path })}`, signal);
}

/** Files and folders whose name matches (the server's fuzzy index). */
export function searchNames(root: string, query: string, signal?: AbortSignal): Promise<FilesResult<{ results: NameHit[]; indexing?: boolean }>> {
  return getJson(`/api/files/search?${q({ root, q: query })}`, signal);
}

/** Lines that contain the text. No glob: a paired phone may not pass one. */
export function searchText(root: string, query: string, signal?: AbortSignal): Promise<FilesResult<{ matches: TextHit[]; truncated: boolean }>> {
  return getJson(`/api/files/grep?${q({ root, q: query })}`, signal);
}

/** Bytes of an image, PDF or media file, for `<img src>` / PDF.js (same-origin, the session cookie rides along). */
export function streamUrl(root: string, path: string): string {
  return `/api/files/stream?${q({ root, path })}`;
}

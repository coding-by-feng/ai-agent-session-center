/**
 * phoneProject — pure helpers for the phone's read-only project browser
 * (AASC-20, features 46–50): paths and breadcrumbs, which viewer a file gets,
 * the slice of a long file a phone renders, pinch-zoom math, and what a refused
 * path says.
 *
 * Paths are project-relative with a leading slash (`/`, `/src/lib/a.ts`), the
 * form `/api/files/*` takes and returns.
 */
import { clampPan, clampZoom, type ImageView } from '@/components/session/imageViewport';

// ── Paths ────────────────────────────────────────────────────────────────────

/** `/a/./b/../c/` → `/a/c`; never climbs above `/`. */
export function normalizeRel(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

export function joinRel(dir: string, name: string): string {
  return normalizeRel(`${dir}/${name}`);
}

export function parentRel(path: string): string {
  return normalizeRel(`${normalizeRel(path)}/..`);
}

export function baseName(path: string): string {
  const parts = normalizeRel(path).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Every folder from the root down to `path`, root first: `/a/b` → `['/', '/a', '/a/b']`. */
export function ancestorsOf(path: string): string[] {
  const parts = normalizeRel(path).split('/').filter(Boolean);
  return ['/', ...parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)];
}

export interface Crumb {
  label: string;
  path: string;
}

/** The trail for a folder: the project's own name first, then each folder. */
export function breadcrumbs(dir: string, projectName: string): Crumb[] {
  return ancestorsOf(dir).map((path) => ({ label: path === '/' ? projectName : baseName(path), path }));
}

/**
 * A file the rest of the app names (a terminal link, an absolute path) as a
 * path inside this project, or null when it lies outside.
 */
export function relInProject(filePath: string, projectPath: string): string | null {
  const path = filePath.trim();
  if (!path || path.startsWith('~')) return null;
  if (!path.startsWith('/')) return normalizeRel(path);
  const root = normalizeRel(projectPath);
  if (path === root) return '/';
  return path.startsWith(`${root}/`) ? normalizeRel(path.slice(root.length)) : null;
}

// ── Viewers ──────────────────────────────────────────────────────────────────

export type PhoneViewerKind = 'markdown' | 'tex' | 'pdf' | 'image' | 'media' | 'text' | 'none';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const MEDIA_EXTS = new Set(['mp4', 'webm', 'ogg', 'mov', 'mp3', 'wav', 'flac', 'aac', 'm4a']);

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export interface FileMeta {
  name: string;
  ext?: string;
  streamable?: boolean;
  binary?: boolean;
  content?: string;
}

/** Which phone viewer a file gets. Office files and other binaries have none on a phone. */
export function viewerKindFor(meta: FileMeta): PhoneViewerKind {
  const ext = (meta.ext ?? extOf(meta.name)).toLowerCase().replace(/^\./, '');
  if (meta.streamable) {
    if (ext === 'pdf') return 'pdf';
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (MEDIA_EXTS.has(ext)) return 'media';
    return 'none';
  }
  if (meta.binary || typeof meta.content !== 'string') return 'none';
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return 'markdown';
  if (ext === 'tex' || ext === 'ltx') return 'tex';
  return 'text';
}

/** Markdown and TeX can be read rendered or as source; the rest have one face. */
export function hasSourceToggle(kind: PhoneViewerKind): boolean {
  return kind === 'markdown' || kind === 'tex';
}

// ── Long files ───────────────────────────────────────────────────────────────

/** Lines a phone renders at once: a 10 MB log would freeze it. */
export const PHONE_LINE_WINDOW = 2000;

/**
 * Which lines to render (0-based `start`, exclusive `end`): everything when it
 * fits, else a window that holds `target` (1-based) a little below its top.
 */
export function lineWindow(total: number, target: number | null, size = PHONE_LINE_WINDOW): { start: number; end: number } {
  if (total <= size) return { start: 0, end: total };
  const want = target && target > 0 ? Math.max(0, target - 1 - Math.floor(size / 10)) : 0;
  const start = Math.min(want, total - size);
  return { start, end: start + size };
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * What the screen says when a read fails. A paired phone is refused with a
 * plain 404 (so a refused path can't be told from a missing one): say both.
 */
export function fileErrorText(status: number, what: 'file' | 'folder'): { title: string; hint: string } {
  if (status === 404) {
    return {
      title: `This ${what} isn't available on this phone`,
      hint: 'A phone reads only inside a shared session\'s project, never private files such as .env or keys — or it may have been moved or deleted.',
    };
  }
  if (status === 413) return { title: `This ${what} is too large to open`, hint: 'Open it on the Mac.' };
  if (status === 429) return { title: 'Too many requests', hint: 'Wait a moment and try again.' };
  if (status === 0) return { title: 'The Mac could not be reached', hint: 'Check the connection and try again.' };
  return { title: `This ${what} could not be opened`, hint: 'Try again, or open it on the Mac.' };
}

export function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Pinch zoom ───────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

/** Zoom 1 is "fit to the screen"; a phone never shows less than that. */
export const PHONE_ZOOM_MIN = 1;

export function clampPhoneZoom(zoom: number): number {
  return Math.max(PHONE_ZOOM_MIN, clampZoom(zoom));
}

/**
 * The view while two fingers pinch. `start` is the view and the fingers'
 * distance and midpoint when the pinch began; points are relative to the
 * stage's top-left. The point that was under the midpoint stays under it, so
 * the picture follows the fingers as it scales.
 */
export function pinchView(
  start: { view: ImageView; distance: number; mid: Point },
  now: { distance: number; mid: Point },
  stage: { width: number; height: number },
): ImageView {
  if (start.distance <= 0 || stage.width <= 0 || stage.height <= 0) return start.view;
  const zoom = clampPhoneZoom(start.view.zoom * (now.distance / start.distance));
  const scale = zoom / start.view.zoom;
  // Midpoints relative to the stage's centre (the transform origin).
  const m0 = { x: start.mid.x - stage.width / 2, y: start.mid.y - stage.height / 2 };
  const m1 = { x: now.mid.x - stage.width / 2, y: now.mid.y - stage.height / 2 };
  const pan = clampPan(
    m1.x - (m0.x - start.view.panX) * scale,
    m1.y - (m0.y - start.view.panY) * scale,
    zoom,
    stage.width,
    stage.height,
  );
  return { zoom, ...pan };
}

/** One finger dragging a zoomed picture. */
export function dragView(view: ImageView, dx: number, dy: number, stage: { width: number; height: number }): ImageView {
  return { zoom: view.zoom, ...clampPan(view.panX + dx, view.panY + dy, view.zoom, stage.width, stage.height) };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

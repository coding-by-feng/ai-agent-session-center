/**
 * @module fileRefResolve
 * A folder or a bare file name in an agent's text becomes a link only once the Mac says the path
 * exists (Nov 18 2026). `fileRefs.ts` finds the candidates; this asks, and remembers the answer.
 *
 *   dir   the path itself (absolute, ~, or relative to the project)   GET /api/files/resolve
 *   bare  1. each folder the same message named, in order             GET /api/files/resolve
 *         2. the project's own folder
 *         3. the project's file list, if exactly one file has the name GET /api/files/search
 *
 * Step 3's route is rate-limited on the Mac (20 a minute, shared with the `@` picker), so it is
 * spent sparingly: SEARCH_BUDGET a minute here, and a name that runs out simply stays text.
 * An answer is remembered for the page's life; a failure to reach the Mac is not.
 */
import { resolvePath, searchNames } from '@/lib/phoneFiles';

export interface ResolvedRef {
  kind: 'file' | 'dir';
  absolute: string;
}

export interface RefContext {
  /** The session's folder: what a relative path and a bare name are read against. */
  projectPath: string;
  /** Folders the same message named (messageFolders), tried first for a bare name. */
  folders?: readonly string[];
}

const MAX_FOLDERS = 3;
const MAX_PARALLEL = 4;
const SEARCH_BUDGET = 8;
const SEARCH_WINDOW_MS = 60_000;

const settled = new Map<string, ResolvedRef | null>();
const pending = new Map<string, Promise<ResolvedRef | null>>();
let running = 0;
const waiting: Array<() => void> = [];
let searchTimes: number[] = [];

/** Thrown inside a lookup when the Mac couldn't be asked: the answer is unknown, not "no". */
class Unreachable extends Error {}

async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((go) => waiting.push(go));
  running += 1;
  try {
    return await job();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

const trimEnd = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

function toAbsolute(path: string, projectPath: string): string {
  const clean = trimEnd(path.replace(/^\.\//, ''));
  if (clean.startsWith('/') || clean.startsWith('~')) return clean;
  return `${trimEnd(projectPath)}/${clean}`;
}

/** What is at `absolute`, or null when nothing is (or the Mac won't show it). */
async function probe(absolute: string): Promise<ResolvedRef | null> {
  let found: Awaited<ReturnType<typeof resolvePath>>;
  try {
    found = await limited(() => resolvePath(absolute));
  } catch {
    throw new Unreachable();
  }
  if (found.ok) {
    const data = found.data as { kind: 'file' | 'dir'; absolute?: string };
    return { kind: data.kind, absolute: data.absolute ?? absolute };
  }
  // 404 no such path, 403 not this device's to read, 400 not a path: all a plain "no".
  if (found.status === 404 || found.status === 403 || found.status === 400) return null;
  throw new Unreachable();
}

function searchAllowed(now: number): boolean {
  searchTimes = searchTimes.filter((t) => now - t < SEARCH_WINDOW_MS);
  if (searchTimes.length >= SEARCH_BUDGET) return false;
  searchTimes.push(now);
  return true;
}

async function uniqueInIndex(name: string, projectPath: string): Promise<ResolvedRef | null> {
  if (!searchAllowed(Date.now())) throw new Unreachable();
  let found: Awaited<ReturnType<typeof searchNames>>;
  try {
    found = await limited(() => searchNames(projectPath, name));
  } catch {
    throw new Unreachable();
  }
  if (!found.ok) {
    if (found.status === 404 || found.status === 403 || found.status === 400) return null;
    throw new Unreachable();
  }
  // Still building its list: the answer isn't known yet.
  if (found.data.indexing) throw new Unreachable();
  const exact = found.data.results.filter((hit) => hit.type === 'file' && hit.name === name);
  if (exact.length !== 1) return null;
  return { kind: 'file', absolute: `${trimEnd(projectPath)}/${exact[0].path.replace(/^\/+/, '')}` };
}

async function lookUp(text: string, kind: 'dir' | 'bare', ctx: RefContext): Promise<ResolvedRef | null> {
  if (kind === 'dir') return probe(toAbsolute(text, ctx.projectPath));
  const folders = [...(ctx.folders ?? []).slice(0, MAX_FOLDERS).map((f) => toAbsolute(f, ctx.projectPath)), trimEnd(ctx.projectPath)];
  for (const folder of [...new Set(folders)]) {
    const here = await probe(`${folder}/${text}`);
    if (here?.kind === 'file') return here;
  }
  return uniqueInIndex(text, ctx.projectPath);
}

const keyOf = (text: string, kind: string, ctx: RefContext) =>
  `${kind}\n${ctx.projectPath}\n${(ctx.folders ?? []).slice(0, MAX_FOLDERS).join('\n')}\n${text}`;

/** The answer already known for this candidate: a ref, null ("not a path"), or undefined (not asked yet). */
export function peekFileRef(text: string, kind: 'dir' | 'bare', ctx: RefContext): ResolvedRef | null | undefined {
  return settled.get(keyOf(text, kind, ctx));
}

/** Ask the Mac what `text` names. Null when it names nothing, or the Mac couldn't be asked. */
export function resolveFileRef(text: string, kind: 'dir' | 'bare', ctx: RefContext): Promise<ResolvedRef | null> {
  if (!ctx.projectPath || !text) return Promise.resolve(null);
  const key = keyOf(text, kind, ctx);
  if (settled.has(key)) return Promise.resolve(settled.get(key) ?? null);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const asked = lookUp(text, kind, ctx).then(
    (ref) => {
      settled.set(key, ref);
      return ref;
    },
    // Unreachable: say "no" this time, ask again next time.
    () => null,
  ).finally(() => pending.delete(key));
  pending.set(key, asked);
  return asked;
}

export function resetFileRefCacheForTest(): void {
  settled.clear();
  pending.clear();
  searchTimes = [];
}

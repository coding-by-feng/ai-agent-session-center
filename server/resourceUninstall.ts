/**
 * resourceUninstall — the RESOURCES tab's only writes: move a resource into the
 * AASC trash, and put it back.
 *
 * Deliberately outside the scanner and the catalog's read paths
 * (agent-resources.md: writes go "behind a separate, reviewed path"). Nothing
 * here decides WHICH resource may go — `uninstallBlocker` and the catalog's
 * scan-time checks do. This module moves what it is handed, records where it
 * came from, and never overwrites anything on the way back.
 *
 * One folder per uninstall:
 *   <trashDir>/<trashId>/entry.json          where it came from, + any MEMORY.md lines
 *   <trashDir>/<trashId>/payload/<basename>   the folder or file itself
 *
 * A memory file is listed in its folder's MEMORY.md index, which every session
 * loads; a pointer to a file that is gone is broken state. So uninstalling a
 * memory file also removes the index lines that link to it (recorded in
 * entry.json), and restore puts them back at their old positions.
 *
 * Two things this module will not do, whatever a caller asks:
 *  - lose the only complete copy: once a cross-volume copy has finished, the
 *    trash entry is kept even when the source cannot be fully removed;
 *  - write through a changed folder: restore requires the parent folder to
 *    resolve exactly where it did at uninstall time, so a folder swapped for a
 *    link in between (a pulled commit, say) is a 409, not a write elsewhere.
 */
import { randomBytes } from 'crypto';
import { constants } from 'fs';
import { copyFile, cp, link, lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { RESOURCE_TYPES, type ResourceType } from '../src/types/resources.js';
import { isWithin } from './fsSafe.js';

const __dir = dirname(fileURLToPath(import.meta.url));

/** Mirrors db.ts / noteMedia.ts: packaged Electron sets APP_USER_DATA, dev falls back to ./data. */
export const DEFAULT_TRASH_DIR = join(
  process.env.APP_USER_DATA ? join(process.env.APP_USER_DATA, 'data') : join(__dir, '..', 'data'),
  'resource-trash',
);

/** `<ms timestamp>-<8 hex>` — validated before it ever touches a path. */
export const TRASH_ID_RE = /^\d{13}-[a-f0-9]{8}$/;

const MEMORY_INDEX = 'MEMORY.md';

/** A refusal with the HTTP status it maps to. */
export class TrashError extends Error {
  readonly status: 403 | 404 | 409;

  constructor(message: string, status: 403 | 404 | 409) {
    super(message);
    this.name = 'TrashError';
    this.status = status;
  }
}

/** A cross-volume move whose copy finished but whose source could not be fully removed. */
export class PartialMoveError extends Error {
  constructor(cause: unknown) {
    super('Copied, but the source could not be fully removed', { cause });
    this.name = 'PartialMoveError';
  }
}

/** Absolute AND already normalized: `/a/b/../c` is refused, not resolved. */
const cleanAbsolute = z.string().max(4096).refine((p) => isAbsolute(p) && normalize(p) === p && !p.includes('\0'));

const entrySchema = z.object({
  version: z.literal(1),
  trashId: z.string().regex(TRASH_ID_RE),
  trashedAt: z.number(),
  type: z.enum(RESOURCE_TYPES),
  name: z.string().max(4096),
  display: z.string().max(4096),
  originalPath: cleanAbsolute,
  rootPath: cleanAbsolute,
  /** realpath of the original's parent folder at uninstall time — restore must find it unchanged. */
  parentReal: cleanAbsolute,
  memoryIndex: z.object({
    path: cleanAbsolute,
    lines: z.array(z.object({ index: z.number().int().min(0), text: z.string().max(10_000) })).max(1000),
  }).optional(),
}).refine((e) => e.originalPath !== e.rootPath && isWithin(e.rootPath, e.originalPath))
  .refine((e) => !e.memoryIndex || isWithin(e.rootPath, e.memoryIndex.path));

type TrashEntry = z.infer<typeof entrySchema>;

export interface TrashRequest {
  /** The folder or file as listed. Never a symlink — the caller refuses those and this checks again. */
  absPath: string;
  /** The root it was found under; restore refuses to write anywhere outside it. */
  rootPath: string;
  type: ResourceType;
  /** Its catalog name; for memory, its path inside the memory folder. */
  name: string;
  /** Home-relative display path. */
  display: string;
}

/** Test seams for the fs calls whose failures matter. */
export interface MoveDeps {
  rename?: typeof rename;
  rm?: typeof rm;
}

const errno = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;

/**
 * `rename`, or — across devices, where rename cannot work — copy then remove.
 * The copy keeps symlinks as links (never follows one out of the resource).
 * A failed removal AFTER the copy finished is a `PartialMoveError`: the
 * destination holds the only complete copy then, and must not be cleaned up.
 */
export async function movePath(src: string, dst: string, deps: MoveDeps = {}): Promise<void> {
  try {
    await (deps.rename ?? rename)(src, dst);
    return;
  } catch (err) {
    if (errno(err) !== 'EXDEV') throw err;
  }
  await cp(src, dst, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  try {
    await (deps.rm ?? rm)(src, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    throw new PartialMoveError(err);
  }
}

/**
 * Puts `src` at `dst` without ever replacing what is there — even something that
 * appeared after the caller checked. A file goes through `link` (fails with
 * EEXIST), or `copyFile` with COPYFILE_EXCL where links cannot be made; a folder
 * goes through `rename`, which never replaces a non-empty folder (an empty one
 * holds nothing to lose).
 */
export async function placeWithoutReplacing(src: string, dst: string, deps: MoveDeps = {}): Promise<void> {
  if ((await lstat(src)).isDirectory()) {
    await movePath(src, dst, deps);
    return;
  }
  try {
    await link(src, dst);
  } catch (err) {
    if (errno(err) === 'EEXIST') throw err;
    // Cross-device, or a filesystem without hard links: an exclusive copy.
    await copyFile(src, dst, constants.COPYFILE_EXCL);
  }
  // It is in place; a trash copy that will not go away is only clutter.
  await unlink(src).catch(() => undefined);
}

/** Write via a temp file in the same folder, then rename over: never a half-written file. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The MEMORY.md beside a memory file (null for MEMORY.md itself, or a name that does not fit its path). */
function memoryIndexPath(req: TrashRequest): string | null {
  if (req.type !== 'memory' || basename(req.absPath) === MEMORY_INDEX) return null;
  const memoryDir = req.absPath.slice(0, req.absPath.length - req.name.length);
  if (normalize(join(memoryDir, req.name)) !== normalize(req.absPath)) return null;
  return join(memoryDir, MEMORY_INDEX);
}

/**
 * Removes the index lines that link to the memory file, matching on a FRESH read
 * right before the write (never on line numbers from an earlier read), and
 * returns exactly the lines it removed.
 */
async function removeIndexLines(req: TrashRequest): Promise<TrashEntry['memoryIndex'] | null> {
  const path = memoryIndexPath(req);
  if (!path) return null;
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  const link = new RegExp(`\\]\\((?:\\./)?${escapeRegExp(req.name)}\\)`);
  const all = text.split('\n');
  const lines = all.flatMap((line, index) => (link.test(line) ? [{ index, text: line }] : []));
  if (lines.length === 0) return null;
  const removed = new Set(lines.map((l) => l.index));
  await writeAtomic(path, all.filter((_, i) => !removed.has(i)).join('\n'));
  return { path, lines };
}

/** Moves the resource into a fresh trash entry. Returns the id that restores it. */
export async function moveToTrash(req: TrashRequest, trashDir: string, now = Date.now(), deps: MoveDeps = {}): Promise<{ trashId: string }> {
  const st = await lstat(req.absPath).catch((err: unknown) => {
    if (errno(err) === 'ENOENT') throw new TrashError('Changed since the last scan — rescan', 409);
    throw err;
  });
  if (st.isSymbolicLink()) throw new TrashError('A link — not removed', 403);
  const parentReal = await realpath(dirname(req.absPath));

  const trashId = `${now}-${randomBytes(4).toString('hex')}`;
  const entryDir = join(trashDir, trashId);
  const entryFile = join(entryDir, 'entry.json');
  await mkdir(join(entryDir, 'payload'), { recursive: true, mode: 0o700 });
  const entry: TrashEntry = {
    version: 1,
    trashId,
    trashedAt: now,
    type: req.type,
    name: req.name,
    display: req.display,
    originalPath: req.absPath,
    rootPath: req.rootPath,
    parentReal,
  };
  // The record goes first, so an interrupted move still says where the payload came from.
  await writeFile(entryFile, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  try {
    await movePath(req.absPath, join(entryDir, 'payload', basename(req.absPath)), deps);
  } catch (err) {
    if (err instanceof PartialMoveError) {
      throw new TrashError(`Copied to the trash, but ${req.display} could not be fully removed — the trash keeps a complete copy`, 409);
    }
    await rm(entryDir, { recursive: true, force: true });
    throw err;
  }
  const memoryIndex = await removeIndexLines(req);
  if (memoryIndex) await writeAtomic(entryFile, `${JSON.stringify({ ...entry, memoryIndex }, null, 2)}\n`);
  return { trashId };
}

async function readEntry(entryDir: string): Promise<TrashEntry> {
  const raw = await readFile(join(entryDir, 'entry.json'), 'utf8').catch((err: unknown) => {
    if (errno(err) === 'ENOENT') throw new TrashError('Nothing in the trash under that id', 404);
    throw err;
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TrashError('That trash entry is damaged', 409);
  }
  const entry = entrySchema.safeParse(parsed);
  if (!entry.success) throw new TrashError('That trash entry is damaged', 409);
  return entry.data;
}

/** Re-inserts index lines at their old positions; a line already there is not added twice. */
async function restoreIndexLines(index: NonNullable<TrashEntry['memoryIndex']>): Promise<void> {
  const text = await readFile(index.path, 'utf8').catch(() => null);
  if (text === null) return; // the index itself is gone; nothing to put the pointers into
  const lines = text.split('\n');
  for (const { index: at, text: line } of [...index.lines].sort((a, b) => a.index - b.index)) {
    if (!lines.includes(line)) lines.splice(Math.min(at, lines.length), 0, line);
  }
  await writeAtomic(index.path, lines.join('\n'));
}

/** Moves a trash entry back where it came from. Never overwrites; never writes through a changed folder. */
export async function restoreFromTrash(trashId: string, trashDir: string): Promise<{ name: string; type: ResourceType; path: string }> {
  if (!TRASH_ID_RE.test(trashId)) throw new TrashError('Nothing in the trash under that id', 404);
  const entryDir = join(trashDir, trashId);
  const entry = await readEntry(entryDir);
  const payload = join(entryDir, 'payload', basename(entry.originalPath));
  await lstat(payload).catch(() => {
    throw new TrashError('That trash entry is damaged', 409);
  });
  const occupied = () => new TrashError(`Something is already at ${entry.display} — move it away first`, 409);
  const exists = await lstat(entry.originalPath).then(() => true, (err: unknown) => {
    if (errno(err) === 'ENOENT') return false;
    throw err;
  });
  if (exists) throw occupied();

  await mkdir(dirname(entry.originalPath), { recursive: true });
  const parentNow = await realpath(dirname(entry.originalPath));
  if (parentNow !== entry.parentReal) {
    throw new TrashError(`The folder ${entry.display} came from now resolves somewhere else — not restored`, 409);
  }
  try {
    await placeWithoutReplacing(payload, entry.originalPath);
  } catch (err) {
    const code = errno(err);
    if (code === 'EEXIST' || code === 'ENOTEMPTY') throw occupied();
    // A finished cross-volume copy whose trash copy would not go away: it IS back.
    if (!(err instanceof PartialMoveError)) throw err;
  }
  if (entry.memoryIndex) await restoreIndexLines(entry.memoryIndex);
  await rm(entryDir, { recursive: true, force: true }).catch(() => undefined);
  return { name: entry.name, type: entry.type, path: entry.display };
}

/**
 * fsSafe — the filesystem guard rails behind the RESOURCES tab (read-only).
 *
 * Everything `server/resource*.ts` shows a browser is read through here, so the
 * rules that keep that feature from leaking live in ONE place instead of being
 * re-derived per route:
 *
 * - **Confinement is decided on realpaths, never on strings.** `resolveWithin`
 *   rejects `..` and absolute input up front, then realpaths the result and
 *   checks it is still under the realpath of the root. A string prefix check
 *   alone is defeated by a symlink inside a skill package that points at `~`.
 * - **Credential files are never read** — not for display and not for hashing.
 *   `isCredentialPath` is the one predicate, judged on the path relative to
 *   the root being walked (`isCredentialTarget` for a resource that may be a
 *   link); callers treat a hit as "name and size only".
 * - **A parser error is never echoed.** V8's JSON errors and smol-toml's both
 *   quote the offending source line, and the offending line of a config file is
 *   exactly where an unterminated `api_key = "sk-…` sits. `readConfigFile`
 *   reports a line number and nothing else.
 * - **No `*Sync` calls.** The scan runs on the one event loop that also relays
 *   terminals and hooks; every read here is async, and `createLimiter` bounds
 *   how many are in flight at once.
 */
import { createHash, createHmac, type Hash, type Hmac } from 'crypto';
import { constants, createReadStream, type Dirent } from 'fs';
import { lstat, open, readdir, readlink, realpath, stat, type FileHandle } from 'fs/promises';
import { isAbsolute, join, relative, sep } from 'path';
import { parse as parseToml } from 'smol-toml';

/** How much of a file the binary sniff looks at. */
const SNIFF_BYTES = 8 * 1024;

/** A config file bigger than this is reported, not parsed (`~/.claude.json` is a few hundred KB). */
export const CONFIG_MAX_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Display paths
// ---------------------------------------------------------------------------

/**
 * Home-relative display form (`~/.claude/skills/x`). Summaries carry only this
 * form, so a catalog can be rendered or logged without exposing the machine's
 * layout. `homeReal` covers macOS, where `/var/…` and `/private/var/…` name the
 * same directory and a realpath'd resource path would otherwise stay absolute.
 * A path outside home is returned unchanged.
 */
export function displayPath(absPath: string, home: string, homeReal?: string): string {
  const homes = homeReal && homeReal !== home ? [home, homeReal] : [home];
  for (const h of homes) {
    if (!h) continue;
    if (absPath === h) return '~';
    const prefix = h.endsWith(sep) ? h : h + sep;
    if (absPath.startsWith(prefix)) return `~/${absPath.slice(prefix.length)}`;
  }
  return absPath;
}

// ---------------------------------------------------------------------------
// Confinement
// ---------------------------------------------------------------------------

export type PathSafetyReason = 'invalid' | 'escape' | 'not-found';

/** `invalid`/`escape` map to 400, `not-found` to 404 — never a stack trace. */
export class PathSafetyError extends Error {
  readonly reason: PathSafetyReason;

  constructor(message: string, reason: PathSafetyReason) {
    super(message);
    this.name = 'PathSafetyError';
    this.reason = reason;
  }
}

function errnoCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? 'EUNKNOWN';
}

/**
 * Resolve `rel` inside `root` and return the real (symlink-free) path.
 *
 * `..` is rejected even when it would land back inside (`docs/../SKILL.md`):
 * a legitimate client only ever sends paths it got from a package listing, so
 * a `..` can only come from someone probing, and "normalise then allow" is the
 * shape every traversal bypass has taken.
 */
export async function resolveWithin(root: string, rel: string): Promise<string> {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) {
    throw new PathSafetyError('Invalid path', 'invalid');
  }
  if (isAbsolute(rel) || /^[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new PathSafetyError('Path must be relative to the package', 'invalid');
  }
  if (rel.split(/[\\/]+/).some((segment) => segment === '..')) {
    throw new PathSafetyError('Path may not contain ..', 'invalid');
  }

  let realRoot: string;
  let resolved: string;
  try {
    realRoot = await realpath(root);
    resolved = await realpath(join(realRoot, rel));
  } catch {
    throw new PathSafetyError('File not found', 'not-found');
  }
  if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) {
    throw new PathSafetyError('Path escapes the package', 'escape');
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * File names that hold credentials. Deliberately generous: a false positive
 * only hides a file's content (it is still listed by name and size), a false
 * negative serves a key to the browser.
 */
const CREDENTIAL_NAME_RES: readonly RegExp[] = [
  /^(?:auth\.json|\.auth-token|\.credentials.*|secrets)$/,
  /^(?:.*[-_.])?credentials?\.json$|^(?:tokens?|secrets?)\.json$|^client_secret.*\.json$|service[-_]?account.*\.json$/,
  /^\.env(?:\..+)?$|^.+\.env$|^\.envrc$/,
  /^[._]netrc$|^\.(?:npmrc|pypirc|pgpass|git-credentials|htpasswd|my\.cnf)$/,
  /^.+\.tfvars(?:\.json)?$|^.+\.tfstate(?:\.backup)?$|^kubeconfig(?:\.ya?ml)?$/,
  /^id_(?:rsa|dsa|ecdsa|ed25519).*$|^.+\.(?:pem|key|p12|pfx|jks|keystore)$/,
];

/** A folder anywhere in the path that holds nothing but credentials. */
const CREDENTIAL_DIRS: ReadonlySet<string> = new Set(['secrets', '.ssh', '.gnupg', '.aws', '.kube']);

/**
 * True for a file that is only ever reported by name and size. Pass the path
 * RELATIVE to the root being walked (see `isCredentialTarget`): a `secrets/`
 * or `.ssh/` folder inside it counts — the whole folder is credentials, not
 * just known names — but the folders ABOVE the root say nothing about it.
 */
export function isCredentialPath(relPath: string): boolean {
  const segments = relPath.toLowerCase().split(/[\\/]+/).filter(Boolean);
  if (segments.some((s) => CREDENTIAL_DIRS.has(s))) return true;
  const name = segments[segments.length - 1] ?? '';
  return CREDENTIAL_NAME_RES.some((re) => re.test(name));
}

/** True when `target` is `root` itself or lies below it (both already realpath'd). */
export function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

export interface CredentialTarget {
  /** The root the resource was listed under, as listed and as realpath'd. */
  rootAbs: string;
  rootReal: string;
  /** The resource's path as listed, and where it resolves. */
  absPath: string;
  real: string;
}

/**
 * Credential test for a resource file, judged RELATIVE to the root it was
 * listed under: an ancestor folder named `Secrets` (`~/Documents/Secrets/app`)
 * says nothing about the files of the project inside it. A resolved target
 * inside the root is judged relative to the root too; only a target OUTSIDE it
 * (`commands/x.md -> ~/.aws/credentials`) is judged on its absolute path.
 */
export function isCredentialTarget(t: CredentialTarget): boolean {
  if (isCredentialPath(relative(t.rootAbs, t.absPath))) return true;
  return isWithin(t.rootReal, t.real) ? isCredentialPath(relative(t.rootReal, t.real)) : isCredentialPath(t.real);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * NUL anywhere in the first 8 KB, or more than 10 % control bytes (other than
 * tab/newline/CR/FF/VT/BEL/BS and ESC for ANSI colour), means "don't render".
 */
export function isProbablyBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, SNIFF_BYTES);
  if (n === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) suspicious++;
  }
  return suspicious / n > 0.1;
}

/** Decode a prefix cut at an arbitrary byte, dropping a trailing partial UTF-8 sequence. */
function decodeUtf8Prefix(buf: Buffer): string {
  let i = buf.length - 1;
  let continuation = 0;
  while (i >= 0 && continuation < 3 && (buf[i] & 0xc0) === 0x80) {
    i--;
    continuation++;
  }
  let end = buf.length;
  if (i >= 0) {
    const lead = buf[i];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (need > 1 && continuation + 1 < need) end = i;
  }
  return buf.subarray(0, end).toString('utf8');
}

export interface CappedText {
  /** Size on disk (not the size read). */
  bytes: number;
  content?: string;
  truncated: boolean;
  binary: boolean;
}

/**
 * Read at most `capBytes` of a regular file as text. Opened O_NONBLOCK and
 * fstat'ed before reading: a FIFO planted in a package would otherwise block a
 * libuv worker forever on `open`, and a device file would never reach EOF.
 * Callers pass a realpath they have just checked, so O_NOFOLLOW refuses a
 * final component swapped for a symlink between that check and this open.
 */
export async function readTextCapped(absPath: string, capBytes: number): Promise<CappedText> {
  const handle = await open(absPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new PathSafetyError('Not a regular file', 'invalid');
    const toRead = Math.min(st.size, capBytes);
    const buf = Buffer.alloc(toRead);
    let offset = 0;
    while (offset < toRead) {
      const { bytesRead } = await handle.read(buf, offset, toRead - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const data = buf.subarray(0, offset);
    const truncated = st.size > offset;
    if (isProbablyBinary(data)) return { bytes: st.size, truncated, binary: true };
    const content = truncated ? decodeUtf8Prefix(data) : data.toString('utf8');
    return { bytes: st.size, content, truncated, binary: false };
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function sha1Hex(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * Keyed sha256 — for content whose plain digest would let anyone holding a
 * catalog confirm a guess offline (a config with a short password in it).
 * The key is per process, so these digests compare within one run only.
 */
export function hmacText(key: Uint8Array, text: string): string {
  return createHmac('sha256', key).update(text).digest('hex');
}

export async function hmacFile(key: Uint8Array, absPath: string): Promise<string> {
  return (await digestFile(absPath, () => createHmac('sha256', key))).sha256;
}

/** One streaming pass: the digest from `make()`, plus the binary sniff of the first chunk. */
function digestFile(absPath: string, make: () => Hash | Hmac): Promise<{ sha256: string; binary: boolean }> {
  return new Promise((resolve, reject) => {
    const hash = make();
    let binary: boolean | null = null;
    const stream = createReadStream(absPath, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (binary === null) binary = isProbablyBinary(buf);
      hash.update(buf);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), binary: binary ?? false }));
  });
}

/**
 * Streaming sha256 of a regular file, with the binary sniff taken from the
 * first chunk of the same pass — a package walk needs both, and reading each
 * file twice would double the scan's I/O. Callers only pass regular files.
 */
export function hashFile(absPath: string): Promise<{ sha256: string; binary: boolean }> {
  return digestFile(absPath, () => createHash('sha256'));
}

export async function sha256File(absPath: string): Promise<string> {
  return (await hashFile(absPath)).sha256;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((k) => [k, sortKeysDeep(record[k])]));
  }
  return value;
}

/** JSON with every object's keys sorted — the hash input for config-derived resources. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value)) ?? 'null';
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * At most `max` tasks in flight. Wrap LEAF fs calls only — a limited task that
 * awaits another limited task can hold every slot while its children queue
 * behind it, which deadlocks a recursive walk.
 */
export function createLimiter(max: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];
  const pump = (): void => {
    if (active >= max) return;
    const run = queue.shift();
    if (run) run();
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active += 1;
        let pending: Promise<T>;
        try {
          pending = task();
        } catch (err) {
          pending = Promise.reject(err);
        }
        pending.then(resolve, reject).finally(() => {
          active -= 1;
          pump();
        });
      });
      pump();
    });
}

// ---------------------------------------------------------------------------
// Bounded listing — async, limiter-aware, symlinked directories never followed
// ---------------------------------------------------------------------------

export type ListStatus = 'ok' | 'not-found' | 'inaccessible';

export type DirListing = { status: 'ok'; entries: Dirent[] } | { status: 'not-found' | 'inaccessible' };

/** Entries sorted by name. ENOENT/ENOTDIR read as not-found; anything else (EACCES…) as inaccessible. */
export async function listDir(dir: string, limit: Limiter): Promise<DirListing> {
  try {
    const entries = await limit(() => readdir(dir, { withFileTypes: true }));
    return { status: 'ok', entries: [...entries].sort((a, b) => a.name.localeCompare(b.name)) };
  } catch (err) {
    const code = errnoCode(err);
    return { status: code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'inaccessible' };
  }
}

/** What `p` is after following symlinks; null when it does not resolve. */
export async function statKind(p: string, limit: Limiter): Promise<'dir' | 'file' | 'other' | null> {
  try {
    const st = await limit(() => stat(p));
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
  } catch {
    return null;
  }
}

export async function lstatSize(p: string, limit: Limiter): Promise<number | null> {
  try {
    return (await limit(() => lstat(p))).size;
  } catch {
    return null;
  }
}

/**
 * A dirent that should be listed as a file: a regular file, or a symlink that
 * resolves to a file OR resolves to nothing — a dangling link is kept so the
 * scan can report it as broken. A symlink to a directory is not a file.
 */
async function isFileLike(d: Dirent, abs: string, limit: Limiter): Promise<boolean> {
  if (d.isFile()) return true;
  if (!d.isSymbolicLink()) return false;
  const kind = await statKind(abs, limit);
  return kind === 'file' || kind === null;
}

export interface TreeOptions {
  accept: (name: string) => boolean;
  maxDepth: number;
  maxFiles: number;
}

export interface TreeListing {
  files: Array<{ rel: string; abs: string }>;
  status: ListStatus;
  capped: boolean;
  /** Symlinked folders met and NOT followed — counted, so coverage can say so. */
  linkedDirs: number;
}

/**
 * Files (regular or symlinked) under `dir` whose name passes `accept`, as
 * `/`-joined relative paths. Dot-dirs and node_modules are skipped. A
 * symlinked directory is never entered — that is what keeps a link cycle (or a
 * link to `~`) from recursing — but it is counted in `linkedDirs`, so a
 * `commands/team -> ~/shared/cmds` link is reported rather than silently missed.
 */
export async function listTree(dir: string, limit: Limiter, opts: TreeOptions): Promise<TreeListing> {
  const top = await listDir(dir, limit);
  if (top.status !== 'ok') return { files: [], status: top.status, capped: false, linkedDirs: 0 };
  const files: Array<{ rel: string; abs: string }> = [];
  let linkedDirs = 0;
  const visit = async (entries: Dirent[], abs: string, rel: string, depth: number): Promise<void> => {
    for (const d of entries) {
      if (files.length >= opts.maxFiles) return;
      const childAbs = join(abs, d.name);
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (d.name.startsWith('.') || d.name === 'node_modules' || depth >= opts.maxDepth) continue;
        const sub = await listDir(childAbs, limit);
        if (sub.status === 'ok') await visit(sub.entries, childAbs, childRel, depth + 1);
      } else if (d.isSymbolicLink()) {
        const kind = await statKind(childAbs, limit);
        // A dangling link (null) is kept as a file, so the scan can report it as broken.
        if (kind === 'dir') linkedDirs += d.name.startsWith('.') ? 0 : 1;
        else if ((kind === 'file' || kind === null) && opts.accept(d.name)) files.push({ rel: childRel, abs: childAbs });
      } else if (d.isFile() && opts.accept(d.name)) {
        files.push({ rel: childRel, abs: childAbs });
      }
    }
  };
  await visit(top.entries, dir, '', 0);
  return { files, status: 'ok', capped: files.length >= opts.maxFiles, linkedDirs };
}

/** Top-level files of `dir` (regular or symlinked, dotfiles skipped) whose name passes `accept`. */
export async function listFlatFiles(
  dir: string,
  limit: Limiter,
  accept: (name: string) => boolean,
): Promise<{ files: Array<{ name: string; abs: string }>; status: ListStatus }> {
  const listing = await listDir(dir, limit);
  if (listing.status !== 'ok') return { files: [], status: listing.status };
  const candidates = listing.entries.filter((d) => !d.name.startsWith('.') && accept(d.name));
  const keep = await Promise.all(candidates.map((d) => isFileLike(d, join(dir, d.name), limit)));
  const files = candidates.filter((_, i) => keep[i]).map((d) => ({ name: d.name, abs: join(dir, d.name) }));
  return { files, status: 'ok' };
}

/** File count and total bytes under `dir` — for data that is sized but never opened (transcripts). */
export async function sizeTree(
  dir: string,
  limit: Limiter,
  maxEntries: number,
): Promise<{ count: number; bytes: number; found: boolean }> {
  const top = await listDir(dir, limit);
  if (top.status !== 'ok') return { count: 0, bytes: 0, found: false };
  const totals = { count: 0, bytes: 0, seen: 0 };
  const visit = async (entries: Dirent[], abs: string): Promise<void> => {
    for (const d of entries) {
      if (++totals.seen > maxEntries) return;
      const p = join(abs, d.name);
      if (d.isDirectory()) {
        const sub = await listDir(p, limit);
        if (sub.status === 'ok') await visit(sub.entries, p);
      } else if (d.isFile()) {
        totals.count += 1;
        totals.bytes += (await lstatSize(p, limit)) ?? 0;
      }
    }
  };
  await visit(top.entries, dir);
  return { count: totals.count, bytes: totals.bytes, found: true };
}

// ---------------------------------------------------------------------------
// Packages — every file of a skill folder, bounded, never followed out
// ---------------------------------------------------------------------------

/** Never part of a package: not listed, not hashed, not served by the file route. */
export const PACKAGE_SKIP: ReadonlySet<string> = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', 'venv']);

export interface PackageLimits {
  packageMaxFiles: number;
  packageMaxBytes: number;
  /** Folder levels entered below the package root. */
  packageMaxDepth: number;
  /** Folders entered in total. */
  packageMaxDirs: number;
}

export interface PackageFile {
  rel: string;
  bytes: number;
  isText: boolean;
  isSymlink: boolean;
  /** Absent when the file could not be read (EACCES…) — the package then has no hash either. */
  sha256?: string;
  mtimeMs: number;
}

export interface PackageWalk {
  files: PackageFile[];
  capped: boolean;
  bytes: number;
  mtimeMs: number;
}

async function describeFile(abs: string, rel: string, isSymlink: boolean, st: { size: number; mtimeMs: number }, limit: Limiter): Promise<PackageFile> {
  const meta = { rel, bytes: st.size, isSymlink, mtimeMs: st.mtimeMs };
  try {
    // A link inside a package is never followed (it could point anywhere, `~`
    // included) and a credential is never opened — both hash by name only.
    if (isSymlink) return { ...meta, isText: false, sha256: sha256Text(`symlink:${await limit(() => readlink(abs))}`) };
    if (isCredentialPath(rel)) return { ...meta, isText: false, sha256: sha256Text(`credential:${st.size}`) };
    const hashed = await limit(() => hashFile(abs));
    return { ...meta, isText: !hashed.binary, sha256: hashed.sha256 };
  } catch {
    return { ...meta, isText: false }; // unreadable: listed, never hashed
  }
}

/**
 * Files of a package (skip list applied). The file-count and byte caps end the
 * walk; the depth and folder caps only skip what lies beyond them, so the files
 * already in reach are still listed. Either way the walk reports `capped` —
 * a "package" that is really a link to a huge tree costs a bounded walk.
 */
export async function walkPackage(root: string, limits: PackageLimits, limit: Limiter): Promise<PackageWalk> {
  const acc: PackageWalk = { files: [], capped: false, bytes: 0, mtimeMs: 0 };
  let dirs = 0;
  let full = false;
  const visit = async (dir: string, rel: string, depth: number): Promise<void> => {
    const listing = await listDir(dir, limit);
    if (listing.status !== 'ok') return;
    for (const d of listing.entries) {
      if (full) return;
      if (PACKAGE_SKIP.has(d.name)) continue;
      const abs = join(dir, d.name);
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth >= limits.packageMaxDepth || dirs >= limits.packageMaxDirs) {
          acc.capped = true;
          continue;
        }
        dirs += 1;
        await visit(abs, childRel, depth + 1);
        continue;
      }
      if (!d.isFile() && !d.isSymbolicLink()) continue;
      const st = await limit(() => lstat(abs)).catch(() => null);
      if (!st) continue; // vanished mid-walk
      if (acc.files.length >= limits.packageMaxFiles || acc.bytes + st.size > limits.packageMaxBytes) {
        acc.capped = true;
        full = true;
        return;
      }
      const file = await describeFile(abs, childRel, d.isSymbolicLink(), st, limit);
      acc.files.push(file);
      acc.bytes += file.bytes;
      acc.mtimeMs = Math.max(acc.mtimeMs, file.mtimeMs);
    }
  };
  await visit(root, '', 0);
  return acc;
}

/** sha256 over `relPath \0 fileHash \n`, sorted by code unit; undefined if any file was unreadable. */
export function packageHash(files: readonly PackageFile[]): string | undefined {
  if (files.some((f) => f.sha256 === undefined)) return undefined;
  const lines = [...files]
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map((f) => `${f.rel}\0${f.sha256}\n`);
  return sha256Text(lines.join(''));
}

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

export type ConfigRead =
  | { status: 'ok'; value: unknown; bytes: number; mtimeMs: number }
  | { status: 'missing' }
  | { status: 'failed'; error: string; bytes?: number; mtimeMs?: number };

/** Line of a V8 JSON error, when the message carries one (it never quotes source here). */
function jsonErrorLine(err: unknown, text: string): number | null {
  const message = err instanceof Error ? err.message : '';
  const lineCol = /line (\d+) column \d+/.exec(message);
  if (lineCol) return Number(lineCol[1]);
  const position = /position (\d+)/.exec(message);
  if (position) return text.slice(0, Number(position[1])).split('\n').length;
  return null;
}

function describeParseError(kind: 'json' | 'toml', err: unknown, text: string): string {
  if (kind === 'toml') {
    const { line, column } = (err ?? {}) as { line?: unknown; column?: unknown };
    return typeof line === 'number'
      ? `Invalid TOML (line ${line}${typeof column === 'number' ? `, column ${column}` : ''})`
      : 'Invalid TOML';
  }
  const line = jsonErrorLine(err, text);
  return line ? `Invalid JSON (line ${line})` : 'Invalid JSON';
}

/** Read a whole regular file through `handle`, never more than `size` bytes (it may grow meanwhile). */
async function readHandle(handle: FileHandle, size: number): Promise<Buffer> {
  const buf = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buf, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buf.subarray(0, offset);
}

/**
 * Parse a JSON or TOML config. Never throws; a parse failure carries a
 * position, never source text. Opened O_NONBLOCK and fstat'ed, like
 * `readTextCapped`: a project's `.mcp.json` can be a FIFO, which a path-based
 * read would block a libuv worker on forever.
 */
export async function readConfigFile(
  absPath: string,
  kind: 'json' | 'toml',
  maxBytes = CONFIG_MAX_BYTES,
): Promise<ConfigRead> {
  let handle: FileHandle;
  try {
    handle = await open(absPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = errnoCode(err);
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { status: 'missing' }
      : { status: 'failed', error: `Cannot read (${code})` };
  }
  let text: string;
  let meta: { bytes: number; mtimeMs: number };
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { status: 'failed', error: 'Not a regular file' };
    meta = { bytes: st.size, mtimeMs: st.mtimeMs };
    if (st.size > maxBytes) return { status: 'failed', error: `Too large to parse (${st.size} bytes)`, ...meta };
    text = (await readHandle(handle, st.size)).toString('utf8').replace(/^﻿/, '');
  } catch (err) {
    return { status: 'failed', error: `Cannot read (${errnoCode(err)})` };
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    const value: unknown = kind === 'json' ? JSON.parse(text) : parseToml(text);
    return { status: 'ok', value, ...meta };
  } catch (err) {
    return { status: 'failed', error: describeParseError(kind, err, text), ...meta };
  }
}

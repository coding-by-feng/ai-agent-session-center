/**
 * resourceCatalog — scan state for the RESOURCES tab, plus detail / file / compare.
 *
 * One scan at a time: `startScan` while a scan is running JOINS it (returns the
 * in-flight state) instead of starting a second walk of every project on the
 * same event loop — the same coalescing codexModelCatalog.ts does for its
 * refresh. A failed scan flips to `error` but keeps the previous result, so a
 * transient EACCES never blanks a catalog the user was reading.
 *
 * The catalog keeps the only id → absolute-path map (`ScanOutput.internals`).
 * Everything it hands out is display-only, and config VALUES only ever leave
 * through `flattenMasked` — a settings file, ~/.claude.json or config.toml body
 * is never returned as text, not even in a compare (which diffs the masked
 * `key: value` lines instead).
 */
import { homedir } from 'os';
import { basename, relative } from 'path';
import { realpath } from 'fs/promises';
import { createTwoFilesPatch } from 'diff';
import type { ResourceCatalog, ResourceCompare, ResourceCompareFile, ResourceDetail, ResourceField, ResourceFile, ResourceFileContent, ResourceRoots, ResourceSummary, RestoreResult, ScanProgress, ScanState, UninstallResult } from '../src/types/resources.js';
import { uninstallBlocker } from '../src/types/resources.js';
import { createLimiter, displayPath, isCredentialPath, isCredentialTarget, isWithin, PACKAGE_SKIP, PathSafetyError, readTextCapped, resolveWithin, statKind, walkPackage } from './fsSafe.js';
import type { Limiter, PackageFile } from './fsSafe.js';
import { flattenMasked, redactPatch, redactPemBlocks, redactSecretsInString, redactStrings, redactText } from './resourceMask.js';
import { globalRootPaths } from './resourceRoots.js';
import { jsonSafe, parseFrontmatter, scanResources } from './resourceScanner.js';
import type { InternalResource, ScanLimits, ScanOutput } from './resourceScanner.js';
import { DEFAULT_TRASH_DIR, moveToTrash, restoreFromTrash } from './resourceUninstall.js';
import log from './logger.js';

export const BODY_MAX_BYTES = 256 * 1024;
export const FILE_MAX_BYTES = 512 * 1024;
export const PATCH_MAX_BYTES = 200 * 1024;
const DIFF_INPUT_MAX_BYTES = 256 * 1024;
/** Compares in flight at once; the rest queue. Each reads two main files and runs a diff. */
const COMPARE_CONCURRENCY = 2;
/** The diff runs in async (setTimeout-chunked) mode; this bounds how long it may keep going. */
const DIFF_TIMEOUT_MS = 2_000;

export interface ResourceCatalogDeps {
  /** Project paths of sessions AASC knows about (evidence `aasc-session`). May throw — treated as none. */
  sessionProjectPaths: () => string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  limits?: Partial<ScanLimits>;
  /** Where uninstalled resources go (resourceUninstall.ts). Tests override. */
  trashDir?: string;
}

export interface ResourceCatalogService {
  getCatalog(): ResourceCatalog;
  /** Private transfer access; never serialize these paths or raw records to the client. */
  transferInternals(): InternalResource[];
  /** `GET /`: the first call ever starts a scan and reports `scanning`. */
  getOrStartCatalog(): ResourceCatalog;
  startScan(extraRoots?: readonly string[]): { state: ScanState; progress?: ScanProgress };
  /** Resolves once no scan is in flight (never rejects). */
  whenIdle(): Promise<void>;
  getDetail(id: string): Promise<ResourceDetail | null>;
  /** Throws `PathSafetyError` (400/404) or `ResourceLookupError` (403/404). */
  getFile(id: string, relPath: string): Promise<ResourceFileContent>;
  getCompare(id: string, against: string): Promise<ResourceCompare | null>;
  /** Moves one resource into the trash. Throws `ResourceLookupError` (400/403/404/409) or `TrashError`. */
  uninstall(id: string, confirmName: string): Promise<UninstallResult>;
  /** Puts a trash entry back. Throws `TrashError` (404/409). */
  restore(trashId: string): Promise<RestoreResult>;
}

/** A lookup that fails for a reason other than the path itself. */
export class ResourceLookupError extends Error {
  readonly status: 400 | 403 | 404 | 409;

  constructor(message: string, status: 400 | 403 | 404 | 409) {
    super(message);
    this.name = 'ResourceLookupError';
    this.status = status;
  }
}

type Meta = Pick<ResourceCatalog, 'state' | 'startedAt' | 'scannedAt' | 'durationMs' | 'progress' | 'error'>;

interface Side {
  label: string;
  /** Display path. */
  path: string;
  /** Real path of the package dir or file. */
  abs: string;
  /** The path as listed (before symlinks) — with `root`, what the credential test is judged on. */
  listed: string;
  /** The root it was found under (listed and realpath'd) — credentials are judged relative to it. */
  root: { abs: string; real: string };
  isPackage: boolean;
  /** A package's files with their scan-time hashes, when the scan walked it. */
  files?: readonly PackageFile[];
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function wrapValue(value: unknown, keys: readonly string[]): unknown {
  return keys.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sideLabel(r: InternalResource): string {
  return `${r.entry.agent === 'shared' ? 'Shared' : capitalise(r.entry.agent)} · ${capitalise(r.entry.scope)}`;
}

function toResourceFile(f: PackageFile): ResourceFile {
  return { path: f.rel, bytes: f.bytes, isText: f.isText, ...(f.isSymlink ? { isSymlink: true } : {}) };
}

/** Masked fields of a config resource — the ONLY form a config value is ever returned in. */
function configFields(r: InternalResource, result: ScanOutput): ResourceField[] {
  if (!r.entry.config) return [];
  const value = wrapValue(r.entry.config.value, r.entry.config.wrap);
  return flattenMasked(value, { homeDirs: [result.info.home, result.info.homeReal] });
}

/** Scrub absolute home paths out of an error before it is shown or logged. */
function sanitizeError(err: unknown, home: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split(home).join('~').slice(0, 300);
}

// ---------------------------------------------------------------------------
// Detail and file
// ---------------------------------------------------------------------------

const NO_TEXT = { text: '', truncated: false } as const;

/**
 * Where a resource resolved at scan time must still be where it resolves now.
 * Every confinement and credential decision was made on that path, so a file
 * swapped for a link since then (or a package re-pointed) is refused, never
 * followed to wherever it leads today.
 */
async function assertUnchanged(listed: string, recorded: string | undefined, limit: Limiter): Promise<void> {
  if (!recorded) return;
  const now = await limit(() => realpath(listed)).catch(() => null);
  if (now !== recorded) throw new ResourceLookupError('Changed since the last scan — rescan', 409);
}

/** A single file that resolved OUTSIDE its root: listed and hashed, never read for display. */
function isWithheld(r: InternalResource): boolean {
  if (r.entry.kind === 'package' || r.entry.format === 'config' || !r.realPath) return false;
  return !isWithin(r.rootReal ?? r.entry.rootAbs, r.realPath);
}

function refuseWithheld(r: InternalResource, display: (absPath: string) => string): void {
  if (!isWithheld(r)) return;
  throw new ResourceLookupError(`Not compared: ${r.summary.path} resolves outside ${display(r.entry.rootAbs)} — only files inside it are read`, 403);
}

/**
 * The main file of a resource, after `assertUnchanged`: a package's SKILL.md
 * must still resolve inside the package and not to a credential. A single
 * file's scan-time decision stands — it was made on the very same paths.
 */
async function currentMainFile(r: InternalResource, limit: Limiter): Promise<string | null> {
  if (!r.mainFile || !r.realPath) return null;
  if (r.entry.kind !== 'package') return r.realPath;
  try {
    const resolved = await limit(() => resolveWithin(r.realPath as string, 'SKILL.md'));
    return isCredentialPath(relative(r.realPath as string, resolved)) ? null : resolved;
  } catch {
    return null;
  }
}

async function detailOf(result: ScanOutput, id: string, limit: Limiter): Promise<ResourceDetail | null> {
  const r = result.internals.get(id);
  if (!r) return null;
  const base: ResourceDetail = { summary: r.summary, findings: result.findings.filter((f) => f.resourceId === id) };
  if (r.entry.format === 'config') return { ...base, fields: configFields(r, result) };
  await assertUnchanged(r.entry.absPath, r.realPath, limit);
  const files = r.files ? { files: r.files.map(toResourceFile) } : {};
  // Withheld: its linked-outside finding (in `findings`) says why there is no body.
  if (isWithheld(r)) return { ...base, ...files };
  const main = await currentMainFile(r, limit);
  const text = main ? await limit(() => readTextCapped(main, BODY_MAX_BYTES)).catch(() => null) : null;
  if (!text || text.content === undefined) return { ...base, ...files };
  if (r.entry.format !== 'markdown') return { ...base, ...files, body: redactText(text.content), bodyTruncated: text.truncated };
  const fm = parseFrontmatter(text.content);
  return {
    ...base,
    ...files,
    body: redactText(fm.body),
    bodyTruncated: text.truncated,
    ...(fm.data ? { frontmatter: redactStrings(jsonSafe(fm.data)) as Record<string, unknown> } : {}),
    ...(fm.error ? { frontmatterError: redactSecretsInString(fm.error) } : {}),
  };
}

const SKIPPED_LOWER = new Set([...PACKAGE_SKIP].map((n) => n.toLowerCase()));

/** Compared lowercased: macOS and Windows disks are case-insensitive by default. */
function hasSkippedSegment(relPath: string): boolean {
  return relPath.split(/[\\/]+/).some((segment) => SKIPPED_LOWER.has(segment.toLowerCase()));
}

async function fileOf(result: ScanOutput, id: string, relPath: string, limit: Limiter): Promise<ResourceFileContent> {
  const r = result.internals.get(id);
  if (!r) throw new ResourceLookupError('Resource not found', 404);
  const root = r.entry.kind === 'package' ? r.realPath : undefined;
  if (!root) throw new ResourceLookupError('This resource has no package files', 404);
  await assertUnchanged(r.entry.absPath, root, limit);
  const refuse = () => new ResourceLookupError('Credential files are never read', 403);
  if (hasSkippedSegment(relPath)) throw new PathSafetyError('Not part of the package', 'invalid');
  if (isCredentialPath(relPath)) throw refuse();
  const abs = await resolveWithin(root, relPath);
  // Both checks again on the RESOLVED path: `docs -> .git` or an innocent name
  // linking to `.env` must not get through, and on a case-insensitive disk
  // `.GIT/config` IS `.git/config`.
  const resolvedRel = relative(await limit(() => realpath(root)), abs);
  if (hasSkippedSegment(resolvedRel)) throw new PathSafetyError('Not part of the package', 'invalid');
  if (isCredentialPath(resolvedRel)) throw refuse();
  if ((await statKind(abs, limit)) !== 'file') throw new PathSafetyError('Not a file', 'invalid');
  const text = await limit(() => readTextCapped(abs, FILE_MAX_BYTES));
  return text.binary || text.content === undefined
    ? { path: relPath, bytes: text.bytes, binary: true }
    : { path: relPath, bytes: text.bytes, content: redactText(text.content), ...(text.truncated ? { truncated: true } : {}) };
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

/** Cut a patch to the cap on a line boundary. */
function capPatch(patch: string): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch) <= PATCH_MAX_BYTES) return { patch, truncated: false };
  const cut = Buffer.from(patch).subarray(0, PATCH_MAX_BYTES).toString('utf8');
  return { patch: cut.slice(0, cut.lastIndexOf('\n') + 1), truncated: true };
}

function unifiedPatch(leftName: string, rightName: string, a: string, b: string): Promise<string | undefined> {
  return new Promise((resolvePatch) => {
    createTwoFilesPatch(leftName, rightName, a, b, undefined, undefined, {
      context: 3,
      timeout: DIFF_TIMEOUT_MS,
      callback: (patch: string | undefined) => resolvePatch(patch),
    });
  });
}

/**
 * Text for a diff: `''` when the side has no such file, null when it may not be
 * shown (binary, credential). The credential test is relative to `root`.
 */
async function readForDiff(file: { listed: string; root: { abs: string; real: string } } | null, limit: Limiter): Promise<{ text: string; truncated: boolean } | null> {
  if (!file) return NO_TEXT;
  const real = await limit(() => realpath(file.listed)).catch(() => null);
  if (!real) return NO_TEXT;
  if (!isWithin(file.root.real, real)) return null; // never followed out of its root
  if (isCredentialTarget({ rootAbs: file.root.abs, rootReal: file.root.real, absPath: file.listed, real })) return null;
  if ((await statKind(real, limit)) !== 'file') return NO_TEXT;
  const read = await limit(() => readTextCapped(real, DIFF_INPUT_MAX_BYTES)).catch(() => null);
  return read && !read.binary && read.content !== undefined ? { text: read.content, truncated: read.truncated } : null;
}

/** SKILL.md of a package side: '' if absent, null if it escapes the package (never followed out). */
async function readSkillForDiff(packageDir: string, limit: Limiter): Promise<{ text: string; truncated: boolean } | null> {
  try {
    const resolved = await limit(() => resolveWithin(packageDir, 'SKILL.md'));
    const real = await limit(() => realpath(packageDir));
    return readForDiff({ listed: resolved, root: { abs: real, real } }, limit);
  } catch (err) {
    return err instanceof PathSafetyError && err.reason === 'not-found' ? NO_TEXT : null;
  }
}

async function patchFields(
  names: { left: string; right: string },
  texts: ReadonlyArray<{ text: string; truncated: boolean } | null>,
): Promise<Pick<ResourceCompare, 'patch' | 'patchTruncated'>> {
  const [a, b] = texts;
  if (!a || !b) return {};
  // Private-key blocks are masked BEFORE diffing, while their BEGIN/END lines
  // are in view (a hunk can start mid-block). Line rules run on the patch, so
  // a changed token still shows as a changed line — masked on both sides.
  const patch = await unifiedPatch(names.left, names.right, redactPemBlocks(a.text), redactPemBlocks(b.text));
  if (patch === undefined) return { patchTruncated: true };
  const capped = capPatch(redactPatch(patch));
  return { patch: capped.patch, ...(capped.truncated || a.truncated || b.truncated ? { patchTruncated: true } : {}) };
}

function fileStatuses(left: readonly PackageFile[], right: readonly PackageFile[]): ResourceCompareFile[] {
  const l = new Map(left.map((f) => [f.rel, f.sha256]));
  const r = new Map(right.map((f) => [f.rel, f.sha256]));
  return [...new Set([...l.keys(), ...r.keys()])].sort().map((path) => ({
    path,
    status: !r.has(path) ? 'only-left' : !l.has(path) ? 'only-right'
      : l.get(path) !== undefined && l.get(path) === r.get(path) ? 'same' : 'changed',
  }));
}

async function compareSides(left: Side, right: Side, limits: ScanLimits, limit: Limiter): Promise<ResourceCompare> {
  const ends = { left: { label: left.label, path: left.path }, right: { label: right.label, path: right.path } };
  const names = { left: left.path, right: right.path };
  if (!left.isPackage || !right.isPackage) {
    const texts = await Promise.all([readForDiff(left, limit), readForDiff(right, limit)]);
    const status = texts[0] && texts[1] && texts[0].text === texts[1].text ? 'same' : 'changed';
    return { ...ends, files: [{ path: basename(left.abs), status }], ...(await patchFields(names, texts)) };
  }
  // The scan already hashed every file of both packages; re-walking them on
  // every click would re-read two whole trees for a list the catalog shows anyway.
  const filesOf = async (side: Side) => side.files ?? (await walkPackage(side.abs, limits, limit)).files;
  const [l, r] = await Promise.all([filesOf(left), filesOf(right)]);
  const texts = await Promise.all([readSkillForDiff(left.abs, limit), readSkillForDiff(right.abs, limit)]);
  return { ...ends, files: fileStatuses(l, r), ...(await patchFields(names, texts)) };
}

async function compareConfigs(left: InternalResource, right: InternalResource, result: ScanOutput): Promise<ResourceCompare> {
  const lines = (r: InternalResource) => `${configFields(r, result).map((f) => `${f.key}: ${f.value}`).join('\n')}\n`;
  const [a, b] = [lines(left), lines(right)];
  const names = { left: left.summary.path, right: right.summary.path };
  return {
    left: { label: sideLabel(left), path: left.summary.path },
    right: { label: sideLabel(right), path: right.summary.path },
    files: [{ path: left.summary.name, status: a === b ? 'same' : 'changed' }],
    ...(await patchFields(names, [{ text: a, truncated: false }, { text: b, truncated: false }])),
  };
}

function sideOf(r: InternalResource): Side | null {
  if (!r.realPath) return null;
  const root = { abs: r.entry.rootAbs, real: r.rootReal ?? r.entry.rootAbs };
  const isPackage = r.entry.kind === 'package';
  return { label: sideLabel(r), path: r.summary.path, abs: r.realPath, listed: r.entry.absPath, root, isPackage, ...(r.files ? { files: r.files } : {}) };
}

async function compareRepo(left: InternalResource, result: ScanOutput, limit: Limiter): Promise<ResourceCompare | null> {
  const leftSide = sideOf(left);
  const { repoAbs, repoReal } = left;
  if (!leftSide || !repoAbs || !repoReal) return null;
  await assertUnchanged(left.entry.absPath, left.realPath, limit);
  await assertUnchanged(repoAbs, repoReal, limit);
  const { display } = result.info;
  refuseWithheld(left, display);
  const repoRoot = result.info.roots.repo ?? repoAbs;
  const repoRootReal = await limit(() => realpath(repoRoot)).catch(() => repoRoot);
  if (!leftSide.isPackage && !isWithin(repoRootReal, repoReal)) {
    throw new ResourceLookupError(`Not compared: the repo copy ${display(repoAbs)} resolves outside the repo`, 403);
  }
  const right = {
    label: 'agent-skills repo', path: display(repoAbs), abs: repoReal, listed: repoAbs,
    root: { abs: repoRoot, real: repoRootReal }, isPackage: leftSide.isPackage,
    ...(left.repoFiles ? { files: left.repoFiles } : {}),
  };
  return compareSides(leftSide, right, result.info.limits, limit);
}

async function compareOf(result: ScanOutput, id: string, against: string, limit: Limiter): Promise<ResourceCompare | null> {
  const left = result.internals.get(id);
  if (!left) return null;
  if (against === 'repo') return compareRepo(left, result, limit);
  const right = left.summary.variantIds.includes(against) ? result.internals.get(against) : undefined;
  if (!right) return null;
  if (left.entry.format === 'config' || right.entry.format === 'config') return compareConfigs(left, right, result);
  const [leftSide, rightSide] = [sideOf(left), sideOf(right)];
  if (!leftSide || !rightSide) return null;
  for (const r of [left, right]) {
    await assertUnchanged(r.entry.absPath, r.realPath, limit);
    refuseWithheld(r, result.info.display);
  }
  return compareSides(leftSide, rightSide, result.info.limits, limit);
}

// ---------------------------------------------------------------------------
// Uninstall: every scan-time fact re-checked before anything moves
// ---------------------------------------------------------------------------

/**
 * Throws unless this resource may be moved to the trash right now: the shared
 * rule (`uninstallBlocker`), the exact name, the shape the type implies (a
 * skill is one folder, the rest one file), unchanged since the scan, inside its
 * root (never the root itself) and not a credential.
 */
async function assertUninstallable(r: InternalResource, confirmName: string, limit: Limiter): Promise<string> {
  const blocker = uninstallBlocker(r.summary);
  if (blocker) throw new ResourceLookupError(blocker, 403);
  if (confirmName !== r.summary.name) throw new ResourceLookupError('Type the exact name to confirm', 400);
  if (r.entry.kind !== (r.summary.type === 'skill' ? 'package' : 'file')) {
    throw new ResourceLookupError('Not a single folder or file — not removed here', 403);
  }
  if (!r.realPath) throw new ResourceLookupError('Changed since the last scan — rescan', 409);
  await assertUnchanged(r.entry.absPath, r.realPath, limit);
  const rootReal = r.rootReal ?? r.entry.rootAbs;
  if (r.realPath === rootReal || !isWithin(rootReal, r.realPath)) {
    throw new ResourceLookupError('Outside the folder it was found in — not removed', 403);
  }
  if (isCredentialTarget({ rootAbs: r.entry.rootAbs, rootReal, absPath: r.entry.absPath, real: r.realPath })) {
    throw new ResourceLookupError('Credential files are never touched', 403);
  }
  return r.entry.absPath;
}

/** The scan result minus one resource — so nothing stale is served before the rescan lands. */
function withoutResource(out: ScanOutput, id: string): ScanOutput {
  const strip = (s: ResourceSummary): ResourceSummary =>
    (s.variantIds.includes(id) ? { ...s, variantIds: s.variantIds.filter((v) => v !== id) } : s);
  const internals = new Map<string, InternalResource>();
  for (const [key, r] of out.internals) {
    if (key !== id) internals.set(key, r.summary.variantIds.includes(id) ? { ...r, summary: strip(r.summary) } : r);
  }
  return {
    ...out,
    internals,
    resources: out.resources.filter((s) => s.id !== id).map(strip),
    findings: out.findings.filter((f) => f.resourceId !== id),
  };
}

// ---------------------------------------------------------------------------
// Service: scan state + wiring
// ---------------------------------------------------------------------------

export function createResourceCatalog(deps: ResourceCatalogDeps): ResourceCatalogService {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const limit = createLimiter(8);
  // Its own limiter: a compare holds a slot while its fs calls go through `limit`.
  const compareLimit = createLimiter(COMPARE_CONCURRENCY);
  const trashDir = deps.trashDir ?? DEFAULT_TRASH_DIR;
  let meta: Meta = { state: 'idle' };
  let result: ScanOutput | null = null;
  let inFlight: Promise<void> | null = null;
  /** Roots of the scan in flight, and roots requested DURING it (run next, once). */
  let inFlightRoots: readonly string[] = [];
  let queuedRoots: readonly string[] | null = null;

  const initialRoots = (): ResourceRoots => {
    const r = globalRootPaths(env, home);
    const d = (p: string) => displayPath(p, home);
    return { claude: d(r.claudeRoot), codex: d(r.codexRoot), shared: d(r.sharedRoot), repo: null };
  };

  const getCatalog = (): ResourceCatalog => ({
    ...meta,
    roots: { ...(result?.roots ?? initialRoots()), trash: displayPath(trashDir, home) },
    projects: result?.projects ?? [],
    resources: result?.resources ?? [],
    findings: result?.findings ?? [],
    coverage: result?.coverage ?? [],
  });

  const sessionPaths = (): string[] => {
    try {
      const paths = deps.sessionProjectPaths();
      return Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [];
    } catch (err) {
      log.warn('resources', `sessionProjectPaths failed: ${sanitizeError(err, home)}`);
      return [];
    }
  };

  const runScan = async (extraRoots: readonly string[], startedAt: number): Promise<void> => {
    try {
      const out = await scanResources({
        env, home, extraRoots, sessionProjectPaths: sessionPaths(),
        ...(deps.limits ? { limits: deps.limits } : {}),
        onProgress: (progress) => {
          meta = { ...meta, progress };
        },
      });
      const now = Date.now();
      const total = out.resources.length;
      result = out;
      meta = { state: 'ready', startedAt, scannedAt: now, durationMs: now - startedAt, progress: { phase: 'done', done: total, total } };
      log.info('resources', `Scan: ${total} resources, ${out.projects.length} projects in ${now - startedAt} ms`);
    } catch (err) {
      const error = sanitizeError(err, home);
      const { progress: _progress, ...kept } = meta;
      meta = { ...kept, state: 'error', error };
      log.warn('resources', `Scan failed: ${error}`);
    }
  };

  const sameRoots = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && [...a].sort().every((p, i) => p === [...b].sort()[i]);

  /**
   * Starts a scan, or joins the one in flight. A join that asks for DIFFERENT
   * extra roots (a folder added mid-scan) queues exactly one trailing scan with
   * the latest such roots — scans stay strictly sequential, and a user-added
   * folder is never silently dropped. A join that merely repeats the in-flight
   * roots (a stale tab, a Rescan) supersedes nothing: the queued set stays.
   */
  const startScan = (extraRoots: readonly string[] = []): { state: ScanState; progress?: ScanProgress } => {
    const roots = [...extraRoots];
    if (inFlight) {
      if (!sameRoots(roots, inFlightRoots)) queuedRoots = roots;
    } else {
      const startedAt = Date.now();
      const { error: _error, ...kept } = meta;
      meta = { ...kept, state: 'scanning', startedAt, progress: { phase: 'roots', done: 0, total: 1 } };
      inFlightRoots = roots;
      inFlight = runScan(roots, startedAt).finally(() => {
        inFlight = null;
        const next = queuedRoots;
        queuedRoots = null;
        if (next) startScan(next);
      });
    }
    return { state: meta.state, ...(meta.progress ? { progress: meta.progress } : {}) };
  };

  /** Resolves once no scan is running or queued. */
  const whenIdle = async (): Promise<void> => {
    while (inFlight) await inFlight;
  };


  const uninstall = async (id: string, confirmName: string): Promise<UninstallResult> => {
    // A scan in flight may already have listed it and would put it back in the
    // catalog when it lands — the move must wait for a settled result.
    if (inFlight) throw new ResourceLookupError('A scan is running — try again when it finishes', 409);
    const r = result?.internals.get(id);
    if (!result || !r) throw new ResourceLookupError('Resource not found', 404);
    const absPath = await assertUninstallable(r, confirmName, limit);
    const { trashId } = await moveToTrash({
      absPath,
      rootPath: r.entry.rootAbs,
      type: r.summary.type,
      name: r.summary.name,
      display: r.summary.path,
    }, trashDir);
    // Whatever result is current now (a scan may have landed meanwhile) — it must not list it.
    if (result) result = withoutResource(result, id);
    log.info('resources', `Uninstalled ${r.summary.type} ${r.summary.path} → trash ${trashId}`);
    return { trashId, name: r.summary.name, type: r.summary.type, path: r.summary.path };
  };

  const restore = async (trashId: string): Promise<RestoreResult> => {
    const restored = await restoreFromTrash(trashId, trashDir);
    // Restore is clicked within seconds of an uninstall — usually while the
    // rescan it started is still running, which may already have read that
    // folder. The client's own rescan would only JOIN it, so queue one trailing
    // scan with the same roots: the restored item is listed when it lands.
    if (inFlight && !queuedRoots) queuedRoots = [...inFlightRoots];
    log.info('resources', `Restored ${restored.type} ${restored.path} from trash ${trashId}`);
    return restored;
  };

  return {
    getCatalog,
    transferInternals: () => {
      if (inFlight || !result) throw new ResourceLookupError('Finish a scan before transferring', 409);
      return [...result.internals.values()];
    },
    getOrStartCatalog: () => {
      if (meta.state === 'idle' && !inFlight) startScan([]);
      return getCatalog();
    },
    startScan,
    whenIdle,
    getDetail: async (id) => (result ? detailOf(result, id, limit) : null),
    getFile: async (id, relPath) => {
      if (!result) throw new ResourceLookupError('Resource not found', 404);
      return fileOf(result, id, relPath, limit);
    },
    getCompare: (id, against) => compareLimit(async () => (result ? compareOf(result, id, against, limit) : null)),
    uninstall,
    restore,
  };
}

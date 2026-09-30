/**
 * resourceScanner — one read-only scan: discover → list → analyse → compare → check.
 *
 * Runs on the one event loop that also relays terminals and hooks, so every fs
 * call is async and every LEAF call goes through one `createLimiter(16)`: a
 * scan of 80 projects must degrade into "takes a few seconds", never into
 * "terminals stutter".
 *
 * What it learns per resource:
 * - **Symlinks.** The resource path is lstat'ed and realpath'ed. A target
 *   outside the root being scanned is `linked` (a global skill that is really
 *   owned by another repo) — and a single FILE out there is listed and hashed
 *   but never read for display; a dangling link is reported and never hashed.
 * - **Content hash.** A file hashes its bytes; a package hashes
 *   `sorted(relPath \0 fileHash \n)` so the result is independent of walk order
 *   and of `.git`/`node_modules` clutter; a config-format resource is an HMAC
 *   under a per-process key (of its file, or of a key-sorted JSON of its raw
 *   value), never a plain digest of values the catalog masks. The same
 *   function hashes the agent-skills repo copy, which is what makes
 *   `same`/`differs` meaningful.
 * - **Frontmatter** from the first 64 KB, parsed as YAML data (never executed).
 *
 * Checks are deterministic and derived from the whole set afterwards:
 * variants (the same skill/command/instructions under another agent), shadowing
 * duplicates, repo drift, orphaned memory.
 */
import { randomBytes } from 'crypto';
import { lstat, readlink, realpath, stat } from 'fs/promises';
import { dirname, join, relative, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import type { CoverageEntry, FindingCode, FindingSeverity, ResourceFinding, ResourceProject, ResourceRoots, ResourceSummary, ResourceType, ScanProgress } from '../src/types/resources.js';
import { createLimiter, displayPath, hashFile, hmacFile, hmacText, isCredentialPath, isCredentialTarget, isWithin, listDir, listFlatFiles, listTree, packageHash, readConfigFile, readTextCapped, resolveWithin, stableStringify, statKind, walkPackage } from './fsSafe.js';
import type { Limiter, PackageFile, PackageLimits } from './fsSafe.js';
import { adaptClaudeGlobal, adaptCodexGlobal, adaptProject, adaptSharedGlobal, type AdapterContext, type AdapterResult, type RawEntry } from './resourceAdapters.js';
import { redactSecretsInString } from './resourceMask.js';
import { discoverProjects, resolveGlobalRoots, toResourceProject, type GlobalRoots, type ProjectRecord } from './resourceRoots.js';

export interface ScanLimits extends PackageLimits {
  projectMaxDirents: number;
  nestedDepth: number;
  treeMaxDepth: number;
  treeMaxFiles: number;
  sizeMaxEntries: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  packageMaxFiles: 2_000,
  packageMaxBytes: 64 * 1024 * 1024,
  packageMaxDepth: 12,
  packageMaxDirs: 2_000,
  projectMaxDirents: 20_000,
  nestedDepth: 3,
  treeMaxDepth: 8,
  treeMaxFiles: 5_000,
  sizeMaxEntries: 200_000,
};

/** Frontmatter and the hardcoded-home-path check read at most this much of a file. */
export const HEAD_READ_BYTES = 64 * 1024;
/**
 * Config-format hashes are HMACs under this per-process key: a config holds
 * values the catalog masks, and a plain sha256 of it would let anyone with the
 * catalog confirm a guessed password offline. Config items are only ever
 * compared with each other within one scan, so a key that dies with the
 * process costs nothing.
 */
const CONFIG_HASH_KEY = randomBytes(32);
const DESCRIPTION_MAX = 300;

/** Everything the catalog needs to answer detail/file/compare — absolute paths, never serialised. */
export interface InternalResource {
  entry: RawEntry;
  summary: ResourceSummary;
  /** Symlink-free path of the file or package at scan time; absent when broken or a credential. */
  realPath?: string;
  /** realpath of `entry.rootAbs` at scan time — confinement and credential checks are judged against it. */
  rootReal?: string;
  /** SKILL.md for a package, the file itself otherwise. */
  mainFile?: string;
  files?: PackageFile[];
  /** The agent-skills copy, when the repo tracks this item and has one — and its realpath at scan time. */
  repoAbs?: string;
  repoReal?: string;
  /** The repo package's files as walked at scan time — a compare reuses them instead of re-walking. */
  repoFiles?: PackageFile[];
}

export interface ScanInfo {
  home: string;
  homeReal: string;
  roots: GlobalRoots;
  limits: ScanLimits;
  display: (absPath: string) => string;
}

export interface ScanOutput {
  roots: ResourceRoots;
  projects: ResourceProject[];
  resources: ResourceSummary[];
  findings: ResourceFinding[];
  coverage: CoverageEntry[];
  internals: ReadonlyMap<string, InternalResource>;
  info: ScanInfo;
}

export interface ScanOptions {
  env: NodeJS.ProcessEnv;
  home: string;
  sessionProjectPaths: readonly string[];
  extraRoots: readonly string[];
  onProgress?: (progress: ScanProgress) => void;
  limits?: Partial<ScanLimits>;
  concurrency?: number;
}

interface ScanCtx {
  limit: Limiter;
  limits: ScanLimits;
  display: (absPath: string) => string;
  homeRe: RegExp | null;
  rootReal: (rootAbs: string) => Promise<string>;
}

interface Analysis {
  internal: InternalResource;
  findings: ResourceFinding[];
}

const SEVERITY: Record<FindingCode, FindingSeverity> = {
  'config-parse-error': 'error',
  'frontmatter-invalid': 'warning', 'frontmatter-missing': 'warning', 'name-mismatch': 'warning',
  'duplicate-name': 'warning', 'broken-symlink': 'warning', 'orphaned-memory': 'warning',
  'linked-outside': 'info', 'variant-differs': 'info', 'repo-differs': 'info', 'not-in-repo': 'info',
  'repo-only': 'info', 'hardcoded-home-path': 'info', 'hash-capped': 'info',
};

const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };

function finding(code: FindingCode, message: string, target: { resourceId: string } | { path: string }): ResourceFinding {
  return { code, severity: SEVERITY[code], ...target, message };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Frontmatter (exported: the catalog parses a body's frontmatter for the detail view)
// ---------------------------------------------------------------------------

export interface Frontmatter {
  hasBlock: boolean;
  data?: Record<string, unknown>;
  error?: string;
  errorLine?: number;
  /** The block's source, for the lenient fallback when it is not strict YAML. */
  raw?: string;
  body: string;
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** `---\n…\n---` at the very top, parsed as YAML DATA (core schema: no tags that construct code). */
export function parseFrontmatter(text: string): Frontmatter {
  const source = text.replace(/^﻿/, '');
  const m = FRONTMATTER_RE.exec(source);
  if (!m) return { hasBlock: false, body: source };
  const body = source.slice(m[0].length);
  const raw = m[1] ?? '';
  try {
    const parsed: unknown = parseYaml(raw, { logLevel: 'error' });
    if (parsed === null || parsed === undefined) return { hasBlock: true, data: {}, raw, body };
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { hasBlock: true, error: 'Frontmatter is not a key/value map', raw, body };
    }
    return { hasBlock: true, data: parsed as Record<string, unknown>, raw, body };
  } catch (err) {
    const linePos = (err as { linePos?: Array<{ line: number }> }).linePos;
    const message = err instanceof Error ? err.message.split('\n')[0].slice(0, 300) : 'Invalid YAML';
    return { hasBlock: true, error: message, ...(linePos?.[0] ? { errorLine: linePos[0].line + 1 } : {}), raw, body };
  }
}

/**
 * `key: value` read line by line (block scalars `>`/`|` joined) — how Claude
 * Code itself reads a frontmatter that is not strict YAML. An unquoted
 * `description: Use when: …` is invalid YAML (and still reported as such) but
 * works in the CLI, so its description should still show.
 */
function lenientField(raw: string, key: string): string | undefined {
  const lines = raw.split('\n').map((l) => l.replace(/\r$/, ''));
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at < 0) return undefined;
  const first = lines[at].slice(key.length + 1).trim();
  if (!/^[>|][+-]?[1-9]?$/.test(first)) return first.replace(/^(["'])(.*)\1$/, '$2');
  const block: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    block.push(line.trim());
  }
  return block.filter(Boolean).join(' ');
}

/** Frontmatter made JSON-safe: Dates → ISO, bigints → strings, functions dropped, cycles cut. */
export function jsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 20) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, depth + 1)).filter((v) => v !== undefined);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, jsonSafe(v, depth + 1)] as const)
      .filter(([, v]) => v !== undefined));
  }
  return undefined;
}

function descriptionOf(fm: Frontmatter): string | undefined {
  const value = fm.error && fm.raw !== undefined ? lenientField(fm.raw, 'description') : fm.data?.description;
  if (value === undefined || value === null || typeof value === 'object') return undefined;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? redactSecretsInString(text.slice(0, DESCRIPTION_MAX)) : undefined;
}

// ---------------------------------------------------------------------------
// Per-resource analysis
// ---------------------------------------------------------------------------

function baseSummary(entry: RawEntry, display: (abs: string) => string): ResourceSummary {
  return {
    id: entry.id,
    type: entry.type,
    agent: entry.agent,
    scope: entry.scope,
    origin: entry.origin,
    format: entry.format,
    name: entry.name,
    ...(entry.description ? { description: redactSecretsInString(entry.description) } : {}),
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    path: display(entry.absPath),
    ...(entry.pluginName ? { pluginName: entry.pluginName } : {}),
    fileCount: 1,
    bytes: 0,
    mtimeMs: 0,
    repo: { status: 'not-tracked' },
    variantIds: [],
    ...(entry.orphaned ? { orphaned: true } : {}),
    findingCodes: [],
  };
}

async function analyseConfigEntry(entry: RawEntry, sc: ScanCtx): Promise<Analysis> {
  const text = stableStringify(entry.hashInput ?? entry.config?.value ?? null);
  const st = await sc.limit(() => stat(entry.absPath)).catch(() => null);
  const summary = {
    ...baseSummary(entry, sc.display),
    bytes: Buffer.byteLength(text),
    hash: hmacText(CONFIG_HASH_KEY, text),
    mtimeMs: st?.mtimeMs ?? 0,
  };
  return { internal: { entry, summary }, findings: [] };
}

interface LinkInfo {
  isSymlink: boolean;
  real: string | null;
  /** realpath of the root the entry was listed under. */
  rootReal: string;
  outside: boolean;
  target?: string;
}

async function linkInfo(entry: RawEntry, sc: ScanCtx): Promise<LinkInfo | null> {
  const st = await sc.limit(() => lstat(entry.absPath)).catch(() => null);
  if (!st) return null; // vanished between listing and analysis
  const real = await sc.limit(() => realpath(entry.absPath)).catch(() => null);
  const rootReal = await sc.rootReal(entry.rootAbs);
  if (!real) {
    const text = st.isSymbolicLink() ? await sc.limit(() => readlink(entry.absPath)).catch(() => '') : '';
    return { isSymlink: st.isSymbolicLink(), real: null, rootReal, outside: false, ...(text ? { target: resolve(dirname(entry.absPath), text) } : {}) };
  }
  return { isSymlink: st.isSymbolicLink(), real, rootReal, outside: !isWithin(rootReal, real), target: real };
}

async function contentChecks(entry: RawEntry, mainFile: string, sc: ScanCtx): Promise<{ description?: string; findings: ResourceFinding[] }> {
  const head = await readTextCapped(mainFile, HEAD_READ_BYTES).catch(() => null);
  if (!head?.content) return { findings: [] };
  const target = { resourceId: entry.id };
  const found: ResourceFinding[] = [];
  let description: string | undefined;
  if (entry.format === 'markdown') {
    const fm = parseFrontmatter(head.content);
    description = descriptionOf(fm);
    if (fm.error) {
      found.push(finding('frontmatter-invalid', `Frontmatter is not valid YAML${fm.errorLine ? ` (line ${fm.errorLine})` : ''}`, target));
    } else if (entry.type === 'skill' && !entry.notASkill) {
      const name = fm.data?.name;
      if (!fm.hasBlock || !name || !fm.data?.description) {
        found.push(finding('frontmatter-missing', 'SKILL.md has no frontmatter name and description', target));
      }
      if (typeof name === 'string' && name && name !== entry.name) {
        found.push(finding('name-mismatch', `Folder "${entry.name}" but frontmatter name "${redactSecretsInString(name)}"`, target));
      }
    }
  }
  // Memory is machine-local by nature; a home path in it is not a portability problem.
  if (sc.homeRe && entry.type !== 'memory' && sc.homeRe.test(head.content)) {
    found.push(finding('hardcoded-home-path', 'Contains this machine\'s home directory path', target));
  }
  return { ...(description ? { description } : {}), findings: found };
}

/**
 * SKILL.md of a package, only if it resolves INSIDE the package and is not a
 * credential: a `SKILL.md -> ~/.codex/auth.json` link must never become a body.
 */
async function packageMainFile(realRoot: string, sc: ScanCtx): Promise<string | undefined> {
  try {
    const resolved = await sc.limit(() => resolveWithin(realRoot, 'SKILL.md'));
    return isCredentialPath(relative(realRoot, resolved)) ? undefined : resolved;
  } catch {
    return undefined;
  }
}

interface Measured {
  fields: Partial<ResourceSummary>;
  internal: Omit<InternalResource, 'entry' | 'summary'>;
  findings: ResourceFinding[];
}

async function measurePackage(entry: RawEntry, real: string, sc: ScanCtx): Promise<Measured> {
  const walk = await walkPackage(real, sc.limits, sc.limit);
  const hash = walk.capped ? undefined : packageHash(walk.files);
  const mainFile = entry.notASkill ? undefined : await packageMainFile(real, sc);
  const { packageMaxFiles: files, packageMaxBytes: bytes, packageMaxDepth: depth, packageMaxDirs: dirs } = sc.limits;
  const capped = `Over ${files.toLocaleString('en-US')} files, ${Math.round(bytes / 1048576)} MB, ${depth} folder levels or ${dirs.toLocaleString('en-US')} folders — not hashed`;
  return {
    fields: { fileCount: walk.files.length, bytes: walk.bytes, mtimeMs: walk.mtimeMs, ...(hash ? { hash } : {}) },
    internal: { realPath: real, rootReal: await sc.rootReal(entry.rootAbs), files: walk.files, ...(mainFile ? { mainFile } : {}) },
    findings: walk.capped ? [finding('hash-capped', capped, { resourceId: entry.id })] : [],
  };
}

/**
 * A single file. One that resolves to a credential (a `commands/x.md` link into
 * `secrets/`, a `hooks/deploy.pem`) is listed by name and size only: no hash,
 * no main file — so no detail, compare or content check ever opens it.
 */
async function measureFile(entry: RawEntry, link: LinkInfo & { real: string }, sc: ScanCtx): Promise<Measured> {
  const { real, rootReal } = link;
  const st = await sc.limit(() => stat(real)).catch(() => null);
  if (!st) return { fields: {}, internal: {}, findings: [] };
  const meta = { bytes: st.size, mtimeMs: st.mtimeMs };
  if (!st.isFile() || isCredentialTarget({ rootAbs: entry.rootAbs, rootReal, absPath: entry.absPath, real })) {
    return { fields: meta, internal: {}, findings: [] };
  }
  const digest = entry.format === 'config' ? () => hmacFile(CONFIG_HASH_KEY, real) : async () => (await hashFile(real)).sha256;
  const hash = await sc.limit(digest).catch(() => undefined);
  // A file that resolves OUTSIDE its root keeps its row and hash but gets no
  // main file: nothing reads it for display (no description, detail body or
  // compare) — a `commands/x.md` link must not turn any file on disk into a body.
  const shown = entry.format === 'config' || !link.outside;
  return { fields: { ...meta, ...(hash ? { hash } : {}) }, internal: { realPath: real, rootReal, ...(shown ? { mainFile: real } : {}) }, findings: [] };
}

async function analysePath(entry: RawEntry, sc: ScanCtx): Promise<Analysis | null> {
  const link = await linkInfo(entry, sc);
  if (!link) return null;
  const target = { resourceId: entry.id };
  const summary = baseSummary(entry, sc.display);
  if (!link.real) {
    const where = link.target ? ` → ${sc.display(link.target)}` : '';
    return {
      internal: { entry, summary: { ...summary, fileCount: 0, ...(link.target ? { linkTarget: sc.display(link.target) } : {}) } },
      findings: [finding('broken-symlink', `Symlink does not resolve${where}`, target)],
    };
  }
  const resolved = { ...link, real: link.real };
  const measured = entry.kind === 'package' ? await measurePackage(entry, link.real, sc) : await measureFile(entry, resolved, sc);
  // A config file that resolves to a credential keeps no parsed value either.
  const kept = entry.kind === 'config-file' && !measured.internal.realPath ? { ...entry, config: undefined } : entry;
  const withheld = link.outside && entry.kind !== 'package' && entry.format !== 'config'
    ? ` — its content is not shown here: only files inside ${sc.display(entry.rootAbs)} are read` : '';
  const findings = link.outside
    ? [finding('linked-outside', `Resolves outside ${sc.display(entry.rootAbs)}: ${sc.display(link.real)}${withheld}`, target)] : [];
  const main = measured.internal.mainFile;
  const content = main && entry.format !== 'config' ? await contentChecks(entry, main, sc) : { findings: [] };
  return {
    internal: {
      entry: kept,
      ...measured.internal,
      summary: {
        ...summary,
        ...measured.fields,
        origin: link.outside && entry.origin === 'user' ? 'linked' : entry.origin,
        ...(content.description ? { description: content.description } : {}),
        ...((link.outside || link.isSymlink) && link.target ? { linkTarget: sc.display(link.target) } : {}),
      },
    },
    findings: [...findings, ...measured.findings, ...content.findings],
  };
}

function analyse(entry: RawEntry, sc: ScanCtx): Promise<Analysis | null> {
  return entry.kind === 'config-entry' ? analyseConfigEntry(entry, sc) : analysePath(entry, sc);
}

// ---------------------------------------------------------------------------
// Repo compare
// ---------------------------------------------------------------------------

interface RepoItem {
  rel: string;
  abs: string;
  kind: 'package' | 'file';
}

async function repoItems(repo: string, sc: ScanCtx): Promise<RepoItem[]> {
  const skills = async (sub: string): Promise<RepoItem[]> => {
    const listing = await listDir(join(repo, sub), sc.limit);
    if (listing.status !== 'ok') return [];
    const dirs = await Promise.all(listing.entries.filter((d) => !d.name.startsWith('.')).map(async (d): Promise<RepoItem | null> => {
      const abs = join(repo, sub, d.name);
      if ((await statKind(abs, sc.limit)) !== 'dir') return null;
      const isSkill = d.name === '_shared' || (await statKind(join(abs, 'SKILL.md'), sc.limit)) === 'file';
      return isSkill ? { rel: `${sub}/${d.name}`, abs, kind: 'package' as const } : null;
    }));
    return dirs.filter((d): d is RepoItem => d !== null);
  };
  const tree = async (sub: string, re: RegExp): Promise<RepoItem[]> =>
    (await listTree(join(repo, sub), sc.limit, { accept: (n) => re.test(n), maxDepth: sc.limits.treeMaxDepth, maxFiles: sc.limits.treeMaxFiles }))
      .files.map((f) => ({ rel: `${sub}/${f.rel}`, abs: f.abs, kind: 'file' as const }));
  const flat = async (sub: string, re: RegExp): Promise<RepoItem[]> =>
    (await listFlatFiles(join(repo, sub), sc.limit, (n) => re.test(n)))
      .files.map((f) => ({ rel: `${sub}/${f.name}`, abs: f.abs, kind: 'file' as const }));
  const agentsMd = (await statKind(join(repo, 'codex', 'AGENTS.md'), sc.limit)) === 'file'
    ? [{ rel: 'codex/AGENTS.md', abs: join(repo, 'codex', 'AGENTS.md'), kind: 'file' as const }] : [];
  const groups = await Promise.all([
    skills('claude/skills'), tree('claude/commands', /\.md$/i), tree('claude/rules', /\.md$/i), flat('claude/hooks', /./),
    skills('codex/skills'), flat('codex/prompts', /\.md$/i), flat('codex/rules', /\.rules$/i),
  ]);
  return [...groups.flat(), ...agentsMd];
}

/** Hash a repo item exactly as a live one is hashed — the only way same/differs can mean anything. */
async function repoCopy(item: RepoItem, sc: ScanCtx): Promise<{ hash?: string; real?: string; files?: PackageFile[] }> {
  try {
    const real = await sc.limit(() => realpath(item.abs));
    if (item.kind === 'file') return { real, hash: (await sc.limit(() => hashFile(real))).sha256 };
    const walk = await walkPackage(real, sc.limits, sc.limit);
    const hash = walk.capped ? undefined : packageHash(walk.files);
    return { real, files: walk.files, ...(hash ? { hash } : {}) };
  } catch {
    return {};
  }
}

interface RepoOutcome {
  internals: InternalResource[];
  findings: ResourceFinding[];
  coverage: CoverageEntry[];
}

function noRepo(internals: readonly InternalResource[], roots: GlobalRoots, sc: ScanCtx): RepoOutcome {
  const where = sc.display(join(roots.home, 'Documents', 'agent-skills'));
  const note = 'no agent-skills repo detected — repo compare disabled';
  return {
    internals: [...internals],
    findings: [],
    coverage: (['claude', 'codex'] as const).map((agent) => ({ root: where, agent, category: 'skill' as const, status: 'not-found' as const, note })),
  };
}

const REPO_CATEGORIES = [
  ['claude', 'skill', 'claude/skills/'], ['claude', 'command', 'claude/commands/'], ['claude', 'rule', 'claude/rules/'],
  ['claude', 'hook', 'claude/hooks/'], ['codex', 'skill', 'codex/skills/'], ['codex', 'command', 'codex/prompts/'],
  ['codex', 'rule', 'codex/rules/'], ['codex', 'instructions', 'codex/AGENTS.md'],
] as const;

function repoCoverage(items: readonly RepoItem[], repo: string, sc: ScanCtx): CoverageEntry[] {
  return REPO_CATEGORIES.map(([agent, category, prefix]) => {
    const count = items.filter((i) => i.rel.startsWith(prefix)).length;
    return { root: sc.display(repo), agent, category, status: count ? 'scanned' : 'empty', count, note: 'agent-skills repo — read-only compare' };
  });
}

/**
 * Live global items the repo mirrors get `same` / `differs` / `not-in-repo`;
 * repo items nobody claimed become `repo-only` findings (by path — there is no
 * live resource to hang them on).
 */
async function compareRepo(
  internals: readonly InternalResource[],
  roots: GlobalRoots,
  sc: ScanCtx,
  report: (done: number, total: number) => void,
): Promise<RepoOutcome> {
  const repo = roots.repo;
  if (!repo) return noRepo(internals, roots, sc);
  const items = await repoItems(repo, sc);
  let done = 0;
  const byRel = new Map(await Promise.all(items.map(async (item) => {
    const copy = await repoCopy(item, sc);
    report(++done, items.length);
    return [item.rel, { item, ...copy }] as const;
  })));
  const findings: ResourceFinding[] = [];
  const updated = internals.map((r): InternalResource => {
    const rel = r.entry.scope === 'global' ? r.entry.repoRel : undefined;
    const counterpart = rel ? byRel.get(rel) : undefined;
    const target = { resourceId: r.entry.id };
    if (!rel) return r;
    if (!counterpart) {
      findings.push(finding('not-in-repo', `The agent-skills repo has no ${rel}`, target));
      return { ...r, summary: { ...r.summary, repo: { status: 'not-in-repo' } } };
    }
    const same = r.summary.hash !== undefined && r.summary.hash === counterpart.hash;
    if (!same) findings.push(finding('repo-differs', `Differs from ${sc.display(counterpart.item.abs)}`, target));
    return {
      ...r,
      repoAbs: counterpart.item.abs,
      ...(counterpart.real ? { repoReal: counterpart.real } : {}),
      ...(counterpart.files ? { repoFiles: counterpart.files } : {}),
      summary: { ...r.summary, repo: { status: same ? 'same' : 'differs', path: sc.display(counterpart.item.abs) } },
    };
  });
  const claimed = new Set(internals.map((r) => (r.entry.scope === 'global' ? r.entry.repoRel : undefined)));
  const repoOnly = items
    .filter((i) => !claimed.has(i.rel))
    .map((i) => finding('repo-only', `Only in the agent-skills repo (no live ${i.rel.split('/').slice(0, 2).join('/')} copy)`, { path: sc.display(i.abs) }));
  return { internals: updated, findings: [...findings, ...repoOnly], coverage: repoCoverage(items, repo, sc) };
}

// ---------------------------------------------------------------------------
// Checks: variants, duplicates, orphaned memory
// ---------------------------------------------------------------------------

const AGENT_LABEL = { claude: 'Claude', codex: 'Codex', shared: 'shared' } as const;

function variantKey(e: RawEntry): string | null {
  if (e.type === 'instructions') return e.variantGroup ? `instructions|${e.variantGroup}` : null;
  if (e.type !== 'skill' && e.type !== 'command') return null; // rules are never paired
  if (e.origin === 'plugin' || e.origin === 'system') return null; // not the user's copies to keep in sync
  return `${e.type}|${e.scope}|${e.projectId ?? ''}|${e.name}`;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string | null): Map<string, T[]> {
  return items.reduce((acc, item) => {
    const k = key(item);
    return k === null ? acc : acc.set(k, [...(acc.get(k) ?? []), item]);
  }, new Map<string, T[]>());
}

function applyVariants(internals: readonly InternalResource[]): { internals: InternalResource[]; findings: ResourceFinding[] } {
  const groups = groupBy(internals, (r) => variantKey(r.entry));
  const variantsOf = new Map<string, InternalResource[]>();
  for (const members of groups.values()) {
    for (const m of members) {
      const others = members.filter((o) => o.entry.agent !== m.entry.agent);
      if (others.length) variantsOf.set(m.entry.id, others);
    }
  }
  const findings: ResourceFinding[] = [];
  const updated = internals.map((r) => {
    const others = variantsOf.get(r.entry.id);
    if (!others) return r;
    const differing = others.filter((o) => o.summary.hash && r.summary.hash && o.summary.hash !== r.summary.hash);
    for (const o of differing) {
      findings.push(finding('variant-differs', `Differs from the ${AGENT_LABEL[o.entry.agent]} copy at ${o.summary.path}`, { resourceId: r.entry.id }));
    }
    return { ...r, summary: { ...r.summary, variantIds: others.map((o) => o.entry.id) } };
  });
  return { internals: updated, findings };
}

/** Types whose same-named items shadow each other; hooks/settings/memory repeat names by design. */
const SHADOWING_TYPES = new Set<ResourceType>(['skill', 'command', 'agent', 'mcp']);

function duplicateFindings(internals: readonly InternalResource[]): ResourceFinding[] {
  const eligible = internals.filter((r) => SHADOWING_TYPES.has(r.entry.type) && r.entry.origin !== 'plugin');
  const groups = groupBy(eligible, (r) => `${r.entry.agent}|${r.entry.type}|${r.entry.name}`);
  // Two project items in DIFFERENT projects never load together, so they do not collide.
  const coexist = (a: RawEntry, b: RawEntry) => !(a.scope === 'project' && b.scope === 'project' && a.projectId !== b.projectId);
  return [...groups.values()].flatMap((members) => members.flatMap((m) => {
    const others = members.filter((o) => o !== m && coexist(m.entry, o.entry));
    return others.length
      ? [finding('duplicate-name', `Same name as ${others.map((o) => o.summary.path).join(', ')}`, { resourceId: m.entry.id })]
      : [];
  }));
}

function orphanFindings(internals: readonly InternalResource[]): ResourceFinding[] {
  return internals
    .filter((r) => r.entry.orphaned)
    .map((r) => finding('orphaned-memory', 'Filed under a project folder that no longer exists', { resourceId: r.entry.id }));
}

function sortFindings(findings: readonly ResourceFinding[]): ResourceFinding[] {
  const key = (f: ResourceFinding) => f.resourceId ?? f.path ?? '';
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || a.code.localeCompare(b.code) || key(a).localeCompare(key(b)));
}

function withFindingCodes(internals: readonly InternalResource[], findings: readonly ResourceFinding[]): InternalResource[] {
  const codes = findings.reduce((acc, f) => (f.resourceId ? acc.set(f.resourceId, [...(acc.get(f.resourceId) ?? []), f.code]) : acc), new Map<string, FindingCode[]>());
  return internals.map((r) => ({ ...r, summary: { ...r.summary, findingCodes: [...new Set(codes.get(r.entry.id) ?? [])] } }));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** One in-flight/settled promise per key — a config, realpath or lookup is resolved once per scan. */
function memoize<T>(fn: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (key) => {
    const hit = cache.get(key) ?? fn(key);
    cache.set(key, hit);
    return hit;
  };
}

function memoizedConfigReader(limit: Limiter): AdapterContext['readConfig'] {
  const read = memoize((key) => {
    const [kind, ...rest] = key.split(':');
    return limit(() => readConfigFile(rest.join(':'), kind as 'json' | 'toml'));
  });
  return (absPath, kind) => read(`${kind}:${absPath}`);
}

function projectLookup(projects: readonly ProjectRecord[], limit: Limiter): (p: string) => Promise<string | undefined> {
  return memoize(async (p) => {
    const real = await limit(() => realpath(p)).catch(() => resolve(p));
    return projects.find((x) => x.absPath === real || x.absPath === resolve(p))?.id;
  });
}

async function runAdapters(ctx: AdapterContext, report: (done: number, total: number) => void): Promise<AdapterResult> {
  const total = 3 + ctx.projects.length;
  let done = 0;
  const tick = <T>(p: Promise<T>): Promise<T> => p.then((v) => {
    report(++done, total);
    return v;
  });
  const globals = await Promise.all([tick(adaptClaudeGlobal(ctx)), tick(adaptCodexGlobal(ctx)), tick(adaptSharedGlobal(ctx))]);
  const jsonMcp = globals[0].entries.filter((e) => e.type === 'mcp' && e.scope === 'project' && e.projectId && e.absPath === ctx.roots.claudeConfigJson);
  const withCounts: AdapterContext = {
    ...ctx,
    claudeJsonMcpCount: (id) => jsonMcp.filter((e) => e.projectId === id).length,
  };
  const projects = await Promise.all(ctx.projects.map((p) => tick(adaptProject(p, withCounts))));
  const all = [...globals, ...projects];
  return {
    entries: all.flatMap((r) => r.entries),
    coverage: all.flatMap((r) => r.coverage),
    findings: all.flatMap((r) => r.findings),
  };
}

/** First listing wins if two routes reach the same resource (same type, agent and path). */
function uniqueById(entries: readonly RawEntry[]): RawEntry[] {
  const firstIndex = new Map<string, number>();
  entries.forEach((e, i) => {
    if (!firstIndex.has(e.id)) firstIndex.set(e.id, i);
  });
  return entries.filter((e, i) => firstIndex.get(e.id) === i);
}

function projectCounts(summaries: readonly ResourceSummary[]): Map<string, Partial<Record<ResourceType, number>>> {
  return summaries.reduce((acc, s) => {
    if (!s.projectId) return acc;
    const counts = acc.get(s.projectId) ?? {};
    return acc.set(s.projectId, { ...counts, [s.type]: (counts[s.type] ?? 0) + 1 });
  }, new Map<string, Partial<Record<ResourceType, number>>>());
}

type Progress = (phase: ScanProgress['phase']) => (done: number, total: number) => void;

/** Phase `roots`: global roots, the two configs discovery needs, and the project list. */
async function discover(opts: ScanOptions, limit: Limiter, limits: ScanLimits, progress: Progress): Promise<AdapterContext> {
  progress('roots')(0, 1);
  const roots = await resolveGlobalRoots(opts.env, opts.home);
  const display = (abs: string) => displayPath(abs, roots.home, roots.homeReal);
  const readConfig = memoizedConfigReader(limit);
  const [claudeJson, codexConfig] = await Promise.all([
    readConfig(roots.claudeConfigJson, 'json'),
    readConfig(join(roots.codexRoot, 'config.toml'), 'toml'),
  ]);
  const discovery = await discoverProjects({
    roots, claudeJson, codexConfig, sessionProjectPaths: opts.sessionProjectPaths, extraRoots: opts.extraRoots, limit,
  });
  progress('roots')(1, 1);
  return {
    roots, display, limit, readConfig, limits,
    projects: discovery.projects,
    encodedToProject: discovery.encodedToProject,
    projectIdFor: projectLookup(discovery.projects, limit),
  };
}

/** Phase `hashing`: lstat/realpath, hash, frontmatter for every listed entry. */
async function analyseAll(entries: readonly RawEntry[], sc: ScanCtx, report: (done: number, total: number) => void): Promise<Analysis[]> {
  let done = 0;
  const analysed = await Promise.all(entries.map(async (e) => {
    // Last line of defence: an fs error nobody anticipated costs this entry its
    // hash, never the whole scan (a failed scan would blank the tab).
    const a = await analyse(e, sc).catch((): Analysis => ({ internal: { entry: e, summary: baseSummary(e, sc.display) }, findings: [] }));
    report(++done, entries.length);
    return a;
  }));
  return analysed.filter((a): a is Analysis => a !== null);
}

function homeRegExp(roots: GlobalRoots): RegExp | null {
  const homes = [...new Set([roots.home, roots.homeReal])].filter((h) => h.length > 1);
  return homes.length ? new RegExp(`(?:${homes.map(escapeRegExp).join('|')})(?![A-Za-z0-9._-])`) : null;
}

/** One full read-only scan. Never throws for a single unreadable file — only for a broken invariant. */
export async function scanResources(opts: ScanOptions): Promise<ScanOutput> {
  const limits: ScanLimits = { ...DEFAULT_SCAN_LIMITS, ...opts.limits };
  const limit = createLimiter(opts.concurrency ?? 16);
  const progress: Progress = (phase) => (done, total) => opts.onProgress?.({ phase, done, total });

  const ctx = await discover(opts, limit, limits, progress);
  const { roots, display } = ctx;
  const adapted = await runAdapters(ctx, progress('resources'));
  const rootReal = memoize((p) => limit(() => realpath(p)).catch(() => resolve(p)));
  const sc: ScanCtx = { limit, limits, display, homeRe: homeRegExp(roots), rootReal };
  const analysed = await analyseAll(uniqueById(adapted.entries), sc, progress('hashing'));
  const repo = await compareRepo(analysed.map((a) => a.internal), roots, sc, progress('repo'));

  progress('checks')(0, 1);
  const variants = applyVariants(repo.internals);
  const findings = sortFindings([
    ...adapted.findings,
    ...analysed.flatMap((a) => a.findings),
    ...repo.findings,
    ...variants.findings,
    ...duplicateFindings(variants.internals),
    ...orphanFindings(variants.internals),
  ]);
  const internals = withFindingCodes(variants.internals, findings);
  const resources = internals.map((r) => r.summary);
  const counts = projectCounts(resources);
  progress('checks')(1, 1);
  progress('done')(resources.length, resources.length);

  return {
    roots: { claude: display(roots.claudeRoot), codex: display(roots.codexRoot), shared: display(roots.sharedRoot), repo: roots.repo ? display(roots.repo) : null },
    projects: ctx.projects.map((p) => toResourceProject(p, display, counts.get(p.id) ?? {})),
    resources,
    findings,
    coverage: [...adapted.coverage, ...repo.coverage],
    internals: new Map(internals.map((r) => [r.entry.id, r])),
    info: { home: roots.home, homeReal: roots.homeReal, roots, limits, display },
  };
}

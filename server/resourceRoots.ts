/**
 * resourceRoots — where the RESOURCES tab looks, and which folders are projects.
 *
 * Global roots come from the same env vars the CLIs themselves honour
 * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) — hardcoding `~/.claude` would silently
 * scan the wrong tree on an overridden setup, exactly the bug commandIndex.ts
 * once had for `$CODEX_HOME/skills`.
 *
 * Projects are a UNION of five sources, merged by realpath, because each alone
 * is lossy:
 * 1. `~/.claude/projects/<encoded>` — every non-alphanumeric character became
 *    `-`, so `/a/b-c`, `/a/b/c` and `/a/b.c` all encode alike. Decoded by a
 *    filesystem-guided DFS from `/`; every real match is kept. No match means
 *    the folder is gone — kept as `exists:false`, because its memory still
 *    sits on disk and is now orphaned.
 * 2. `~/.claude.json` `projects` keys and 3. Codex `config.toml` `projects`
 *    keys — exact paths, but possibly symlinks or long deleted.
 * 4. Sessions AASC knows about. 5. Folders added by hand.
 *
 * The global roots are never projects even when a CLI was once launched in
 * them, and `~` itself is flagged `isHome` so only its own CLAUDE.md/AGENTS.md
 * are read — its dot-dirs ARE the global roots and would be counted twice.
 */
import { readdir, readFile, lstat, realpath, stat } from 'fs/promises';
import { basename, isAbsolute, join, resolve } from 'path';
import type { DiscoveryEvidence, ResourceProject, ResourceType } from '../src/types/resources.js';
import { listDir, sha1Hex, type ConfigRead, type Limiter } from './fsSafe.js';

export interface GlobalRoots {
  home: string;
  /** realpath(home) — differs from `home` on macOS temp dirs (/var → /private/var). */
  homeReal: string;
  claudeRoot: string;
  /** `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that is set. */
  claudeConfigJson: string;
  codexRoot: string;
  sharedRoot: string;
  /** The agent-skills repository, or null (repo compare disabled). */
  repo: string | null;
}

/** Internal project record — absolute paths, never sent to a client as-is. */
export interface ProjectRecord {
  id: string;
  name: string;
  /** realpath for an existing project; the resolved path for a missing one. */
  absPath: string;
  realPath: string;
  exists: boolean;
  /**
   * The folder could not be looked at (EACCES/EPERM on the way to it). Not
   * missing: its memory is not orphaned, and it is reported, not scanned.
   */
  inaccessible?: boolean;
  evidence: DiscoveryEvidence[];
  isHome?: boolean;
  /** Absolute path of the main checkout, for a linked git worktree. */
  worktreeOf?: string;
  duplicateName?: boolean;
  /** `~/.claude/projects/<encoded>` dir names attributed to this project. */
  encodedDirs: string[];
}

export interface DiscoveryInput {
  roots: GlobalRoots;
  claudeJson: ConfigRead;
  codexConfig: ConfigRead;
  sessionProjectPaths: readonly string[];
  extraRoots: readonly string[];
  limit?: Limiter;
}

export interface DiscoveryResult {
  projects: ProjectRecord[];
  /** Encoded dir name → id of the project its memory belongs to. */
  encodedToProject: Map<string, string>;
}

const EVIDENCE_ORDER: readonly DiscoveryEvidence[] = [
  'claude-projects',
  'claude-json',
  'codex-config',
  'aasc-session',
  'added',
];

/** DFS budget per encoded name — the filter is by name prefix, so real decodes need a handful. */
const MAX_READDIRS_PER_DECODE = 256;

const passthrough: Limiter = (task) => task();

function nonEmpty(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? join(home, p.slice(2)) : resolve(p);
}

async function isDir(p: string, limit: Limiter = passthrough): Promise<boolean> {
  try {
    return (await limit(() => stat(p))).isDirectory();
  } catch {
    return false;
  }
}

async function realpathOrNull(p: string, limit: Limiter): Promise<string | null> {
  const r = await realOrStatus(p, limit);
  return r.status === 'ok' ? r.real : null;
}

type RealResult = { status: 'ok'; real: string } | { status: 'missing' | 'inaccessible' };

/** realpath, telling a path that is not there (ENOENT/ENOTDIR) from one we may not look at (EACCES…). */
async function realOrStatus(p: string, limit: Limiter): Promise<RealResult> {
  try {
    return { status: 'ok', real: await limit(() => realpath(p)) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return { status: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible' };
  }
}

// ---------------------------------------------------------------------------
// Global roots
// ---------------------------------------------------------------------------

/** Root paths from env + home alone — no fs access, safe to call synchronously. */
export function globalRootPaths(
  env: NodeJS.ProcessEnv,
  home: string,
): Pick<GlobalRoots, 'home' | 'claudeRoot' | 'claudeConfigJson' | 'codexRoot' | 'sharedRoot'> {
  const claudeDir = nonEmpty(env.CLAUDE_CONFIG_DIR);
  const codexDir = nonEmpty(env.CODEX_HOME);
  const claudeRoot = claudeDir ? expandHome(claudeDir, home) : join(home, '.claude');
  return {
    home,
    claudeRoot,
    claudeConfigJson: claudeDir ? join(claudeRoot, '.claude.json') : join(home, '.claude.json'),
    codexRoot: codexDir ? expandHome(codexDir, home) : join(home, '.codex'),
    sharedRoot: join(home, '.agents'),
  };
}

async function detectRepo(env: NodeJS.ProcessEnv, home: string): Promise<string | null> {
  const configured = nonEmpty(env.AASC_RESOURCES_REPO);
  if (configured && (await isDir(expandHome(configured, home)))) return expandHome(configured, home);
  const fallback = join(home, 'Documents', 'agent-skills');
  if (!(await isDir(fallback))) return null;
  const tracked = (await isDir(join(fallback, 'claude'))) || (await isDir(join(fallback, 'codex')));
  return tracked ? fallback : null;
}

export async function resolveGlobalRoots(env: NodeJS.ProcessEnv, home: string): Promise<GlobalRoots> {
  const paths = globalRootPaths(env, home);
  const homeReal = (await realpathOrNull(home, passthrough)) ?? home;
  return { ...paths, homeReal, repo: await detectRepo(env, home) };
}

// ---------------------------------------------------------------------------
// ~/.claude/projects/<encoded> decoding
// ---------------------------------------------------------------------------

export function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

interface DecodeOptions {
  limit?: Limiter;
  /** Shared across the decodes of one scan, so `/`, `/Users`, `~` are listed once. */
  readdirCache?: Map<string, Promise<string[]>>;
}

interface DecodeResult {
  matches: string[];
  /** Best guess at a vanished folder: deepest existing prefix + the undecoded rest. */
  guess: string;
}

async function decodeWithGuess(encoded: string, opts: DecodeOptions = {}): Promise<DecodeResult> {
  const limit = opts.limit ?? passthrough;
  const cache = opts.readdirCache ?? new Map<string, Promise<string[]>>();
  const matches: string[] = [];
  let deepest = { dir: '/', consumed: '' };
  let budget = MAX_READDIRS_PER_DECODE;

  const list = (dir: string): Promise<string[]> => {
    const hit = cache.get(dir);
    if (hit) return hit;
    const pending = limit(() => readdir(dir)).catch(() => [] as string[]);
    cache.set(dir, pending);
    return pending;
  };

  const visit = async (dir: string, consumed: string): Promise<void> => {
    if (budget <= 0) return;
    budget -= 1;
    if (consumed.length > deepest.consumed.length) deepest = { dir, consumed };
    for (const name of await list(dir)) {
      const next = `${consumed}-${encodeProjectPath(name)}`;
      if (!encoded.startsWith(next)) continue;
      const exact = next.length === encoded.length;
      if (!exact && encoded[next.length] !== '-') continue;
      const child = join(dir, name);
      if (!(await isDir(child, limit))) continue;
      if (exact) matches.push(child);
      else await visit(child, next);
    }
  };

  if (encoded.startsWith('-')) await visit('/', '');
  const rest = encoded.slice(deepest.consumed.length).replace(/^-/, '');
  return { matches, guess: rest ? join(deepest.dir, rest) : deepest.dir };
}

/** Every existing folder whose encoded path equals `encoded`. */
export async function decodeProjectDirName(encoded: string, opts: DecodeOptions = {}): Promise<string[]> {
  return (await decodeWithGuess(encoded, opts)).matches;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

interface Candidate {
  path: string;
  evidence: DiscoveryEvidence;
  encoded?: string;
}

function tableKeys(read: ConfigRead, table: string): string[] {
  if (read.status !== 'ok' || !read.value || typeof read.value !== 'object') return [];
  const value = (read.value as Record<string, unknown>)[table];
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

function usablePath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 1 && isAbsolute(p) && !p.includes('\0');
}

function exactCandidates(input: DiscoveryInput): Candidate[] {
  const from = (paths: readonly unknown[], evidence: DiscoveryEvidence): Candidate[] =>
    paths.filter(usablePath).map((p) => ({ path: resolve(p), evidence }));
  return [
    ...from(tableKeys(input.claudeJson, 'projects'), 'claude-json'),
    ...from(tableKeys(input.codexConfig, 'projects'), 'codex-config'),
    ...from(input.sessionProjectPaths, 'aasc-session'),
    ...from(input.extraRoots, 'added'),
  ];
}

async function decodedCandidates(
  claudeRoot: string,
  exact: readonly Candidate[],
  limit: Limiter,
): Promise<Candidate[]> {
  let names: string[];
  try {
    const entries = await limit(() => readdir(join(claudeRoot, 'projects'), { withFileTypes: true }));
    names = entries.filter((d) => d.isDirectory() && d.name.startsWith('-')).map((d) => d.name);
  } catch {
    return [];
  }
  const readdirCache = new Map<string, Promise<string[]>>();
  const perName = await Promise.all(
    names.map(async (encoded) => {
      const { matches, guess } = await decodeWithGuess(encoded, { limit, readdirCache });
      // An exact path from another source that encodes the same way is the
      // truth for a folder the DFS can no longer find.
      const known = exact.filter((c) => encodeProjectPath(c.path) === encoded).map((c) => c.path);
      const paths = [...new Set([...matches, ...known])];
      return (paths.length ? paths : [guess]).map((path) => ({ path, evidence: 'claude-projects' as const, encoded }));
    }),
  );
  return perName.flat();
}

interface Merged {
  key: string;
  exists: boolean;
  inaccessible: boolean;
  evidence: Set<DiscoveryEvidence>;
  encodedDirs: Set<string>;
}

async function mergeCandidates(
  candidates: readonly Candidate[],
  excluded: ReadonlySet<string>,
  limit: Limiter,
): Promise<Map<string, Merged>> {
  const resolved = await Promise.all(
    candidates.map(async (c) => {
      const r = await realOrStatus(c.path, limit);
      const exists = r.status === 'ok' && (await isDir(r.real, limit));
      return { c, key: r.status === 'ok' ? r.real : resolve(c.path), exists, inaccessible: r.status === 'inaccessible' };
    }),
  );
  const merged = new Map<string, Merged>();
  for (const { c, key, exists, inaccessible } of resolved) {
    if (excluded.has(key)) continue;
    const prev = merged.get(key) ?? { key, exists, inaccessible, evidence: new Set(), encodedDirs: new Set() };
    merged.set(key, {
      ...prev,
      exists: prev.exists || exists,
      inaccessible: prev.inaccessible || inaccessible,
      evidence: new Set([...prev.evidence, c.evidence]),
      encodedDirs: c.encoded ? new Set([...prev.encodedDirs, c.encoded]) : prev.encodedDirs,
    });
  }
  return merged;
}

/**
 * Main checkout of a linked worktree: its `.git` is a FILE reading
 * `gitdir: <main>/.git/worktrees/<name>`. A submodule's `.git` file points at
 * `.git/modules/…` instead and is correctly not matched.
 */
async function worktreeMain(dir: string, limit: Limiter): Promise<string | null> {
  const gitPath = join(dir, '.git');
  try {
    const st = await limit(() => lstat(gitPath));
    if (!st.isFile() || st.size > 4096) return null;
    const text = await limit(() => readFile(gitPath, 'utf8'));
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
    if (!gitdir) return null;
    const main = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(resolve(dir, gitdir));
    return main ? main[1] : null;
  } catch {
    return null;
  }
}

function projectIdFor(name: string, key: string): string {
  return `${name}-${sha1Hex(key).slice(0, 8)}`;
}

function sortedEvidence(evidence: ReadonlySet<DiscoveryEvidence>): DiscoveryEvidence[] {
  return EVIDENCE_ORDER.filter((e) => evidence.has(e));
}

async function toRecords(merged: Map<string, Merged>, roots: GlobalRoots, limit: Limiter): Promise<ProjectRecord[]> {
  const records = await Promise.all(
    [...merged.values()].map(async (m): Promise<ProjectRecord> => {
      const name = basename(m.key) || m.key;
      const isHome = m.key === roots.homeReal || m.key === roots.home;
      const main = m.exists && !isHome ? await worktreeMain(m.key, limit) : null;
      return {
        id: projectIdFor(name, m.key),
        name,
        absPath: m.key,
        realPath: m.key,
        exists: m.exists,
        ...(m.inaccessible && !m.exists ? { inaccessible: true } : {}),
        evidence: sortedEvidence(m.evidence),
        ...(isHome ? { isHome: true } : {}),
        ...(main ? { worktreeOf: main } : {}),
        encodedDirs: [...m.encodedDirs],
      };
    }),
  );
  const nameCounts = records.reduce((acc, r) => acc.set(r.name, (acc.get(r.name) ?? 0) + 1), new Map<string, number>());
  return records
    .map((r) => ((nameCounts.get(r.name) ?? 0) > 1 ? { ...r, duplicateName: true } : r))
    .sort((a, b) => a.absPath.localeCompare(b.absPath));
}

/**
 * Where an encoded dir's memory is filed when it decoded to several folders:
 * the one another source also knows about, else the first by path.
 */
function attributeEncodedDirs(projects: readonly ProjectRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  const score = (p: ProjectRecord): number => p.evidence.filter((e) => e !== 'claude-projects').length;
  for (const p of projects) {
    for (const encoded of p.encodedDirs) {
      const current = projects.find((x) => x.id === out.get(encoded));
      if (!current || score(p) > score(current)) out.set(encoded, p.id);
    }
  }
  return out;
}

export async function discoverProjects(input: DiscoveryInput): Promise<DiscoveryResult> {
  const limit = input.limit ?? passthrough;
  const { roots } = input;
  const exact = exactCandidates(input);
  const decoded = await decodedCandidates(roots.claudeRoot, exact, limit);
  const excludedReal = await Promise.all(
    [roots.claudeRoot, roots.codexRoot, roots.sharedRoot].map(async (r) => [r, await realpathOrNull(r, limit)]),
  );
  const excluded = new Set(excludedReal.flat().filter((p): p is string => typeof p === 'string'));
  const merged = await mergeCandidates([...decoded, ...exact], excluded, limit);
  const projects = await toRecords(merged, roots, limit);
  return { projects, encodedToProject: attributeEncodedDirs(projects) };
}

/**
 * The client-facing shape: display paths only. An inaccessible folder is not
 * a missing one — the client's only word for that is `exists: false`, which
 * reads as "gone" — so it is shown as present; its coverage rows say why it
 * has no resources.
 */
export function toResourceProject(
  p: ProjectRecord,
  display: (absPath: string) => string,
  counts: Partial<Record<ResourceType, number>>,
): ResourceProject {
  return {
    id: p.id,
    name: p.name,
    path: display(p.absPath),
    exists: p.exists || p.inaccessible === true,
    evidence: [...p.evidence],
    ...(p.isHome ? { isHome: true } : {}),
    ...(p.worktreeOf ? { worktreeOf: display(p.worktreeOf) } : {}),
    ...(p.duplicateName ? { duplicateName: true } : {}),
    counts: { ...counts },
  };
}

// ---------------------------------------------------------------------------
// Inside a project: nested instructions and nested .claude dirs
// ---------------------------------------------------------------------------

const NESTED_SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', 'venv', '.venv',
  '__pycache__', 'target', 'Pods', '.gradle', 'vendor', '.turbo', '.cache',
]);

/** The project's own agent dirs are listed explicitly — and `.claude/worktrees` holds whole checkouts. */
const TOP_LEVEL_AGENT_DIRS = new Set(['.claude', '.codex', '.agents']);

export interface NestedFinds {
  /** `dir` is absolute; `rel` is the file's path from the project root. */
  instructions: Array<{ dir: string; rel: string }>;
  claudeDirs: string[];
  capped: boolean;
}

export interface NestedWalkOptions {
  limit: Limiter;
  maxDepth: number;
  maxDirents: number;
  /** Absolute dirs never entered: other projects (their files are theirs) and the global roots. */
  blocked: ReadonlySet<string>;
}

/**
 * Breadth-first, depth-bounded walk for nested CLAUDE.md / AGENTS.md and
 * nested `.claude` dirs (whose skills/commands/rules/agents Claude loads when
 * working below them). Symlinked dirs are never entered — Dirent.isDirectory()
 * is false for them — so a link to `/` or to another checkout cannot inflate
 * the walk; the dirent cap bounds a monorepo that is simply huge.
 */
export async function walkProjectNested(projectRoot: string, opts: NestedWalkOptions): Promise<NestedFinds> {
  const instructions: NestedFinds['instructions'] = [];
  const claudeDirs: string[] = [];
  let dirents = 0;
  let frontier = [{ dir: projectRoot, rel: '', depth: 0 }];
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { dir, rel, depth } of frontier) {
      const listing = await listDir(dir, opts.limit);
      if (listing.status !== 'ok') continue;
      dirents += listing.entries.length;
      if (dirents > opts.maxDirents) return { instructions, claudeDirs, capped: true };
      for (const d of listing.entries) {
        const abs = join(dir, d.name);
        const childRel = rel ? `${rel}/${d.name}` : d.name;
        if (d.isFile() && depth >= 1 && (d.name === 'CLAUDE.md' || d.name === 'AGENTS.md')) {
          instructions.push({ dir, rel: childRel });
        }
        if (!d.isDirectory() || NESTED_SKIP.has(d.name) || opts.blocked.has(abs)) continue;
        if (depth === 0 && TOP_LEVEL_AGENT_DIRS.has(d.name)) continue;
        if (d.name === '.claude') claudeDirs.push(abs);
        else if (depth + 1 <= opts.maxDepth) next.push({ dir: abs, rel: childRel, depth: depth + 1 });
      }
    }
    frontier = next;
  }
  return { instructions, claudeDirs, capped: false };
}

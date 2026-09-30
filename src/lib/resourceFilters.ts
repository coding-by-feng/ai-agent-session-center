/**
 * resourceFilters — the RESOURCES tab's pure rules: which items a filter
 * shows, what the TYPE rail counts, how the URL reads, and how findings,
 * coverage, patches and frontmatter are grouped for display.
 *
 * Kept import-free apart from types and the shared search predicate so every
 * surface of the tab (rail, list, empty states, counts line) asks the SAME
 * function — a rail count computed one way and a list filtered another is how
 * "Rules 19" ends up above a list of 17.
 */
import {
  RESOURCE_TYPES,
  type CoverageEntry,
  type FindingCode,
  type FindingSeverity,
  type RepoStatus,
  type ResourceAgent,
  type ResourceCatalog,
  type ResourceField,
  type ResourceFinding,
  type ResourceProject,
  type ResourceScope,
  type ResourceSummary,
  type ResourceType,
  type ScanProgress,
} from '@/types/resources';
import { matchesQuery, normalizeQuery } from './textHighlight';

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  skill: 'Skills',
  command: 'Commands',
  rule: 'Rules',
  instructions: 'Instructions',
  memory: 'Memory',
  agent: 'Agents',
  hook: 'Hooks',
  mcp: 'MCP',
  plugin: 'Plugins',
  settings: 'Settings',
};

/** Singular labels, for the detail header ("coding-style.md · Rule"). */
export const RESOURCE_TYPE_SINGULAR: Record<ResourceType, string> = {
  skill: 'Skill',
  command: 'Command',
  rule: 'Rule',
  instructions: 'Instructions',
  memory: 'Memory',
  agent: 'Agent',
  hook: 'Hook',
  mcp: 'MCP server',
  plugin: 'Plugin',
  settings: 'Settings',
};

/** Lower-case plural nouns for sentences ("No MCP servers in Codex"). */
const TYPE_NOUNS: Record<ResourceType, string> = {
  skill: 'skills',
  command: 'commands',
  rule: 'rules',
  instructions: 'instructions',
  memory: 'memory files',
  agent: 'agents',
  hook: 'hooks',
  mcp: 'MCP servers',
  plugin: 'plugins',
  settings: 'settings',
};

export const AGENT_LABELS: Record<ResourceAgent, string> = {
  claude: 'Claude',
  codex: 'Codex',
  shared: 'Shared',
};

export const SCOPE_LABELS: Record<ResourceScope, string> = {
  global: 'Global',
  project: 'Project',
};

const FINDING_LABELS: Record<FindingCode, string> = {
  'frontmatter-invalid': 'Invalid frontmatter',
  'frontmatter-missing': 'Missing frontmatter',
  'name-mismatch': 'Name does not match folder',
  'duplicate-name': 'Duplicate name',
  'broken-symlink': 'Broken symlink',
  'linked-outside': 'Linked from outside its root',
  'variant-differs': 'Variants differ',
  'repo-differs': 'Differs from repo',
  'not-in-repo': 'Not in repo',
  'repo-only': 'Only in repo',
  'orphaned-memory': 'Orphaned memory',
  'hardcoded-home-path': 'Hard-coded home path',
  'hash-capped': 'Too large to hash',
  'config-parse-error': 'Config parse error',
};

export function findingLabel(code: FindingCode): string {
  return FINDING_LABELS[code] ?? code;
}

// ---------------------------------------------------------------------------
// URL state
// ---------------------------------------------------------------------------

export const RESOURCE_SECTIONS = ['library', 'sources', 'checks'] as const;
export type ResourceSection = (typeof RESOURCE_SECTIONS)[number];

export type AgentFilter = 'all' | ResourceAgent;
export type ScopeFilter = 'all' | ResourceScope;

export interface ResourceFilters {
  agent: AgentFilter;
  scope: ScopeFilter;
  /** Only meaningful when `scope === 'project'`; null = every project. */
  projectId: string | null;
  query: string;
  /** Plugin- and CLI-shipped items are hidden (and uncounted) until this is on. */
  showPluginSystem: boolean;
}

export interface ResourceViewParams extends ResourceFilters {
  section: ResourceSection;
  type: ResourceType;
  id: string | null;
}

export const DEFAULT_FILTERS: ResourceFilters = {
  agent: 'all',
  scope: 'all',
  projectId: null,
  query: '',
  showPluginSystem: false,
};

const AGENT_FILTERS: readonly AgentFilter[] = ['all', 'claude', 'codex', 'shared'];
const SCOPE_FILTERS: readonly ScopeFilter[] = ['all', 'global', 'project'];

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Read the tab's state from the URL. Unknown values fall back to defaults —
 * a hand-edited or stale link must degrade to a working view, never a blank one.
 * A bare `?project=<id>` deep link implies the project scope.
 */
export function readResourceParams(params: URLSearchParams): ResourceViewParams {
  const project = params.get('project') || null;
  const scope = oneOf(params.get('scope'), SCOPE_FILTERS, project ? 'project' : 'all');
  return {
    section: oneOf(params.get('section'), RESOURCE_SECTIONS, 'library'),
    type: oneOf(params.get('type'), RESOURCE_TYPES, 'skill'),
    id: params.get('id') || null,
    agent: oneOf(params.get('agent'), AGENT_FILTERS, 'all'),
    scope,
    projectId: scope === 'project' ? project : null,
    query: params.get('q') ?? '',
    showPluginSystem: params.get('plugins') === '1',
  };
}

/** A new URLSearchParams with `patch` applied; `null`/`''` delete a key. */
export function withParams(
  prev: URLSearchParams,
  patch: Record<string, string | null | undefined>,
): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') next.delete(key);
    else next.set(key, value);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Filtering and counting
// ---------------------------------------------------------------------------

export function isPluginOrSystem(r: ResourceSummary): boolean {
  return r.origin === 'plugin' || r.origin === 'system';
}

/**
 * Claude memory is filed per project but stored in the global root
 * (`~/.claude/projects/<encoded>/memory`), so it belongs to both views: under
 * Global, which is "everything in ~/.claude", and under its own project.
 * Nothing else is dual-listed — a project's own skills never count as Global.
 */
function inScope(r: ResourceSummary, scope: ScopeFilter): boolean {
  if (scope === 'all' || r.scope === scope) return true;
  return scope === 'global' && r.type === 'memory' && r.agent === 'claude';
}

/** Every filter except the type — the type is the rail's own dimension. */
export function matchesFilters(r: ResourceSummary, f: ResourceFilters): boolean {
  if (!f.showPluginSystem && isPluginOrSystem(r)) return false;
  if (f.agent !== 'all' && r.agent !== f.agent) return false;
  if (!inScope(r, f.scope)) return false;
  if (f.scope === 'project' && f.projectId && r.projectId !== f.projectId) return false;
  const q = normalizeQuery(f.query);
  if (!q) return true;
  return [r.name, r.description, r.path, r.pluginName].some((text) => matchesQuery(text, q));
}

function byName(a: ResourceSummary, b: ResourceSummary): number {
  return a.name.localeCompare(b.name) || a.agent.localeCompare(b.agent) || a.path.localeCompare(b.path);
}

/** The middle list: one type, every filter, sorted by name. */
export function filterResources(
  resources: readonly ResourceSummary[],
  f: ResourceFilters,
  type: ResourceType,
): ResourceSummary[] {
  return resources.filter((r) => r.type === type && matchesFilters(r, f)).sort(byName);
}

export interface TypeCount {
  type: ResourceType;
  label: string;
  count: number;
}

/**
 * The TYPE rail: all ten types in rail order, zero rows kept — "Instructions 0"
 * is an answer (no CLAUDE.md in this scope), not something to hide.
 */
export function countByType(resources: readonly ResourceSummary[], f: ResourceFilters): TypeCount[] {
  const counts = new Map<ResourceType, number>();
  for (const r of resources) {
    if (matchesFilters(r, f)) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  }
  return RESOURCE_TYPES.map((type) => ({ type, label: RESOURCE_TYPE_LABELS[type], count: counts.get(type) ?? 0 }));
}

/** Per-agent totals for the counts line; only the plugin toggle applies. */
export function agentTotals(
  resources: readonly ResourceSummary[],
  showPluginSystem: boolean,
): Record<ResourceAgent, number> {
  const totals: Record<ResourceAgent, number> = { claude: 0, codex: 0, shared: 0 };
  for (const r of resources) {
    if (showPluginSystem || !isPluginOrSystem(r)) totals[r.agent] += 1;
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "just now" / "2m ago" / "3h ago" / "5d ago". A future timestamp reads as now. */
export function relativeAge(ts: number, now: number): string {
  const minutes = Math.floor((now - ts) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function progressLabel(progress: ScanProgress | undefined): string {
  if (!progress) return 'starting';
  return progress.total > 0 ? `${progress.phase} ${progress.done}/${progress.total}` : progress.phase;
}

/**
 * The counts line under the filters. During a FIRST scan it shows progress
 * only: "0 claude · 0 codex" would read as "you have nothing" when the truth is
 * "not counted yet".
 */
/**
 * Sources table order: projects that exist first, then missing ones, each A→Z.
 * The registries keep entries for folders long gone (temp test dirs, deleted
 * checkouts); sorted purely by name they used to fill the first screen.
 */
export function orderProjects(projects: readonly ResourceProject[]): ResourceProject[] {
  return [...projects].sort(
    (a, b) => Number(!a.exists) - Number(!b.exists) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  );
}

/**
 * Basenames shared by two or more projects that still exist — the only
 * duplicates worth a warning chip. Two vanished temp dirs named `a1` collide
 * with nothing you can open.
 */
export function sharedProjectNames(projects: readonly ResourceProject[]): Set<string> {
  const seen = new Map<string, number>();
  for (const p of projects) {
    if (p.exists) seen.set(p.name, (seen.get(p.name) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([name]) => name));
}

export function catalogSummaryLine(catalog: ResourceCatalog, showPluginSystem: boolean, now: number): string {
  if (catalog.state === 'scanning' && catalog.resources.length === 0) {
    return `Scanning… ${progressLabel(catalog.progress)}`;
  }
  const totals = agentTotals(catalog.resources, showPluginSystem);
  // Registries remember folders long after they are deleted; those are listed
  // (as missing) in Sources, but they are not projects you have.
  const projects = catalog.projects.filter((p) => p.exists).length;
  const parts = [
    `${totals.claude} claude`,
    `${totals.codex} codex`,
    `${totals.shared} shared`,
    `${projects} ${projects === 1 ? 'project' : 'projects'}`,
  ];
  if (catalog.state === 'scanning') parts.push(`scanning ${progressLabel(catalog.progress)}`);
  else if (catalog.scannedAt) parts.push(`scanned ${relativeAge(catalog.scannedAt, now)}`);
  else parts.push('not scanned yet');
  return parts.join(' · ');
}

/**
 * What a config field shows. A masked field shows the placeholder whatever
 * `value` holds — the server masks already, and this keeps a server bug from
 * becoming a leak on screen.
 */
export function formatFieldValue(field: ResourceField): string {
  return field.masked ? '******' : field.value;
}

// ---------------------------------------------------------------------------
// Row chips and labels
// ---------------------------------------------------------------------------

/** The list's repo chip. `not-tracked` gets none — the repo doesn't collect that category. */
export function repoChipLabel(status: RepoStatus): string | null {
  if (status === 'not-tracked') return null;
  return status === 'not-in-repo' ? 'not in repo' : status;
}

export function hasVariantDiff(r: ResourceSummary): boolean {
  return r.findingCodes.includes('variant-differs');
}

/** The origin tag on a row; authored-by-you items carry none. */
export function originTag(r: ResourceSummary): string | null {
  return r.origin === 'user' ? null : r.origin;
}

/** "Global", the owning project's name, or "Project" when that project is unknown. */
export function scopeName(r: ResourceSummary, projectsById: ReadonlyMap<string, ResourceProject>): string {
  if (r.scope === 'global') return SCOPE_LABELS.global;
  return (r.projectId && projectsById.get(r.projectId)?.name) || SCOPE_LABELS.project;
}

/** "No agents in Claude · Global" — names exactly what came up empty. */
export function emptyStateMessage(type: ResourceType, f: ResourceFilters, projectName?: string): string {
  const noun = TYPE_NOUNS[type];
  const q = f.query.trim();
  const base = q ? `No ${noun} match “${q}”` : `No ${noun}`;
  const context: string[] = [];
  if (f.agent !== 'all') context.push(AGENT_LABELS[f.agent]);
  if (f.scope === 'global') context.push(SCOPE_LABELS.global);
  if (f.scope === 'project') context.push((f.projectId && projectName) || SCOPE_LABELS.project);
  if (context.length > 0) return `${base} in ${context.join(' · ')}`;
  return q ? base : `${base} found`;
}

// ---------------------------------------------------------------------------
// Findings and coverage
// ---------------------------------------------------------------------------

export const SEVERITY_ORDER: readonly FindingSeverity[] = ['error', 'warning', 'info'];

export interface FindingCodeGroup {
  code: FindingCode;
  label: string;
  findings: ResourceFinding[];
}

export interface FindingGroup {
  severity: FindingSeverity;
  count: number;
  codes: FindingCodeGroup[];
}

/** Checks: severity (error → warning → info), then code in first-seen order. Empty severities are omitted. */
export function groupFindings(findings: readonly ResourceFinding[]): FindingGroup[] {
  return SEVERITY_ORDER.flatMap((severity) => {
    const matching = findings.filter((f) => f.severity === severity);
    if (matching.length === 0) return [];
    const byCode = new Map<FindingCode, ResourceFinding[]>();
    for (const f of matching) byCode.set(f.code, [...(byCode.get(f.code) ?? []), f]);
    const codes = [...byCode].map(([code, list]) => ({ code, label: findingLabel(code), findings: list }));
    return [{ severity, count: matching.length, codes }];
  });
}

export interface CoverageGroup {
  root: string;
  entries: CoverageEntry[];
}

export function groupCoverage(coverage: readonly CoverageEntry[]): CoverageGroup[] {
  const byRoot = new Map<string, CoverageEntry[]>();
  for (const entry of coverage) byRoot.set(entry.root, [...(byRoot.get(entry.root) ?? []), entry]);
  return [...byRoot].map(([root, entries]) => ({ root, entries }));
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export function canCompare(r: ResourceSummary): boolean {
  return r.repo.status === 'same' || r.repo.status === 'differs' || r.variantIds.length > 0;
}

export interface CompareOption {
  value: string;
  label: string;
}

/**
 * The Compare select: the repo copy first (when the repo tracks this item),
 * then each variant the catalog still holds — a variant id it no longer holds
 * would only 404.
 */
export function compareTargets(
  summary: ResourceSummary,
  byId: ReadonlyMap<string, ResourceSummary>,
  projectsById: ReadonlyMap<string, ResourceProject>,
): CompareOption[] {
  const options: CompareOption[] = [];
  if (summary.repo.status === 'same' || summary.repo.status === 'differs') {
    options.push({ value: 'repo', label: 'agent-skills repo' });
  }
  for (const id of summary.variantIds) {
    const variant = byId.get(id);
    if (!variant) continue;
    const suffix = variant.name !== summary.name ? ` · ${variant.name}` : '';
    options.push({ value: id, label: `${AGENT_LABELS[variant.agent]} · ${scopeName(variant, projectsById)}${suffix}` });
  }
  return options;
}

export type PatchLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

export interface PatchLine {
  text: string;
  kind: PatchLineKind;
}

/**
 * Classify a unified diff line by line. Stateful on purpose: everything before
 * the first `@@` is file header, and inside a hunk a line is judged only by its
 * first character — a deleted markdown rule `---` reads `----` and must stay a
 * deletion, not turn into a header.
 */
export function classifyPatchLines(patch: string): PatchLine[] {
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let inHunk = false;
  return lines.map((text) => {
    if (text.startsWith('@@')) {
      inHunk = true;
      return { text, kind: 'hunk' };
    }
    if (!inHunk || text.startsWith('\\')) return { text, kind: 'meta' };
    if (text.startsWith('+')) return { text, kind: 'add' };
    if (text.startsWith('-')) return { text, kind: 'del' };
    return { text, kind: 'context' };
  });
}

// ---------------------------------------------------------------------------
// Frontmatter (the server strips the block from `body`, parsed or not — the
// card below shows it instead of two `<hr>`s)
// ---------------------------------------------------------------------------

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(isScalar)) return value.map(String).join(', ');
  if (isScalar(value)) return String(value);
  return JSON.stringify(value);
}

export interface FrontmatterRow {
  key: string;
  value: string;
}

/** The frontmatter card's rows: `name`, `description`, then every other key in file order. */
export function frontmatterRows(frontmatter: Record<string, unknown>): FrontmatterRow[] {
  const leading = ['name', 'description'].filter((key) => key in frontmatter);
  const rest = Object.keys(frontmatter).filter((key) => !leading.includes(key));
  return [...leading, ...rest].map((key) => ({ key, value: stringifyValue(frontmatter[key]) }));
}

// ---------------------------------------------------------------------------
// Links in previews (markdown from skills, memory, rules… is untrusted text)
// ---------------------------------------------------------------------------

const CLICKABLE_SCHEME_RE = /^(https?:|mailto:)/i;
const LOOPBACK_V4_RE = /^127(\.\d{1,3}){3}$/;
/** `new URL()` writes any IPv4-mapped address as `[::ffff:hhhh:hhhh]`. */
const MAPPED_V4_RE = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/;

/**
 * A hostname — as `new URL()` normalises it — that reaches this machine.
 * The parser already folds case and rewrites decimal/hex/octal/short IPv4 to
 * dotted quads and IPv6 to its compressed form, so only the canonical shapes
 * need matching.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, ''); // "localhost." is localhost
  if (host === 'localhost' || host.endsWith('.localhost')) return true; // RFC 6761
  if (LOOPBACK_V4_RE.test(host) || host === '0.0.0.0') return true;
  if (host === '[::1]' || host === '[::]') return true;
  const mapped = MAPPED_V4_RE.exec(host);
  if (!mapped) return false;
  const high = parseInt(mapped[1], 16);
  return high >> 8 === 127 || (high === 0 && parseInt(mapped[2], 16) === 0);
}

/**
 * May a link in a preview be clickable? Only an absolute http(s) or mailto
 * link to ANOTHER machine. Everything else renders as plain text:
 * - relative links point into the resource's package, not into this app;
 * - this page's own origin, and ANY loopback host on ANY port. Under Electron
 *   a loopback URL on the app's port opens an in-app window
 *   (electron/internalUrl.ts) — e.g. the Project Browser, which can edit
 *   files — and that port is not something a preview can reliably exclude,
 *   so all of loopback is out.
 */
export function isExternalHref(href: string | undefined, pageOrigin: string): href is string {
  if (!href || !CLICKABLE_SCHEME_RE.test(href)) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol === 'mailto:') return true;
  return url.origin !== pageOrigin && !isLoopbackHost(url.hostname);
}

// ---------------------------------------------------------------------------
// Revealing the selection
// ---------------------------------------------------------------------------

/** A box's extent along one axis (top/bottom or left/right, viewport px). */
export interface Span {
  start: number;
  end: number;
}

/**
 * How far to scroll one container so `item` shows inside `box`: 0 while it is
 * already fully visible (so clicking a visible row never jumps the list),
 * otherwise enough to centre it, or to align its start when it is bigger than
 * the box. Callers add this to that container's own scrollTop/scrollLeft —
 * never `scrollIntoView()`, which also scrolls every ancestor
 * (see src/lib/scrollWithinContainer.ts).
 */
export function revealDelta(box: Span, item: Span): number {
  if (item.start >= box.start && item.end <= box.end) return 0;
  const boxSize = box.end - box.start;
  const itemSize = item.end - item.start;
  if (itemSize >= boxSize) return Math.round(item.start - box.start);
  return Math.round(item.start - box.start - (boxSize - itemSize) / 2);
}

// ---------------------------------------------------------------------------
// Extra roots (Sources → "Add folder")
// ---------------------------------------------------------------------------

/** Same cap the server enforces on `POST /scan`. */
export const MAX_EXTRA_ROOTS = 50;

const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

/** Trimmed, without trailing separators — so `/a/b/` and `/a/b` are one folder. */
export function normalizeExtraRoot(path: string): string {
  const trimmed = path.trim();
  const stripped = trimmed.replace(/[\\/]+$/, '');
  return stripped || trimmed;
}

/** Why the server would reject this folder, or null when it is acceptable. */
export function validateExtraRoot(path: string, existing: readonly string[]): string | null {
  const value = normalizeExtraRoot(path);
  if (!value) return 'Enter a folder path.';
  if (value.includes('\u0000')) return 'That path contains an invalid character.';
  const isAbsolute = value.startsWith('/') || WINDOWS_DRIVE_RE.test(value);
  if (!isAbsolute) return 'Use an absolute path (starting with /) — ~ is not expanded.';
  const segments = value.split(/[\\/]+/).filter((s) => s && !/^[A-Za-z]:$/.test(s));
  if (segments.length < 2) return 'Pick a folder below the top level of the disk.';
  if (existing.includes(value)) return 'That folder is already added.';
  if (existing.length >= MAX_EXTRA_ROOTS) return `At most ${MAX_EXTRA_ROOTS} folders can be added.`;
  return null;
}

/**
 * True when folders are saved but the catalog shows no project that came from
 * one. A fresh server's first scan is started by `GET /` and cannot carry
 * them, so after a relaunch the added folders are missing until a scan that
 * includes them runs.
 */
export function needsRootsRescan(catalog: ResourceCatalog, extraRoots: readonly string[]): boolean {
  return extraRoots.length > 0 && !catalog.projects.some((p) => p.evidence.includes('added'));
}

/**
 * Parse the stored list. localStorage is user-editable and survives app
 * versions, so anything that isn't a valid, unique absolute folder is dropped.
 */
export function parseStoredExtraRoots(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const roots: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue;
    if (roots.length >= MAX_EXTRA_ROOTS) break;
    if (validateExtraRoot(entry, roots) === null) roots.push(normalizeExtraRoot(entry));
  }
  return roots;
}

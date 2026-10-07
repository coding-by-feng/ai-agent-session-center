/**
 * Agent Resources — the RESOURCES tab's shared contract (Phase B: read-only).
 *
 * One catalog of every Claude Code and Codex resource on this machine: skills,
 * commands/prompts, rules, CLAUDE.md/AGENTS.md instructions, memory, agents,
 * hooks, MCP servers, plugins and settings — global and per project — compared
 * read-only against the `agent-skills` repository copy.
 *
 * Shared by `server/resource*.ts` and `src/components/resources/*`. Keep this
 * file free of imports and runtime dependencies other than the constants below:
 * `tsconfig.server.json` includes `src/types`, and the server imports it as
 * `../src/types/resources.js`.
 *
 * Two rules the shapes below encode:
 * - Nothing here carries an absolute path or a secret. Paths are display paths
 *   (`~/.claude/skills/x`); config values arrive already masked by the server
 *   (`server/resourceMask.ts`). A summary can therefore be logged or rendered
 *   anywhere without leaking the machine's layout or a credential.
 * - "Not scanned" is an answer, not an absence. Every category the scan did not
 *   cover shows up in `coverage` with a reason, so partial coverage is never
 *   presented as a complete collection.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Every resource type, in the order the TYPE rail lists them (authored text first, config last). */
export const RESOURCE_TYPES = [
  'skill',
  'command',
  'rule',
  'instructions',
  'memory',
  'agent',
  'hook',
  'mcp',
  'plugin',
  'settings',
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Which agent reads it. `shared` = `~/.agents` / `<project>/.agents` (read by more than one agent). */
export type ResourceAgent = 'claude' | 'codex' | 'shared';

export type ResourceScope = 'global' | 'project';

/**
 * Who owns or produced the resource.
 * - `user`   — authored by you.
 * - `plugin` — shipped inside an installed plugin.
 * - `system` — bundled with the CLI (Codex `skills/.system`).
 * - `synced` — synced from claude.ai (`~/.claude/skills/synced/…`).
 * - `linked` — a symlink whose target lives outside the root being scanned
 *              (e.g. a global skill that is really owned by another repo).
 */
export type ResourceOrigin = 'user' | 'plugin' | 'system' | 'synced' | 'linked';

/**
 * How the detail pane renders it.
 * `policy` = Codex `rules/*.rules`, an exec-approval policy — a different thing
 * from Claude's markdown rules despite the shared word, and never paired with them.
 */
export type ResourceFormat = 'markdown' | 'config' | 'script' | 'text' | 'policy';

/**
 * Relationship to the agent-skills repository copy.
 * - `same` / `differs` — the repo tracks this path and the content hashes agree / disagree.
 * - `not-in-repo`      — the repo tracks this category, but has no copy of this item.
 * - `not-tracked`      — the repo does not collect this category (memory, MCP, projects…).
 */
export type RepoStatus = 'same' | 'differs' | 'not-in-repo' | 'not-tracked';

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface ResourceSummary {
  /** Stable across scans while the file stays where it is. */
  id: string;
  type: ResourceType;
  agent: ResourceAgent;
  scope: ResourceScope;
  origin: ResourceOrigin;
  format: ResourceFormat;
  /** Skill/command name, rule relative path, hook event, MCP server name, memory file… */
  name: string;
  /** From frontmatter `description`, when there is one. */
  description?: string;
  /** Owning project for `scope: 'project'`, and for memory filed under a project. */
  projectId?: string;
  /** Home-relative display path of the file or package directory ("~/.claude/skills/x"). */
  path: string;
  /** When `path` is a symlink: where it really points (display form). */
  linkTarget?: string;
  /** The plugin that ships it, for `origin: 'plugin'`. */
  pluginName?: string;
  /** Files in the package (skills); 1 for a single file or a config entry. */
  fileCount: number;
  bytes: number;
  /** sha256 hex over the content (package-aware). Absent when unreadable or over the hash cap. */
  hash?: string;
  mtimeMs: number;
  repo: { status: RepoStatus; path?: string };
  /** Same type and name under another agent (Claude vs Codex vs shared) in the same scope. */
  variantIds: string[];
  /** Memory filed under a project folder that no longer exists on disk. */
  orphaned?: boolean;
  findingCodes: FindingCode[];
}

// ---------------------------------------------------------------------------
// Checks (deterministic — Phase B has no semantic/AI suggestions)
// ---------------------------------------------------------------------------

export type FindingCode =
  | 'frontmatter-invalid'
  | 'frontmatter-missing'
  | 'name-mismatch'
  | 'duplicate-name'
  | 'broken-symlink'
  | 'linked-outside'
  | 'variant-differs'
  | 'repo-differs'
  | 'not-in-repo'
  | 'repo-only'
  | 'orphaned-memory'
  | 'hardcoded-home-path'
  | 'hash-capped'
  | 'config-parse-error';

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface ResourceFinding {
  code: FindingCode;
  severity: FindingSeverity;
  /** Absent for findings about something that is not a live resource (e.g. `repo-only`). */
  resourceId?: string;
  message: string;
  /** Display path, for findings without a resource. */
  path?: string;
}

// ---------------------------------------------------------------------------
// Sources: projects, roots, coverage
// ---------------------------------------------------------------------------

/** Where a project root was learned from. A recent-session list is not proof every project was found. */
export type DiscoveryEvidence =
  | 'claude-projects' // ~/.claude/projects/<encoded>
  | 'claude-json' // ~/.claude.json "projects"
  | 'codex-config' // ~/.codex/config.toml [projects."<path>"]
  | 'aasc-session' // a session AASC knows about
  | 'added'; // added by hand in the Sources sub-tab

export interface ResourceProject {
  id: string;
  name: string;
  /** Display path. */
  path: string;
  exists: boolean;
  evidence: DiscoveryEvidence[];
  /** `~` itself: only its own CLAUDE.md / AGENTS.md are read — its dot-dirs ARE the global roots. */
  isHome?: boolean;
  /** Linked git worktree: display path of the main checkout it belongs to. */
  worktreeOf?: string;
  /** Another discovered project has the same basename. */
  duplicateName?: boolean;
  counts: Partial<Record<ResourceType, number>>;
}

export type CoverageCategory =
  | ResourceType
  | 'sessions'
  | 'history'
  | 'databases'
  | 'credentials'
  | 'plugin-contents';

export type CoverageStatus =
  | 'scanned'
  | 'empty'
  | 'not-found'
  | 'unsupported'
  | 'inaccessible'
  | 'failed'
  | 'not-scanned'
  | 'excluded';

export interface CoverageEntry {
  /** Display path of the root this entry describes. */
  root: string;
  agent: ResourceAgent;
  category: CoverageCategory;
  status: CoverageStatus;
  count?: number;
  /** Size on disk, for data that is sized but not read (sessions, databases). */
  bytes?: number;
  /** e.g. "Phase D — size only", "names only, never read", "capped at 20,000 entries". */
  note?: string;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type ScanState = 'idle' | 'scanning' | 'ready' | 'error';

export interface ScanProgress {
  phase: 'roots' | 'resources' | 'hashing' | 'repo' | 'checks' | 'done';
  done: number;
  total: number;
}

export interface ResourceRoots {
  claude: string;
  codex: string;
  shared: string;
  /** The agent-skills repository, or null when none is configured/detected. */
  repo: string | null;
  /** Where Uninstall moves things (display path) — named in the uninstall dialog. */
  trash?: string;
}

export interface ResourceCatalog {
  state: ScanState;
  startedAt?: number;
  /** Completion time of the last successful scan. */
  scannedAt?: number;
  durationMs?: number;
  progress?: ScanProgress;
  error?: string;
  roots: ResourceRoots;
  projects: ResourceProject[];
  resources: ResourceSummary[];
  findings: ResourceFinding[];
  coverage: CoverageEntry[];
}

// ---------------------------------------------------------------------------
// Detail, files, compare
// ---------------------------------------------------------------------------

export interface ResourceFile {
  /** Path relative to the package root. */
  path: string;
  bytes: number;
  isText: boolean;
  isSymlink?: boolean;
}

export type ResourceFieldKind = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';

/** One flattened config field. `value` is already masked when `masked` is true. */
export interface ResourceField {
  /** Dotted path, e.g. `mcp_servers.kason.env.API_KEY`. */
  key: string;
  value: string;
  masked: boolean;
  kind: ResourceFieldKind;
}

export interface ResourceDetail {
  summary: ResourceSummary;
  /** Parsed YAML frontmatter (JSON-safe values only). */
  frontmatter?: Record<string, unknown>;
  frontmatterError?: string;
  /** Main file body with frontmatter stripped (markdown/script/text/policy); capped. */
  body?: string;
  bodyTruncated?: boolean;
  /** Config-type resources: flattened fields, masked on the server. */
  fields?: ResourceField[];
  /** Package listing (skills). */
  files?: ResourceFile[];
  findings: ResourceFinding[];
}

export interface ResourceFileContent {
  path: string;
  bytes: number;
  content?: string;
  truncated?: boolean;
  binary?: boolean;
}

/** `repo` compares against the agent-skills copy; any other value is a variant's resource id. */
export type CompareTarget = 'repo' | string;

export interface ResourceCompareFile {
  path: string;
  status: 'same' | 'changed' | 'only-left' | 'only-right';
}

export interface ResourceCompare {
  left: { label: string; path: string };
  right: { label: string; path: string };
  files: ResourceCompareFile[];
  /** Unified diff of the main file (SKILL.md, or the file itself); capped. */
  patch?: string;
  patchTruncated?: boolean;
}

// ---------------------------------------------------------------------------
// Uninstall — the tab's only write: a move into the AASC trash, and back
// ---------------------------------------------------------------------------

/**
 * The types uninstall handles — each one folder (a skill) or one file. Hooks,
 * MCP servers and settings live INSIDE config files, an instructions file is a
 * project's own guide, and a plugin has its own uninstaller.
 */
export const UNINSTALLABLE_TYPES = ['skill', 'command', 'rule', 'agent', 'memory'] as const satisfies readonly ResourceType[];

export function isUninstallableType(type: ResourceType): boolean {
  return (UNINSTALLABLE_TYPES as readonly ResourceType[]).includes(type);
}

/**
 * Why this resource may not be uninstalled, or null when it may. One rule for
 * both sides: the server enforces it, the tab uses it to decide what to offer.
 * A symlink is refused whatever its origin: removing the link would not remove
 * what it points at, and the folder it points into may be someone else's.
 */
export function uninstallBlocker(r: Pick<ResourceSummary, 'type' | 'origin' | 'linkTarget' | 'pluginName'>): string | null {
  if (!isUninstallableType(r.type)) return 'Only skills, commands, rules, agents and memory can be uninstalled here.';
  if (r.origin === 'plugin') return `Part of the ${r.pluginName ?? 'its'} plugin — remove the plugin instead.`;
  if (r.origin === 'system') return 'Bundled with the CLI — an update would only put it back.';
  if (r.origin === 'synced') return 'Synced from claude.ai — remove it there.';
  if (r.origin === 'linked') return `A link to ${r.linkTarget ?? 'another folder'}, which owns it — remove it there.`;
  if (r.linkTarget) return `A link to ${r.linkTarget} — remove the link by hand if that is what you want.`;
  return null;
}

/** `POST /item/:id/uninstall`: where it went, and the id that brings it back. */
export interface UninstallResult {
  trashId: string;
  name: string;
  type: ResourceType;
  /** Display path it was moved from. */
  path: string;
}

/** `POST /trash/:trashId/restore`. */
export interface RestoreResult {
  name: string;
  type: ResourceType;
  path: string;
}

// ---------------------------------------------------------------------------
// API envelope — every /api/resources route answers { success, data | error }
// ---------------------------------------------------------------------------

export type ResourcesApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string };

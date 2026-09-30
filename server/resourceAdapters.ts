/**
 * resourceAdapters — which files ARE resources, per agent and scope.
 *
 * Each adapter lists one root (Claude global, Codex global, `~/.agents`, one
 * project) and returns raw entries plus a coverage row for every category it
 * considered — including the empty and missing ones, because "0 instructions"
 * must read as "looked, found none", never as "didn't look".
 *
 * Adapters decide WHAT a resource is (name, type, format, origin, repo mapping);
 * the scanner decides what it CONTAINS (hash, frontmatter, symlinks, findings).
 *
 * Two walls this file must never breach:
 * - **Plugin caches.** `~/.claude/plugins/cache` holds every version ever
 *   installed (hundreds of MB of stale skills). Only the CURRENT `installPath`
 *   of each `installed_plugins.json` entry is listed, and only its `skills/`,
 *   `commands/` and `agents/`. Codex's `.tmp/`, `vendor_imports/`, `plugins/`
 *   and `log/` are never opened — nothing here walks a root generically.
 * - **Credentials and transcripts.** They appear in coverage by count and size
 *   only; no function in this file opens them.
 */
import type { Dirent } from 'fs';
import { basename, dirname, join, sep } from 'path';
import type { CoverageCategory, CoverageEntry, CoverageStatus, ResourceAgent, ResourceFinding, ResourceFormat, ResourceOrigin, ResourceScope, ResourceType } from '../src/types/resources.js';
import { listDir, listFlatFiles, listTree, lstatSize, sha1Hex, statKind } from './fsSafe.js';
import type { ConfigRead, Limiter, ListStatus } from './fsSafe.js';
import { claudeCredentials, codexData, inaccessibleProjectCoverage, listingNote, PHASE_D_NOTE, sizedFile } from './resourceSafety.js';
import { walkProjectNested, type GlobalRoots, type NestedFinds, type ProjectRecord } from './resourceRoots.js';
// Type-only (erased at build): the scanner owns the limit DEFAULTS, adapters only read them.
import type { ScanLimits } from './resourceScanner.js';

export type EntryKind = 'package' | 'file' | 'config-entry' | 'config-file';

/** One resource as listed — absolute paths and raw config included; never sent to a client. */
export interface RawEntry {
  id: string;
  type: ResourceType;
  agent: ResourceAgent;
  scope: ResourceScope;
  origin: ResourceOrigin;
  format: ResourceFormat;
  name: string;
  /** File, package directory, or the config file a config-derived entry came from. */
  absPath: string;
  kind: EntryKind;
  /** The root being scanned — a symlink resolving outside it is `linked`. */
  rootAbs: string;
  subKey?: string;
  /** Config value (masked for display) and the keys it is shown under. */
  config?: { value: unknown; wrap: readonly string[] };
  /**
   * What a config-derived entry is HASHED from when that differs from what is
   * shown: a plugin record hashes its raw install entry but shows only a
   * display-safe subset. Defaults to `config.value`.
   */
  hashInput?: unknown;
  projectId?: string;
  pluginName?: string;
  /** Fallback when frontmatter has none (`_shared`, a synced skill's manifest). */
  description?: string;
  orphaned?: boolean;
  /** Path inside the agent-skills repo this item is mirrored at (global, user-owned only). */
  repoRel?: string;
  /** CLAUDE.md ↔ AGENTS.md pairing key: the directory they both sit in. */
  variantGroup?: string;
  /** `_shared`: a package of helper files, not a skill — no SKILL.md checks. */
  notASkill?: boolean;
}

export interface AdapterContext {
  roots: GlobalRoots;
  display: (absPath: string) => string;
  limit: Limiter;
  /** Memoized per scan — one config feeds settings, hooks, MCP and discovery. */
  readConfig: (absPath: string, kind: 'json' | 'toml') => Promise<ConfigRead>;
  limits: ScanLimits;
  projects: readonly ProjectRecord[];
  encodedToProject: ReadonlyMap<string, string>;
  projectIdFor: (absPath: string) => Promise<string | undefined>;
  /** Project-scoped MCP servers found in ~/.claude.json — they count toward that project's coverage. */
  claudeJsonMcpCount?: (projectId: string) => number;
}

export interface AdapterResult {
  entries: RawEntry[];
  coverage: CoverageEntry[];
  findings: ResourceFinding[];
}

interface Base {
  agent: ResourceAgent;
  scope: ResourceScope;
  origin: ResourceOrigin;
  rootAbs: string;
  projectId?: string;
  pluginName?: string;
}

interface Found {
  entries: RawEntry[];
  status: CoverageStatus;
  note?: string;
}

type EntrySpec = Pick<RawEntry, 'type' | 'format' | 'name' | 'absPath' | 'kind'> &
  Partial<Pick<RawEntry, 'subKey' | 'config' | 'hashInput' | 'description' | 'repoRel' | 'variantGroup' | 'notASkill' | 'origin'>>;

type ReadResult = { read: ConfigRead; entry?: RawEntry; finding?: ResourceFinding };

const SHARED_DIR_DESCRIPTION = 'Shared files used by other skills (not a skill)';
const EMPTY: AdapterResult = { entries: [], coverage: [], findings: [] };

export function resourceId(type: ResourceType, agent: ResourceAgent, absPath: string, subKey = ''): string {
  return sha1Hex(`${type}|${agent}|${absPath}|${subKey}`).slice(0, 16);
}

function makeEntry(base: Base, spec: EntrySpec): RawEntry {
  return {
    id: resourceId(spec.type, base.agent, spec.absPath, spec.subKey),
    agent: base.agent,
    scope: base.scope,
    rootAbs: base.rootAbs,
    ...(base.projectId ? { projectId: base.projectId } : {}),
    ...(base.pluginName ? { pluginName: base.pluginName } : {}),
    ...spec,
    origin: spec.origin ?? base.origin,
  };
}

function cov(
  ctx: AdapterContext,
  rootAbs: string,
  agent: ResourceAgent,
  category: CoverageCategory,
  status: CoverageStatus,
  extra: { count?: number; bytes?: number; note?: string } = {},
): CoverageEntry {
  return { root: ctx.display(rootAbs), agent, category, status, ...extra };
}

function merge(results: readonly AdapterResult[]): AdapterResult {
  return {
    entries: results.flatMap((r) => r.entries),
    coverage: results.flatMap((r) => r.coverage),
    findings: results.flatMap((r) => r.findings),
  };
}

function statusOf(found: number, listing: ListStatus): CoverageStatus {
  if (listing !== 'ok') return listing;
  return found > 0 ? 'scanned' : 'empty';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function okValue(read: ConfigRead): unknown {
  return read.status === 'ok' ? read.value : undefined;
}

const entriesOf = (results: readonly ReadResult[]): RawEntry[] => results.flatMap((r) => (r.entry ? [r.entry] : []));
const findingsOf = (results: readonly ReadResult[]): ResourceFinding[] => results.flatMap((r) => (r.finding ? [r.finding] : []));

// ---------------------------------------------------------------------------
// Category builders shared by every root
// ---------------------------------------------------------------------------

async function skillAt(dir: string, d: Dirent, base: Base, ctx: AdapterContext, repoPrefix?: string): Promise<RawEntry | null> {
  const abs = join(dir, d.name);
  const kind = await statKind(abs, ctx.limit);
  const repoRel = repoPrefix && base.origin === 'user' ? `${repoPrefix}/${d.name}` : undefined;
  const spec = { type: 'skill', format: 'markdown', name: d.name, absPath: abs, kind: 'package', repoRel } as const;
  // A dangling symlink is still listed — the user meant a skill to be there.
  if (kind === null) return d.isSymbolicLink() ? makeEntry(base, spec) : null;
  if (kind !== 'dir') return null;
  if (d.name === '_shared') return makeEntry(base, { ...spec, description: SHARED_DIR_DESCRIPTION, notASkill: true });
  return (await statKind(join(abs, 'SKILL.md'), ctx.limit)) === 'file' ? makeEntry(base, spec) : null;
}

/** `skills/synced/<id>/<name>/` — claude.ai-synced skills; `<id>/manifest.json` may describe them. */
async function syncedSkills(dir: string, base: Base, ctx: AdapterContext): Promise<RawEntry[]> {
  const ids = await listDir(dir, ctx.limit);
  if (ids.status !== 'ok') return [];
  const perId = await Promise.all(
    ids.entries.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map(async (d) => {
      const idDir = join(dir, d.name);
      const manifest = okValue(await ctx.readConfig(join(idDir, 'manifest.json'), 'json'));
      const listed = isRecord(manifest) && Array.isArray(manifest.skills) ? manifest.skills.filter(isRecord) : [];
      const descriptions = new Map(listed
        .filter((s) => typeof s.name === 'string' && typeof s.description === 'string')
        .map((s) => [s.name as string, s.description as string]));
      const found = await skillPackages(idDir, { ...base, origin: 'synced' }, ctx);
      return found.entries.map((e) => (descriptions.has(e.name) ? { ...e, description: descriptions.get(e.name) } : e));
    }),
  );
  return perId.flat();
}

/** `skills/<name>/SKILL.md` packages, plus the `_shared`, `synced/` and `.system/` tiers. */
async function skillPackages(
  dir: string,
  base: Base,
  ctx: AdapterContext,
  tiers: { synced?: boolean; system?: boolean; repoPrefix?: string } = {},
): Promise<Found> {
  const listing = await listDir(dir, ctx.limit);
  if (listing.status !== 'ok') return { entries: [], status: listing.status };
  const nested = await Promise.all(listing.entries.map(async (d): Promise<RawEntry[]> => {
    if (tiers.synced && d.name === 'synced') return syncedSkills(join(dir, d.name), base, ctx);
    if (tiers.system && d.name === '.system') {
      return (await skillPackages(join(dir, d.name), { ...base, origin: 'system' }, ctx)).entries;
    }
    if (d.name.startsWith('.')) return [];
    const one = await skillAt(dir, d, base, ctx, tiers.repoPrefix);
    return one ? [one] : [];
  }));
  const entries = nested.flat();
  return { entries, status: statusOf(entries.length, 'ok') };
}

/** `**\/*.md` — commands are named `ns:name`, agents by path sans `.md`, rules and memory by path. */
async function markdownEntries(
  dir: string,
  base: Base,
  ctx: AdapterContext,
  type: 'command' | 'rule' | 'agent' | 'memory',
  repoPrefix?: string,
): Promise<Found> {
  const tree = await listTree(dir, ctx.limit, {
    accept: (n) => /\.md$/i.test(n), maxDepth: ctx.limits.treeMaxDepth, maxFiles: ctx.limits.treeMaxFiles,
  });
  const entries = tree.files.map((f) => {
    const bare = f.rel.replace(/\.md$/i, '');
    const name = type === 'command' ? bare.replace(/\//g, ':') : type === 'agent' ? bare : f.rel;
    const repoRel = repoPrefix && base.origin === 'user' ? `${repoPrefix}/${f.rel}` : undefined;
    return makeEntry(base, { type, format: 'markdown', name, absPath: f.abs, kind: 'file', repoRel });
  });
  const note = listingNote(tree, ctx.limits.treeMaxFiles);
  return { entries, status: statusOf(entries.length, tree.status), ...(note ? { note } : {}) };
}

async function flatEntries(
  dir: string,
  base: Base,
  ctx: AdapterContext,
  spec: { type: ResourceType; format: ResourceFormat; ext?: RegExp; stripExt?: boolean; repoPrefix?: string },
): Promise<Found> {
  const listed = await listFlatFiles(dir, ctx.limit, (n) => n !== '.DS_Store' && (!spec.ext || spec.ext.test(n)));
  const entries = listed.files.map((f) => makeEntry(base, {
    type: spec.type,
    format: spec.format,
    name: spec.stripExt && spec.ext ? f.name.replace(spec.ext, '') : f.name,
    absPath: f.abs,
    kind: 'file',
    repoRel: spec.repoPrefix && base.origin === 'user' ? `${spec.repoPrefix}/${f.name}` : undefined,
  }));
  return { entries, status: statusOf(entries.length, listed.status) };
}

interface InstructionName {
  file: string;
  agent: ResourceAgent;
  pair?: boolean;
  repoRel?: string;
}

/** The instruction files among `names` that exist in `dir` (a dangling symlink counts, to be reported). */
async function instructionEntries(
  dir: string,
  names: readonly InstructionName[],
  base: Omit<Base, 'agent'>,
  ctx: AdapterContext,
  group: string,
): Promise<RawEntry[]> {
  const listing = await listDir(dir, ctx.limit);
  const links = new Set(listing.status === 'ok' ? listing.entries.filter((d) => d.isSymbolicLink()).map((d) => d.name) : []);
  const found = await Promise.all(names.map(async (n) => {
    const abs = join(dir, n.file);
    const kind = await statKind(abs, ctx.limit);
    if (kind !== 'file' && !(kind === null && links.has(n.file))) return null;
    return makeEntry({ ...base, agent: n.agent }, {
      type: 'instructions', format: 'markdown', name: n.file, absPath: abs, kind: 'file',
      ...(n.repoRel && base.origin === 'user' ? { repoRel: n.repoRel } : {}),
      ...(n.pair ? { variantGroup: group } : {}),
    });
  }));
  return found.filter((e): e is RawEntry => e !== null);
}

function hookEntries(parsed: unknown, fileAbs: string, base: Base): RawEntry[] {
  if (!isRecord(parsed) || !isRecord(parsed.hooks)) return [];
  // Only arrays are events: Codex keeps a `hooks.state` trust table beside them.
  return Object.entries(parsed.hooks)
    .filter(([, groups]) => Array.isArray(groups))
    .map(([event, groups]) => makeEntry(base, {
      type: 'hook', format: 'config', name: event, absPath: fileAbs, kind: 'config-entry',
      subKey: `hooks:${event}`, config: { value: groups, wrap: ['hooks', event] },
    }));
}

function mcpEntries(table: unknown, fileAbs: string, base: Base, subKeyPrefix: string): RawEntry[] {
  if (!isRecord(table)) return [];
  return Object.entries(table)
    .filter(([, server]) => isRecord(server))
    .map(([name, server]) => makeEntry(base, {
      type: 'mcp', format: 'config', name, absPath: fileAbs, kind: 'config-entry',
      subKey: `${subKeyPrefix}:${name}`, config: { value: server, wrap: [] },
    }));
}

function parseErrorFinding(ctx: AdapterContext, fileAbs: string, error: string, resourceId?: string): ResourceFinding {
  return {
    code: 'config-parse-error',
    severity: 'error',
    ...(resourceId ? { resourceId } : { path: ctx.display(fileAbs) }),
    message: `${ctx.display(fileAbs)} could not be parsed: ${error}`,
  };
}

/** A whole config file as a settings resource; one that fails to parse is still listed, with the finding. */
async function settingsFile(fileAbs: string, kind: 'json' | 'toml', base: Base, ctx: AdapterContext): Promise<ReadResult> {
  const read = await ctx.readConfig(fileAbs, kind);
  if (read.status === 'missing') return { read };
  // ~/.claude.json sits in ~, not under ~/.claude: judge "linked" against its own folder.
  const rootAbs = fileAbs.startsWith(base.rootAbs + sep) ? base.rootAbs : dirname(fileAbs);
  const entry = makeEntry({ ...base, rootAbs }, {
    type: 'settings', format: 'config', name: basename(fileAbs), absPath: fileAbs, kind: 'config-file',
    ...(read.status === 'ok' ? { config: { value: read.value, wrap: [] } } : {}),
  });
  return read.status === 'failed' ? { read, entry, finding: parseErrorFinding(ctx, fileAbs, read.error, entry.id) } : { read, entry };
}

function configStatus(reads: readonly ConfigRead[], found: number): CoverageStatus {
  if (reads.some((r) => r.status === 'failed')) return 'failed';
  if (reads.every((r) => r.status === 'missing')) return 'not-found';
  return found > 0 ? 'scanned' : 'empty';
}

/** Hooks come from settings files AND a hooks/ dir; "not found" needs both to be absent. */
function hookStatus(reads: readonly ConfigRead[], found: number, filesStatus: CoverageStatus): CoverageStatus {
  if (reads.some((r) => r.status === 'failed')) return 'failed';
  if (found > 0) return 'scanned';
  return filesStatus === 'not-found' && reads.every((r) => r.status === 'missing') ? 'not-found' : 'empty';
}

/** `{ note }` naming the config files that failed to parse, or `{}`. */
function failedNote(ctx: AdapterContext, files: readonly string[], reads: readonly ConfigRead[]): { note?: string } {
  const failed = files.filter((_, i) => reads[i]?.status === 'failed');
  return failed.length ? { note: `could not parse ${failed.map(ctx.display).join(', ')}` } : {};
}

// ---------------------------------------------------------------------------
// Claude global
// ---------------------------------------------------------------------------

/** settings.json, settings.local.json and ~/.claude.json → settings, their hooks, and MCP servers. */
async function claudeConfigs(ctx: AdapterContext, base: Base): Promise<AdapterResult> {
  const root = ctx.roots.claudeRoot;
  const settingsPaths = [join(root, 'settings.json'), join(root, 'settings.local.json')];
  const files = [...settingsPaths, ctx.roots.claudeConfigJson];
  const [results, hookFiles] = await Promise.all([
    Promise.all(files.map((f) => settingsFile(f, 'json', base, ctx))),
    flatEntries(join(root, 'hooks'), base, ctx, { type: 'hook', format: 'script', repoPrefix: 'claude/hooks' }),
  ]);
  const reads = results.map((r) => r.read);
  const hooks = [...settingsPaths.flatMap((f, i) => hookEntries(okValue(reads[i]), f, base)), ...hookFiles.entries];
  const mcp = await claudeJsonMcp(ctx, base, reads[2]);
  const settings = entriesOf(results);
  return {
    entries: [...settings, ...hooks, ...mcp],
    findings: findingsOf(results),
    coverage: [
      cov(ctx, root, 'claude', 'settings', configStatus(reads, settings.length), {
        count: settings.length, ...failedNote(ctx, files, reads),
      }),
      cov(ctx, root, 'claude', 'hook', hookStatus(reads.slice(0, 2), hooks.length, hookFiles.status), {
        count: hooks.length, ...failedNote(ctx, settingsPaths, reads),
      }),
      cov(ctx, root, 'claude', 'mcp', configStatus([reads[2]], mcp.length), {
        count: mcp.length, note: `from ${ctx.display(ctx.roots.claudeConfigJson)}`,
      }),
    ],
  };
}

/** `mcpServers` (global) and `projects[<path>].mcpServers` (project scope) from ~/.claude.json. */
async function claudeJsonMcp(ctx: AdapterContext, base: Base, read: ConfigRead): Promise<RawEntry[]> {
  const value = okValue(read);
  if (!isRecord(value)) return [];
  const file = ctx.roots.claudeConfigJson;
  const projects = isRecord(value.projects) ? Object.entries(value.projects) : [];
  const perProject = await Promise.all(projects.map(async ([path, cfg]) => {
    if (!isRecord(cfg) || !isRecord(cfg.mcpServers)) return [];
    const projectId = await ctx.projectIdFor(path);
    return mcpEntries(cfg.mcpServers, file, { ...base, scope: 'project', projectId }, `projects:${path}:mcpServers`);
  }));
  return [...mcpEntries(value.mcpServers, file, base, 'mcpServers'), ...perProject.flat()];
}

interface PluginInstall {
  key: string;
  index: number;
  raw: Record<string, unknown>;
  installPath?: string;
}

function pluginInstalls(read: ConfigRead): PluginInstall[] {
  const value = okValue(read);
  if (!isRecord(value) || !isRecord(value.plugins)) return [];
  return Object.entries(value.plugins).flatMap(([key, installs]) =>
    (Array.isArray(installs) ? installs : []).filter(isRecord).map((raw, index) => ({
      key,
      index,
      raw,
      ...(typeof raw.installPath === 'string' && raw.installPath ? { installPath: raw.installPath } : {}),
    })));
}

/** What a plugin record SHOWS: version, scope, install path as `~/…` — never a walk of the cache. */
function pluginDisplayRecord(install: PluginInstall, ctx: AdapterContext): Record<string, unknown> {
  const pick = (k: string) => (install.raw[k] !== undefined ? { [k]: install.raw[k] } : {});
  return {
    ...pick('version'),
    ...pick('scope'),
    ...(install.installPath ? { installPath: ctx.display(install.installPath) } : {}),
    ...pick('installedAt'),
    ...pick('lastUpdated'),
  };
}

async function pluginBase(install: PluginInstall, base: Base, ctx: AdapterContext): Promise<Base> {
  const { scope, projectPath } = install.raw;
  if ((scope !== 'project' && scope !== 'local') || typeof projectPath !== 'string') return base;
  const projectId = await ctx.projectIdFor(projectPath);
  return projectId ? { ...base, scope: 'project', projectId } : base;
}

async function pluginItems(install: PluginInstall, base: Base, ctx: AdapterContext): Promise<RawEntry[]> {
  const root = install.installPath;
  if (!root || (await statKind(root, ctx.limit)) !== 'dir') return [];
  const itemBase: Base = { ...base, origin: 'plugin', rootAbs: root, pluginName: install.key.split('@')[0] };
  const found = await Promise.all([
    skillPackages(join(root, 'skills'), itemBase, ctx),
    markdownEntries(join(root, 'commands'), itemBase, ctx, 'command'),
    markdownEntries(join(root, 'agents'), itemBase, ctx, 'agent'),
  ]);
  return found.flatMap((f) => f.entries);
}

async function claudePlugins(ctx: AdapterContext, base: Base): Promise<AdapterResult> {
  const root = ctx.roots.claudeRoot;
  const manifest = join(root, 'plugins', 'installed_plugins.json');
  const read = await ctx.readConfig(manifest, 'json');
  const installs = pluginInstalls(read);
  const firstForPath = installs.filter((i, n) => i.installPath && installs.findIndex((j) => j.installPath === i.installPath) === n);
  const [records, items] = await Promise.all([
    Promise.all(installs.map(async (install) => makeEntry(await pluginBase(install, base, ctx), {
      type: 'plugin', format: 'config', name: install.key, absPath: manifest, kind: 'config-entry',
      subKey: `plugins:${install.key}:${install.index}`,
      config: { value: pluginDisplayRecord(install, ctx), wrap: [] },
      hashInput: install.raw,
    }))),
    Promise.all(firstForPath.map(async (install) => pluginItems(install, await pluginBase(install, base, ctx), ctx))),
  ]);
  const contents = items.flat();
  return {
    entries: [...records, ...contents],
    findings: read.status === 'failed' ? [parseErrorFinding(ctx, manifest, read.error)] : [],
    coverage: [
      cov(ctx, root, 'claude', 'plugin', configStatus([read], records.length), { count: records.length }),
      cov(ctx, root, 'claude', 'plugin-contents', contents.length ? 'scanned' : 'empty', {
        count: contents.length, note: 'current install only — plugins/cache and plugins/marketplaces are not walked',
      }),
    ],
  };
}

/** `projects/<encoded>/memory/**` (memory, per project) and `projects/<encoded>/*.jsonl` (sized only). */
async function claudeProjectsDir(ctx: AdapterContext, base: Base): Promise<AdapterResult> {
  const root = ctx.roots.claudeRoot;
  const projectsDir = join(root, 'projects');
  const listing = await listDir(projectsDir, ctx.limit);
  const dirs = listing.status === 'ok' ? listing.entries.filter((d) => d.isDirectory()) : [];
  const perDir = await Promise.all(dirs.map(async (d) => {
    const projectId = ctx.encodedToProject.get(d.name);
    // Orphaned means GONE: a folder we may not open still has an owner.
    const orphaned = ctx.projects.some((p) => p.id === projectId && !p.exists && !p.inaccessible);
    const found = await markdownEntries(join(projectsDir, d.name, 'memory'), {
      ...base, scope: 'project', ...(projectId ? { projectId } : {}),
    }, ctx, 'memory');
    const transcripts = await listFlatFiles(join(projectsDir, d.name), ctx.limit, (n) => n.endsWith('.jsonl'));
    const sizes = await Promise.all(transcripts.files.map((f) => lstatSize(f.abs, ctx.limit)));
    return {
      memory: found.entries.map((e) => (orphaned ? { ...e, orphaned: true } : e)),
      count: sizes.length,
      bytes: sizes.reduce<number>((a, b) => a + (b ?? 0), 0),
    };
  }));
  const memory = perDir.flatMap((p) => p.memory);
  const sessions = { count: perDir.reduce((a, p) => a + p.count, 0), bytes: perDir.reduce((a, p) => a + p.bytes, 0) };
  const listed = listing.status === 'ok' ? 'ok' : listing.status;
  return {
    entries: memory,
    findings: [],
    coverage: [
      cov(ctx, root, 'claude', 'memory', statusOf(memory.length, listed), { count: memory.length }),
      cov(ctx, root, 'claude', 'sessions', listed === 'ok' ? 'not-scanned' : listed, { ...sessions, note: PHASE_D_NOTE }),
    ],
  };
}

export async function adaptClaudeGlobal(ctx: AdapterContext): Promise<AdapterResult> {
  const root = ctx.roots.claudeRoot;
  const base: Base = { agent: 'claude', scope: 'global', origin: 'user', rootAbs: root };
  const [skills, commands, rules, agents, instructions, ...rest] = await Promise.all([
    skillPackages(join(root, 'skills'), base, ctx, { synced: true, repoPrefix: 'claude/skills' }),
    markdownEntries(join(root, 'commands'), base, ctx, 'command', 'claude/commands'),
    markdownEntries(join(root, 'rules'), base, ctx, 'rule', 'claude/rules'),
    markdownEntries(join(root, 'agents'), base, ctx, 'agent'),
    instructionEntries(root, [{ file: 'CLAUDE.md', agent: 'claude', pair: true }, { file: 'CLAUDE.local.md', agent: 'claude' }], base, ctx, 'global'),
    claudeConfigs(ctx, base),
    claudePlugins(ctx, base),
    claudeProjectsDir(ctx, base),
  ]);
  const listed: Array<[CoverageCategory, Found]> = [['skill', skills], ['command', commands], ['rule', rules], ['agent', agents]];
  const data = await Promise.all([sizedFile(ctx, root, 'claude', 'history', 'history.jsonl'), claudeCredentials(ctx, root)]);
  return merge([
    {
      entries: [...listed.flatMap(([, f]) => f.entries), ...instructions],
      findings: [],
      coverage: [
        ...listed.map(([category, f]) => cov(ctx, root, 'claude', category, f.status, {
          count: f.entries.length, ...(f.note ? { note: f.note } : {}),
        })),
        cov(ctx, root, 'claude', 'instructions', instructions.length ? 'scanned' : 'not-found', { count: instructions.length }),
        ...data,
      ],
    },
    ...rest,
  ]);
}

// ---------------------------------------------------------------------------
// Codex global
// ---------------------------------------------------------------------------

interface CodexToml {
  read: ConfigRead;
  settings: ReadResult;
  hooks: RawEntry[];
  mcp: RawEntry[];
  plugins: RawEntry[];
}

/** config.toml → the settings resource, its hooks and MCP servers, and (global only) plugin records. */
async function codexToml(fileAbs: string, base: Base, ctx: AdapterContext, withPlugins: boolean): Promise<CodexToml> {
  const settings = await settingsFile(fileAbs, 'toml', base, ctx);
  const value = okValue(settings.read);
  const table = isRecord(value) ? value : {};
  const plugins = withPlugins && isRecord(table.plugins)
    ? Object.entries(table.plugins).filter(([, v]) => isRecord(v)).map(([name, v]) => makeEntry(base, {
      type: 'plugin', format: 'config', name, absPath: fileAbs, kind: 'config-entry',
      subKey: `plugins:${name}`, config: { value: v, wrap: ['plugins', name] },
    }))
    : [];
  return {
    read: settings.read,
    settings,
    hooks: hookEntries(value, fileAbs, base),
    mcp: mcpEntries(table.mcp_servers, fileAbs, base, 'mcp_servers'),
    plugins,
  };
}

export async function adaptCodexGlobal(ctx: AdapterContext): Promise<AdapterResult> {
  const root = ctx.roots.codexRoot;
  const base: Base = { agent: 'codex', scope: 'global', origin: 'user', rootAbs: root };
  const [skills, prompts, rules, memory, hookFiles, instructions, toml, keys, data] = await Promise.all([
    skillPackages(join(root, 'skills'), base, ctx, { system: true, repoPrefix: 'codex/skills' }),
    flatEntries(join(root, 'prompts'), base, ctx, { type: 'command', format: 'markdown', ext: /\.md$/i, stripExt: true, repoPrefix: 'codex/prompts' }),
    flatEntries(join(root, 'rules'), base, ctx, { type: 'rule', format: 'policy', ext: /\.rules$/i, repoPrefix: 'codex/rules' }),
    markdownEntries(join(root, 'memories'), base, ctx, 'memory'),
    flatEntries(join(root, 'hooks'), base, ctx, { type: 'hook', format: 'script' }),
    instructionEntries(root, [
      { file: 'AGENTS.md', agent: 'codex', pair: true, repoRel: 'codex/AGENTS.md' },
      { file: 'AGENTS.override.md', agent: 'codex' },
    ], base, ctx, 'global'),
    codexToml(join(root, 'config.toml'), base, ctx, true),
    settingsFile(join(root, 'keybindings.json'), 'json', base, ctx),
    codexData(ctx, root),
  ]);
  const settings = entriesOf([toml.settings, keys]);
  const hooks = [...toml.hooks, ...hookFiles.entries];
  const listed: Array<[CoverageCategory, Found]> = [['skill', skills], ['command', prompts], ['rule', rules], ['memory', memory]];
  return {
    entries: [...listed.flatMap(([, f]) => f.entries), ...instructions, ...settings, ...hooks, ...toml.mcp, ...toml.plugins],
    findings: findingsOf([toml.settings, keys]),
    coverage: [
      ...listed.map(([category, f]) => cov(ctx, root, 'codex', category, f.status, { count: f.entries.length, ...(f.note ? { note: f.note } : {}) })),
      cov(ctx, root, 'codex', 'instructions', instructions.length ? 'scanned' : 'not-found', { count: instructions.length }),
      cov(ctx, root, 'codex', 'settings', configStatus([toml.read, keys.read], settings.length), { count: settings.length }),
      cov(ctx, root, 'codex', 'hook', hookStatus([toml.read], hooks.length, hookFiles.status), { count: hooks.length }),
      cov(ctx, root, 'codex', 'mcp', configStatus([toml.read], toml.mcp.length), { count: toml.mcp.length }),
      cov(ctx, root, 'codex', 'plugin', configStatus([toml.read], toml.plugins.length), { count: toml.plugins.length }),
      ...data,
    ],
  };
}

// ---------------------------------------------------------------------------
// ~/.agents
// ---------------------------------------------------------------------------

export async function adaptSharedGlobal(ctx: AdapterContext): Promise<AdapterResult> {
  const root = ctx.roots.sharedRoot;
  const skills = await skillPackages(join(root, 'skills'), { agent: 'shared', scope: 'global', origin: 'user', rootAbs: root }, ctx);
  return {
    entries: skills.entries,
    findings: [],
    coverage: [cov(ctx, root, 'shared', 'skill', skills.status, { count: skills.entries.length })],
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const CLAUDE_DIR_CATEGORIES = ['skill', 'command', 'rule', 'agent'] as const;

async function claudeDirEntries(dotClaude: string, base: Base, ctx: AdapterContext): Promise<Found[]> {
  return Promise.all([
    skillPackages(join(dotClaude, 'skills'), base, ctx),
    markdownEntries(join(dotClaude, 'commands'), base, ctx, 'command'),
    markdownEntries(join(dotClaude, 'rules'), base, ctx, 'rule'),
    markdownEntries(join(dotClaude, 'agents'), base, ctx, 'agent'),
  ]);
}

/** A nested walk never enters another project (those files are its own) or a global root. */
function blockedFor(project: ProjectRecord, ctx: AdapterContext): Set<string> {
  const others = ctx.projects.filter((p) => p.exists && p.id !== project.id).map((p) => p.absPath);
  const { claudeRoot, codexRoot, sharedRoot, home, homeReal } = ctx.roots;
  return new Set([...others, claudeRoot, codexRoot, sharedRoot, home, homeReal]);
}

async function projectClaude(root: string, base: Base, ctx: AdapterContext, nested: NestedFinds): Promise<AdapterResult> {
  const settingsPaths = [join(root, '.claude', 'settings.json'), join(root, '.claude', 'settings.local.json')];
  const mcpFile = join(root, '.mcp.json');
  const [own, nestedDirs, results, hookFiles, mcpRead] = await Promise.all([
    claudeDirEntries(join(root, '.claude'), base, ctx),
    Promise.all(nested.claudeDirs.map((d) => claudeDirEntries(d, base, ctx))),
    Promise.all(settingsPaths.map((f) => settingsFile(f, 'json', base, ctx))),
    flatEntries(join(root, '.claude', 'hooks'), base, ctx, { type: 'hook', format: 'script' }),
    ctx.readConfig(mcpFile, 'json'),
  ]);
  const reads = results.map((r) => r.read);
  const settings = entriesOf(results);
  const hooks = [...settingsPaths.flatMap((f, i) => hookEntries(okValue(reads[i]), f, base)), ...hookFiles.entries];
  const mcpValue = okValue(mcpRead);
  const mcp = isRecord(mcpValue) ? mcpEntries(mcpValue.mcpServers, mcpFile, base, 'mcpServers') : [];
  const mcpCount = mcp.length + (base.projectId ? ctx.claudeJsonMcpCount?.(base.projectId) ?? 0 : 0);
  const categories = CLAUDE_DIR_CATEGORIES.map((category, i) => {
    const entries = [own[i], ...nestedDirs.map((n) => n[i])].flatMap((f) => f.entries);
    return { category, entries, status: entries.length ? ('scanned' as const) : own[i].status, note: own[i].note };
  });
  return {
    entries: [...categories.flatMap((c) => c.entries), ...settings, ...hooks, ...mcp],
    findings: [...findingsOf(results), ...(mcpRead.status === 'failed' ? [parseErrorFinding(ctx, mcpFile, mcpRead.error)] : [])],
    coverage: [
      ...categories.map((c) => cov(ctx, root, 'claude', c.category, c.status, { count: c.entries.length, ...(c.note ? { note: c.note } : {}) })),
      cov(ctx, root, 'claude', 'settings', configStatus(reads, settings.length), { count: settings.length, ...failedNote(ctx, settingsPaths, reads) }),
      cov(ctx, root, 'claude', 'hook', hookStatus(reads, hooks.length, hookFiles.status), { count: hooks.length, ...failedNote(ctx, settingsPaths, reads) }),
      cov(ctx, root, 'claude', 'mcp', mcpRead.status === 'failed' ? 'failed' : mcpCount ? 'scanned'
        : mcpRead.status === 'missing' ? 'not-found' : 'empty', { count: mcpCount, ...failedNote(ctx, [mcpFile], [mcpRead]) }),
    ],
  };
}

async function projectCodexAndShared(root: string, projectId: string, ctx: AdapterContext): Promise<AdapterResult> {
  const codex: Base = { agent: 'codex', scope: 'project', origin: 'user', rootAbs: root, projectId };
  const [skills, prompts, toml, shared] = await Promise.all([
    skillPackages(join(root, '.codex', 'skills'), codex, ctx),
    flatEntries(join(root, '.codex', 'prompts'), codex, ctx, { type: 'command', format: 'markdown', ext: /\.md$/i, stripExt: true }),
    codexToml(join(root, '.codex', 'config.toml'), codex, ctx, false),
    skillPackages(join(root, '.agents', 'skills'), { ...codex, agent: 'shared' }, ctx),
  ]);
  const settings = entriesOf([toml.settings]);
  const status = (found: number) => configStatus([toml.read], found);
  return {
    entries: [...skills.entries, ...prompts.entries, ...settings, ...toml.hooks, ...toml.mcp, ...shared.entries],
    findings: findingsOf([toml.settings]),
    coverage: [
      cov(ctx, root, 'codex', 'skill', skills.status, { count: skills.entries.length }),
      cov(ctx, root, 'codex', 'command', prompts.status, { count: prompts.entries.length }),
      cov(ctx, root, 'codex', 'settings', status(settings.length), { count: settings.length }),
      cov(ctx, root, 'codex', 'hook', status(toml.hooks.length), { count: toml.hooks.length }),
      cov(ctx, root, 'codex', 'mcp', status(toml.mcp.length), { count: toml.mcp.length }),
      cov(ctx, root, 'shared', 'skill', shared.status, { count: shared.entries.length }),
    ],
  };
}

const ROOT_INSTRUCTIONS: readonly InstructionName[] = [
  { file: 'CLAUDE.md', agent: 'claude', pair: true },
  { file: 'CLAUDE.local.md', agent: 'claude' },
  { file: 'AGENTS.md', agent: 'codex', pair: true },
  { file: 'AGENTS.override.md', agent: 'codex' },
];

/**
 * Root, `.claude/CLAUDE.md` and nested instructions. `nested === null` is the
 * home project: only `~/CLAUDE.md` and `~/AGENTS.md` — its dot-dirs ARE the
 * global roots and would otherwise be counted twice.
 */
async function projectInstructions(root: string, projectId: string, ctx: AdapterContext, nested: NestedFinds | null): Promise<AdapterResult> {
  const base = { scope: 'project' as const, origin: 'user' as const, rootAbs: root, projectId };
  const names = nested ? ROOT_INSTRUCTIONS : ROOT_INSTRUCTIONS.filter((n) => n.pair);
  const [top, dotClaude] = await Promise.all([
    instructionEntries(root, names, base, ctx, `dir:${root}`),
    nested ? instructionEntries(join(root, '.claude'), [{ file: 'CLAUDE.md', agent: 'claude' }], base, ctx, '') : [],
  ]);
  const nestedEntries = (nested?.instructions ?? []).map(({ dir, rel }) => makeEntry(
    { ...base, agent: basename(rel) === 'CLAUDE.md' ? 'claude' : 'codex' },
    { type: 'instructions', format: 'markdown', name: rel, absPath: join(dir, basename(rel)), kind: 'file', variantGroup: `dir:${dir}` },
  ));
  const entries = [...top, ...dotClaude.map((e) => ({ ...e, name: '.claude/CLAUDE.md' })), ...nestedEntries];
  const note = !nested ? 'home: only its own CLAUDE.md / AGENTS.md are read'
    : nested.capped ? `capped at ${ctx.limits.projectMaxDirents.toLocaleString('en-US')} entries` : undefined;
  return {
    entries,
    findings: [],
    coverage: (['claude', 'codex'] as const).map((agent) => {
      const count = entries.filter((e) => e.agent === agent).length;
      return cov(ctx, root, agent, 'instructions', count ? 'scanned' : 'not-found', { count, ...(note ? { note } : {}) });
    }),
  };
}

/**
 * Every resource inside one existing project folder. A missing project yields
 * nothing — its record says so; one that may not be opened yields only coverage
 * rows reading `inaccessible`.
 */
export async function adaptProject(project: ProjectRecord, ctx: AdapterContext): Promise<AdapterResult> {
  if (project.inaccessible) return { ...EMPTY, coverage: inaccessibleProjectCoverage(ctx, project) };
  if (!project.exists) return EMPTY;
  if (project.isHome) return projectInstructions(project.absPath, project.id, ctx, null);
  const root = project.absPath;
  const nested = await walkProjectNested(root, {
    limit: ctx.limit,
    maxDepth: ctx.limits.nestedDepth,
    maxDirents: ctx.limits.projectMaxDirents,
    blocked: blockedFor(project, ctx),
  });
  const claude: Base = { agent: 'claude', scope: 'project', origin: 'user', rootAbs: root, projectId: project.id };
  return merge(await Promise.all([
    projectClaude(root, claude, ctx, nested),
    projectCodexAndShared(root, project.id, ctx),
    projectInstructions(root, project.id, ctx, nested),
  ]));
}

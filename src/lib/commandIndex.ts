/**
 * Client-side command/skill index.
 *
 * Fetches `/api/commands?cli=&projectPath=` and caches the result in memory
 * for 30 seconds keyed by (cli, projectPath). Used by the queue autocomplete
 * to surface every available slash command and skill for the session's CLI.
 */

export type CommandKind = 'command' | 'skill';
export type CommandSource = 'project' | 'global' | 'plugin' | 'builtin';

export interface CommandEntry {
  name: string;
  description: string;
  cli: 'claude' | 'codex' | 'gemini';
  kind: CommandKind;
  source: CommandSource;
  sourcePath?: string;
  pluginName?: string;
}

const TTL_MS = 30_000;
const cache = new Map<string, { ts: number; entries: CommandEntry[] }>();
const inflight = new Map<string, Promise<CommandEntry[]>>();

function cacheKey(cli: string, projectPath: string | null | undefined): string {
  return `${cli}|${projectPath ?? ''}`;
}

/** Fetch the full command index for a CLI scoped to an optional project root. */
export async function fetchCommandIndex(
  cli: 'claude' | 'codex' | 'gemini',
  projectPath: string | null | undefined,
): Promise<CommandEntry[]> {
  const key = cacheKey(cli, projectPath);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.entries;
  const existing = inflight.get(key);
  if (existing) return existing;

  const params = new URLSearchParams({ cli });
  if (projectPath) params.set('projectPath', projectPath);

  // Distinguish "fetch returned empty" (cache as a real result) from
  // "fetch failed transiently" (do NOT cache — retry on the next call).
  const promise = fetch(`/api/commands?${params.toString()}`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { entries?: CommandEntry[] };
      return data.entries ?? [];
    })
    .then(
      (entries) => {
        cache.set(key, { ts: Date.now(), entries });
        inflight.delete(key);
        return entries;
      },
      () => {
        // Transient error — clear in-flight so the next call retries the
        // network instead of being served a poisoned-empty cache for 30s.
        inflight.delete(key);
        return [] as CommandEntry[];
      },
    );

  inflight.set(key, promise);
  return promise;
}

/** Drop the cached entry for a CLI+project, forcing the next fetch to refresh. */
export function invalidateCommandIndex(
  cli: 'claude' | 'codex' | 'gemini',
  projectPath: string | null | undefined,
): void {
  cache.delete(cacheKey(cli, projectPath));
}

/**
 * Compute the display name for an entry — plugin entries get prefixed with
 * the plugin slug so they match how the user would type them.
 */
export function entryDisplayName(entry: CommandEntry): string {
  if (entry.source === 'plugin' && entry.pluginName) {
    return `${entry.pluginName}:${entry.name}`;
  }
  return entry.name;
}

/** Source label for the chip. */
export function entrySourceLabel(entry: CommandEntry): string {
  switch (entry.source) {
    case 'project':
      return 'project';
    case 'global':
      return 'global';
    case 'plugin':
      return entry.pluginName ? `plugin: ${entry.pluginName}` : 'plugin';
    case 'builtin':
      return 'built-in';
    default:
      return entry.source;
  }
}

export interface CommandGroup {
  title: string;
  source: CommandSource;
  entries: CommandEntry[];
}

/**
 * Filter `entries` to those whose display name starts with `query` (case
 * insensitive), then bucket into ordered groups: built-in → project → global
 * → plugin (one group per plugin). Empty groups are dropped.
 */
export function filterAndGroup(
  entries: CommandEntry[],
  query: string,
  kind: 'command' | 'skill',
): CommandGroup[] {
  const q = query.toLowerCase();
  const matches: CommandEntry[] = [];
  for (const e of entries) {
    if (e.kind !== kind) continue;
    const display = entryDisplayName(e).toLowerCase();
    if (!q || display.startsWith(q) || display.includes(q)) {
      matches.push(e);
    }
  }
  // Stable sort: exact prefix matches first, then alpha
  matches.sort((a, b) => {
    const aName = entryDisplayName(a).toLowerCase();
    const bName = entryDisplayName(b).toLowerCase();
    const aPrefix = q && aName.startsWith(q) ? 0 : 1;
    const bPrefix = q && bName.startsWith(q) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    return aName.localeCompare(bName);
  });

  const groups: Record<string, CommandGroup> = {};
  const order: string[] = [];
  for (const entry of matches) {
    const key =
      entry.source === 'plugin' && entry.pluginName
        ? `plugin:${entry.pluginName}`
        : entry.source;
    if (!groups[key]) {
      const title =
        entry.source === 'builtin'
          ? 'Built-in'
          : entry.source === 'project'
            ? 'Project'
            : entry.source === 'global'
              ? 'Global'
              : entry.pluginName
                ? `Plugin: ${entry.pluginName}`
                : 'Plugin';
      groups[key] = { title, source: entry.source, entries: [] };
      order.push(key);
    }
    groups[key].entries.push(entry);
  }

  // Order: builtin, project, global, then plugins
  const sourceRank = (s: string): number =>
    s === 'builtin' ? 0 : s === 'project' ? 1 : s === 'global' ? 2 : 3;
  order.sort((a, b) => sourceRank(a.split(':')[0]) - sourceRank(b.split(':')[0]));
  return order.map((k) => groups[k]);
}

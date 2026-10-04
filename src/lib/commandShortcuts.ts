/**
 * Shortcut commands — the one rule that links an alias command to the skill or
 * command it expands to.
 *
 * A shortcut is a command whose description starts `Shortcut for /<target>`
 * (or `$<target>`), e.g. `~/.claude/commands/raab.md` →
 * `/retouch-ascii-auto-build`. Both places that list skills and commands read
 * it from here: the prompt autocomplete (`AutocompleteTextarea`, over one
 * CLI's command index) and the RESOURCES tab (over the whole catalog).
 *
 * The description is the contract, not the file body: it is what both
 * surfaces already have in hand, and it is the line a person writes to say
 * what the shortcut is for. Only one hop is recorded — an alias of an alias is
 * linked to the alias, never followed — and a self-reference is ignored.
 *
 * Pure and import-free (types only), like the other `src/lib` helpers the
 * server-free UI tests rely on.
 */
import type { ResourceSummary } from '@/types/resources';

/**
 * `Shortcut for /<target>` at the start of a description. The target must end
 * on a letter, digit or `_`, so trailing punctuation (`/rar:`, `/rar.`) is not
 * swallowed while namespaced names (`superpowers:brainstorming`) stay whole.
 */
const SHORTCUT_RE = /^\s*shortcut\s+for\s+[/$]([A-Za-z0-9](?:[\w.:-]*[A-Za-z0-9_])?)/i;
/** The separator people put after the target: em/en dash, hyphen or colon. */
const SEPARATOR_RE = /^\s*[—–:-]?\s*/;

/** The command a description says this one is a shortcut for, or null. */
export function shortcutTarget(description: string | undefined): string | null {
  if (!description) return null;
  const m = SHORTCUT_RE.exec(description);
  return m ? m[1] : null;
}

/**
 * The description without its `Shortcut for /<target> —` lead-in, for rows
 * that already show the target as a chip. Anything else is returned as is.
 */
export function stripShortcutPrefix(description: string): string {
  const m = SHORTCUT_RE.exec(description);
  if (!m) return description;
  return description.slice(m[0].length).replace(SEPARATOR_RE, '');
}

export interface ShortcutIndex {
  /** alias name → target name */
  targetOf: Map<string, string>;
  /** target name → alias names, sorted */
  aliasesOf: Map<string, string[]>;
}

/** Shortcut links within ONE CLI's command index (the autocomplete's view). */
export function buildShortcutIndex(entries: ReadonlyArray<{ name: string; description?: string }>): ShortcutIndex {
  const targetOf = new Map<string, string>();
  const aliases = new Map<string, Set<string>>();
  for (const e of entries) {
    const target = shortcutTarget(e.description);
    if (!target || target === e.name) continue;
    targetOf.set(e.name, target);
    const set = aliases.get(target) ?? new Set<string>();
    set.add(e.name);
    aliases.set(target, set);
  }
  const aliasesOf = new Map([...aliases].map(([target, set]) => [target, [...set].sort()] as const));
  return { targetOf, aliasesOf };
}

export interface ResourceShortcutTarget {
  name: string;
  /** The target's resource id, when the catalog has it. */
  id?: string;
}

export interface ResourceShortcuts {
  /** alias resource id → its target */
  targetOf: Map<string, ResourceShortcutTarget>;
  /** target resource id → the aliases that expand to it (global first, then by name) */
  aliasesOf: Map<string, ResourceSummary[]>;
}

/**
 * Rank of a candidate target for one alias: the same scope (and project)
 * first, then a global one, then anything; a skill before a command; your own
 * before a plugin's.
 */
function targetRank(alias: ResourceSummary, candidate: ResourceSummary): number {
  const sameScope = candidate.scope === alias.scope && candidate.projectId === alias.projectId;
  const place = sameScope ? 0 : candidate.scope === 'global' ? 1 : 2;
  const kind = candidate.type === 'skill' ? 0 : 1;
  const own = candidate.origin === 'user' || candidate.origin === 'linked' ? 0 : 1;
  return place * 4 + kind * 2 + own;
}

function aliasOrder(a: ResourceSummary, b: ResourceSummary): number {
  return Number(a.scope !== 'global') - Number(b.scope !== 'global') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * Shortcut links across the RESOURCES catalog. Only commands (Claude commands,
 * Codex prompts) are aliases, and an alias links only to a skill or command of
 * the SAME agent — Claude and Codex both have a `retouch-ascii-auto-build`, and
 * a name-only match would cross-link them.
 */
export function buildResourceShortcuts(resources: readonly ResourceSummary[]): ResourceShortcuts {
  const byAgentName = new Map<string, ResourceSummary[]>();
  for (const r of resources) {
    if (r.type !== 'skill' && r.type !== 'command') continue;
    const key = `${r.agent}|${r.name}`;
    byAgentName.set(key, [...(byAgentName.get(key) ?? []), r]);
  }
  const targetOf = new Map<string, ResourceShortcutTarget>();
  const aliasesOf = new Map<string, ResourceSummary[]>();
  for (const alias of resources) {
    if (alias.type !== 'command') continue;
    const name = shortcutTarget(alias.description);
    if (!name || name === alias.name) continue;
    const candidates = byAgentName.get(`${alias.agent}|${name}`) ?? [];
    const best = [...candidates].sort((a, b) => targetRank(alias, a) - targetRank(alias, b))[0];
    targetOf.set(alias.id, best ? { name, id: best.id } : { name });
    if (best) aliasesOf.set(best.id, [...(aliasesOf.get(best.id) ?? []), alias].sort(aliasOrder));
  }
  return { targetOf, aliasesOf };
}

export interface MenuShortcutEntry {
  /** As shown and matched — a plugin entry's `plugin:name`. */
  name: string;
  description?: string;
  /** What the CLI accepts, sigil included (`/raab`, `$retouch-ascii-auto-build`). */
  token: string;
  kind: 'command' | 'skill';
}

export interface MenuShortcuts {
  /** `→ <target>` on a shortcut, `shortcut <aliases>` on a target, else undefined. */
  hintFor(name: string): string | undefined;
  /** The row's description, minus the `Shortcut for /x —` lead-in the hint already shows. */
  subFor(name: string, description: string): string;
}

/**
 * Row text for the prompt autocomplete, built from the CLI's FULL index — the
 * menu itself is filtered, and `/retouch-a` must still say `shortcut /raab`
 * after the query has filtered `/raab` out. Tokens come from the entries, so a
 * Codex prompt points at `$retouch-ascii-auto-build` (Codex skills are `$`).
 */
export function menuShortcuts(entries: readonly MenuShortcutEntry[]): MenuShortcuts {
  const index = buildShortcutIndex(entries);
  const tokenOf = (name: string): string => {
    const named = entries.filter((e) => e.name === name);
    const best = named.find((e) => e.kind === 'skill') ?? named[0];
    return best ? best.token : `/${name}`;
  };
  return {
    hintFor(name) {
      const target = index.targetOf.get(name);
      if (target) return `→ ${tokenOf(target)}`;
      const aliases = index.aliasesOf.get(name);
      return aliases ? `shortcut ${aliases.map(tokenOf).join(' ')}` : undefined;
    },
    subFor(name, description) {
      return index.targetOf.has(name) ? stripShortcutPrefix(description) : description;
    },
  };
}

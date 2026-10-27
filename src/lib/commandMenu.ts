/**
 * The rows of a `/` or `$` command dropdown, built from a CLI's command index.
 * Shared by the prompt editors (`AutocompleteTextarea`) and the terminal's own
 * list (`TerminalCommandMenu`) so both offer the same entries, in the same
 * groups, with the same sigils.
 */
import {
  compareMatches,
  filterAndGroup,
  sourceRank,
  entryToken,
  entryDisplayName,
  type CommandEntry,
  type CommandGroup,
} from '@/lib/commandIndex';
import { menuShortcuts, type MenuShortcuts } from '@/lib/commandShortcuts';
import { lookupNote, type SkillNotes } from '@/lib/skillNotes';

export interface CommandMenuItem {
  label: string;
  insert: string;
  sub?: string;
  /** Shortcut link: `→ /target` on a shortcut command, `shortcut /alias` on its target. */
  hint?: string;
  /** Drives the icon shown before the label. */
  kind?: 'command' | 'skill' | 'file';
  /** The user's own note on this skill (favourite, abbreviation). */
  fav?: boolean;
  abbr?: string;
  /** The Mac's count of this token in the last 90 days, when it has one (Oct 26 2026). */
  uses?: number;
}

export interface CommandMenuGroupSpan {
  title: string;
  startIdx: number;
  count: number;
}

/** Shortcut links over the CLI's whole index — see src/lib/commandShortcuts.ts. */
function shortcutsFor(entries: readonly CommandEntry[]): MenuShortcuts {
  return menuShortcuts(entries.map((e) => ({
    name: entryDisplayName(e),
    description: e.description,
    token: entryToken(e),
    kind: e.kind,
  })));
}

function groupsToItems(groups: CommandGroup[], shortcuts: MenuShortcuts, notes: SkillNotes): {
  items: CommandMenuItem[];
  groupSpans: CommandMenuGroupSpan[];
} {
  const items: CommandMenuItem[] = [];
  const groupSpans: CommandMenuGroupSpan[] = [];
  for (const g of groups) {
    const startIdx = items.length;
    for (const e of g.entries) {
      // `entryToken` owns the sigil so a Codex skill inserts `$name` while
      // everything else inserts `/name` — deriving it per entry keeps the two
      // menus from ever disagreeing with what the CLI accepts.
      const token = entryToken(e);
      const name = entryDisplayName(e);
      const hint = shortcuts.hintFor(name);
      const note = lookupNote(notes, e.cli, name);
      items.push({
        label: token,
        insert: token,
        sub: shortcuts.subFor(name, e.description) || (e.kind === 'skill' ? 'skill' : 'command'),
        ...(hint ? { hint } : {}),
        kind: e.kind,
        ...(note?.fav ? { fav: true } : {}),
        ...(note?.abbr ? { abbr: note.abbr } : {}),
        ...(e.uses ? { uses: e.uses } : {}),
      });
    }
    if (items.length > startIdx) {
      groupSpans.push({ title: g.title, startIdx, count: items.length - startIdx });
    }
  }
  return { items, groupSpans };
}

/**
 * Merge the group lists of several `filterAndGroup` passes (Claude's `/`: commands, then skills)
 * into one ranking (Oct 26 2026: they were concatenated, so a much-used skill sat below unused
 * commands of the same source). A merged group is re-ranked with `rank` — stable, so equal rows keep
 * commands first, each A–Z — and the groups follow their best row, ties in source order.
 */
function mergeGroups(lists: CommandGroup[][], rank: (a: CommandEntry, b: CommandEntry) => number): CommandGroup[] {
  const merged = new Map<string, CommandGroup>();
  const order: string[] = [];
  for (const g of lists.flat()) {
    if (!merged.has(g.title)) {
      merged.set(g.title, { title: g.title, source: g.source, entries: [] });
      order.push(g.title);
    }
    merged.get(g.title)!.entries.push(...g.entries);
  }
  return order
    .map((k) => {
      const g = merged.get(k)!;
      return { ...g, entries: [...g.entries].sort(rank) };
    })
    .sort((a, b) => rank(a.entries[0], b.entries[0]) || sourceRank(a.source) - sourceRank(b.source));
}

/**
 * Which kinds a sigil lists on a CLI. `/` on Codex lists prompts only — its
 * skills are `$`-invocable, so offering them there would send a prompt the CLI
 * silently ignores. Claude reaches both tiers through `/`, commands first.
 */
export function menuKinds(
  sigil: 'command' | 'skill',
  cli: 'claude' | 'codex',
): Array<'command' | 'skill'> {
  if (sigil === 'skill') return ['skill'];
  return cli === 'codex' ? ['command'] : ['command', 'skill'];
}

/**
 * Which kinds the `/` list in a session's terminal shows: commands, then skills,
 * on both CLIs. Unlike the queue editor, a pick here types each entry's own
 * token, so a Codex skill goes in as `$name` (the typed `/…` is erased first),
 * and Codex lists nothing itself for a `/` typed mid-prompt.
 */
export function terminalMenuKinds(): Array<'command' | 'skill'> {
  return ['command', 'skill'];
}

/**
 * The dropdown rows for `query` typed after a sigil, grouped by source.
 * `kinds` overrides what the sigil lists (the terminal's own list).
 */
export function buildCommandMenu(
  entries: CommandEntry[],
  query: string,
  sigil: 'command' | 'skill',
  cli: 'claude' | 'codex',
  notes: SkillNotes,
  kinds: Array<'command' | 'skill'> = menuKinds(sigil, cli),
): { items: CommandMenuItem[]; groupSpans: CommandMenuGroupSpan[] } {
  return groupsToItems(
    mergeGroups(kinds.map((k) => filterAndGroup(entries, query, k, notes)), compareMatches(query, notes)),
    shortcutsFor(entries),
    notes,
  );
}

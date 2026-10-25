/**
 * CommandSheet — this CLI's slash commands and skills, searchable (AASC-42).
 *
 * From the Mac's command index (`GET /api/commands`, already on the phone's
 * allow-list): built-in commands, the project's and the user's own, plugins,
 * and skills. A Codex skill is `$name`, never `/name` (commandIndex's
 * `entryToken`, the one sigil rule). Picking one hands it to the composer,
 * which puts it in the box, or, for a command that opens a picker in the
 * terminal (/model, /effort), opens that picker as a sheet instead.
 *
 * Ranked by use (Oct 24 2026): with nothing typed, "Most used" leads (commands and
 * skills together, `mostUsed`); each group below is ordered by the Mac's counts
 * (`filterAndGroup`), and a used row says how often. No counts: today's A–Z list.
 */
import { useEffect, useMemo, useState } from 'react';
import { EmptyState, ListRow, ListSection, Sheet } from '../kit';
import {
  entryToken,
  fetchCommandIndex,
  filterAndGroup,
  mostUsed,
  type CommandEntry,
  type CommandGroup,
} from '@/lib/commandIndex';
import { pickerSheetFor } from '@/lib/chat/composerAction';
import { plural } from '@/lib/chat/chatFormat';
import { SearchIcon } from './chatIcons';
import styles from '@/styles/modules/mobile/ComposerSheets.module.css';

export interface CommandSheetProps {
  open: boolean;
  onClose: () => void;
  cli: 'claude' | 'codex';
  projectPath: string | null | undefined;
  /** What was typed after the `/` that opened it. */
  initialQuery?: string;
  onPick: (entry: CommandEntry) => void;
}

const LARGE = ['large'] as const;
const BOTH_KINDS = ['command', 'skill'] as const;
const MOST_USED_LIMIT = 8;

type Section = { key: string; header: string; entries: CommandEntry[] };

type Load = { key: string; entries: CommandEntry[] | null; failed: boolean };

export default function CommandSheet({ open, onClose, cli, projectPath, initialQuery = '', onPick }: CommandSheetProps) {
  const [query, setQuery] = useState(initialQuery);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setQuery(initialQuery);
  }
  const key = `${cli}|${projectPath ?? ''}`;
  const [load, setLoad] = useState<Load>({ key: '', entries: null, failed: false });

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    void fetchCommandIndex(cli, projectPath).then((entries) => {
      if (live) setLoad({ key, entries, failed: entries.length === 0 });
    });
    return () => { live = false; };
  }, [open, cli, projectPath, key]);

  const entries = load.key === key ? load.entries : null;
  const sections = useMemo<Section[]>(() => {
    if (!entries) return [];
    const q = query.trim().replace(/^[/$]/, '');
    const byDescription = (kind: 'command' | 'skill') => entries.filter(
      (e) => e.kind === kind && q && e.description.toLowerCase().includes(q.toLowerCase()),
    );
    const groups = BOTH_KINDS.flatMap((kind) => {
      const named = filterAndGroup(entries, q, kind);
      // A word from the description finds a command too, after the name matches.
      const seen = new Set(named.flatMap((g) => g.entries.map(entryToken)));
      const extra = byDescription(kind).filter((e) => !seen.has(entryToken(e)));
      const all = extra.length > 0
        ? [...named, { title: 'Also matching', source: 'builtin' as const, entries: extra }]
        : named;
      return all.map((group: CommandGroup) => ({
        key: `${kind}-${group.title}`,
        header: `${kind === 'skill' ? 'Skills' : 'Commands'} · ${group.title}`,
        entries: group.entries,
      }));
    });
    const top = q ? [] : mostUsed(entries, BOTH_KINDS, MOST_USED_LIMIT);
    return top.length > 0 ? [{ key: 'most-used', header: 'Most used', entries: top }, ...groups] : groups;
  }, [entries, query]);

  const title = cli === 'codex' ? 'Codex commands and skills' : 'Claude commands and skills';

  return (
    <Sheet open={open} onClose={onClose} title={title} detents={LARGE} testId="command-sheet">
      <label className={styles.search}>
        <SearchIcon />
        <input
          className={styles.searchInput}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search commands and skills"
          aria-label="Search commands and skills"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
        />
      </label>
      {!entries ? (
        <EmptyState live title="Loading commands…" />
      ) : load.failed ? (
        <EmptyState title="No commands" message="Your Mac didn’t list any for this session. Check the connection and try again." />
      ) : sections.length === 0 ? (
        <EmptyState title="Nothing matches" message={`No command or skill has “${query.trim()}” in it.`} />
      ) : sections.map((section) => (
        <ListSection key={section.key} header={section.header}>
          {section.entries.map((entry) => {
            const picker = pickerSheetFor(entry);
            return (
              <ListRow
                key={`${entry.source}-${entryToken(entry)}`}
                title={<span className={styles.token}>{entryToken(entry)}</span>}
                subtitle={picker ? 'Pick a choice' : entry.description ? <span className={styles.clamp}>{entry.description}</span> : undefined}
                value={entry.uses ? <span className={styles.uses}>{plural(entry.uses, 'use')}</span> : undefined}
                chevron={!!picker}
                onClick={() => onPick(entry)}
                ariaLabel={`${entryToken(entry)}${entry.description ? `: ${entry.description}` : ''}`}
                tall={!!entry.description || !!picker}
              />
            );
          })}
        </ListSection>
      ))}
    </Sheet>
  );
}

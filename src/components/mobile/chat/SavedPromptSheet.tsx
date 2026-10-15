/**
 * SavedPromptSheet — the saved-prompt library in the phone composer (AASC-42).
 *
 * The same curated library the desktop's 🔖 picker and the phone queue use
 * (promptSnippetStore, kept on the Mac): most used first, searchable. Picking
 * one adds its text to the box on its own line (the one insert rule,
 * appendSnippet) and counts the use.
 */
import { useMemo, useState } from 'react';
import { EmptyState, ListRow, ListSection, Sheet } from '../kit';
import { usePromptSnippetStore, type PromptSnippet } from '@/stores/promptSnippetStore';
import { SearchIcon } from './chatIcons';
import styles from '@/styles/modules/mobile/ComposerSheets.module.css';

export interface SavedPromptSheetProps {
  open: boolean;
  onClose: () => void;
  onPick: (text: string) => void;
}

const DETENTS = ['medium', 'large'] as const;

function byUse(a: PromptSnippet, b: PromptSnippet): number {
  return b.useCount - a.useCount || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.createdAt - a.createdAt;
}

export default function SavedPromptSheet({ open, onClose, onPick }: SavedPromptSheetProps) {
  const snippets = usePromptSnippetStore((s) => s.snippets);
  const loaded = usePromptSnippetStore((s) => s.loaded);
  const touch = usePromptSnippetStore((s) => s.touch);
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return snippets
      .filter((s) => !q || s.text.toLowerCase().includes(q) || s.label.toLowerCase().includes(q))
      .sort(byUse);
  }, [snippets, query]);

  const pick = (snippet: PromptSnippet) => {
    onClose();
    onPick(snippet.text);
    void touch(snippet.id);
  };

  return (
    <Sheet open={open} onClose={onClose} title="Saved prompts" detents={DETENTS} testId="saved-prompt-sheet">
      {snippets.length > 0 && (
        <label className={styles.search}>
          <SearchIcon />
          <input
            className={styles.searchInput}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search saved prompts"
            aria-label="Search saved prompts"
            enterKeyHint="search"
          />
        </label>
      )}
      {!loaded ? (
        <EmptyState live title="Loading saved prompts…" />
      ) : snippets.length === 0 ? (
        <EmptyState title="No saved prompts yet" message="Keep a prompt with 🔖 in the queue on your Mac, and it shows up here." />
      ) : shown.length === 0 ? (
        <EmptyState title="Nothing matches" message={`No saved prompt has “${query.trim()}” in it.`} />
      ) : (
        <ListSection header="Most used first">
          {shown.map((s) => (
            <ListRow
              key={s.id}
              title={s.label || <span className={styles.clamp}>{s.text}</span>}
              subtitle={s.label ? <span className={styles.clamp}>{s.text}</span> : undefined}
              onClick={() => pick(s)}
              ariaLabel={s.label ? `${s.label}: ${s.text}` : s.text}
              tall={!!s.label}
            />
          ))}
        </ListSection>
      )}
    </Sheet>
  );
}

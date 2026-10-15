/**
 * reviewEntry — the REVIEW tab's vocabulary: mode names and icons, the filter
 * options, and how an entry's source, age and origin read. Shared by the
 * desktop view (routes/ReviewView) and the phone's (mobile/views/PhoneReview).
 */
import type { DbTranslationLog } from '@/lib/db';
import type { ListFilters } from '@/lib/translationLog';
import type { NativeSelectOption } from '@/components/ui/NativeSelect';
import { formatDate } from '@/lib/historyFormat';

export type ModeFilter = DbTranslationLog['mode'] | 'all';
export type ArchiveFilter = NonNullable<ListFilters['archived']>;

export const SEARCH_DEBOUNCE_MS = 200;
export const POLL_MS = 4000;
export const SUMMARY_LABEL = 'Saved explanations & translations';
export const NO_SOURCE = '(no source captured)';
// The "Translate previous answer" / "Translate file" toolbar buttons this hint
// used to point at no longer exist (no trigger anywhere in src/); the selection
// popup's 🔎 / 🌐 still match.
export const EMPTY_HINT =
  'Select text in the terminal or in a markdown file and click 🔎 / 🌐. ' +
  'Your explanations and translations will be saved here for review.';
/** A phone saves an entry from a session's Chat (its Ask AI), never a terminal or a file. */
export const PHONE_EMPTY_HINT =
  'Select text in a session’s Chat and tap Ask AI. ' +
  'Your explanations and translations will be saved here for review.';
export const NO_MATCH_HINT = 'Try a broader search, or change the Mode, Show or Favorites filter.';
export const FAVORITE_HINT = 'Highlights it in the source file.';

export const MODE_LABELS: Record<DbTranslationLog['mode'], string> = {
  'explain-learning': 'Explain (learning)',
  'explain-native': 'Explain (native)',
  'vocab-native': 'Vocabulary (native)',
  'translate-selection-learning': 'Translate → learning',
  'translate-selection-native': 'Translate → native',
  'translate-answer': 'Translate answer',
  'translate-file': 'Translate file',
  'custom': 'Custom prompt',
};

export const MODE_ICONS: Record<DbTranslationLog['mode'], string> = {
  'explain-learning': '🔎',
  'explain-native': '🌐',
  'vocab-native': '📖',
  'translate-selection-learning': '🔤',
  'translate-selection-native': '🔤',
  'translate-answer': '⤴',
  'translate-file': '📝',
  'custom': '✦',
};

// Every mode, from the label map. The list used to skip the two live
// translate-selection modes (the ones the popup still creates) while offering
// two that only old entries carry — so the commonest entries could not be
// filtered to. Old modes stay listed: their entries still exist.
export const MODE_OPTIONS: readonly NativeSelectOption<ModeFilter>[] = [
  { value: 'all', label: 'All modes' },
  ...(Object.keys(MODE_LABELS) as DbTranslationLog['mode'][]).map((m) => ({ value: m, label: MODE_LABELS[m] })),
];

export const ARCHIVE_OPTIONS: readonly NativeSelectOption<ArchiveFilter>[] = [
  { value: 'active', label: 'Active only' },
  { value: 'archived', label: 'Archived only' },
  { value: 'all', label: 'All' },
];

/** "Oct 7, 21:08": 24-hour like every other tab, no seconds, the year only when it is not this one. */
export const stamp = (ts: number): string => formatDate(ts, Date.now());

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return stamp(ts);
}

export function countEntries(n: number): string {
  return `${n} ${n === 1 ? 'entry' : 'entries'}`;
}

/** Project, session and age on one line. A no-break space keeps each "·" with the word before it. */
export function metaLine(row: DbTranslationLog): string {
  return [row.originProjectName || 'unknown project', row.originSessionTitle, relativeTime(row.createdAt)]
    .filter(Boolean)
    .join(' · ');
}

export function sourceTextOf(row: DbTranslationLog): string {
  return row.mode === 'translate-file' ? row.fileContent || row.filePath : row.selection;
}

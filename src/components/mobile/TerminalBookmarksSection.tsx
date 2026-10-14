/**
 * TerminalBookmarksSection — the terminal's bookmarks in its phone actions sheet
 * (AASC-20): a row per bookmark to jump back to it, and a 44px remove beside it.
 * Empty, it says how to make one, since the gesture (a long-press on a line) is
 * invisible until somebody tells you.
 */
import { bookmarkLabel, type TerminalBookmark } from '@/lib/terminalBookmarks';
import { SheetSection } from './SheetAction';
import { BookmarkIcon } from './phoneIcons';
import sheet from '@/styles/modules/PhoneSession.module.css';
import styles from '@/styles/modules/PhoneExtras.module.css';

export interface TerminalBookmarksSectionProps {
  bookmarks: readonly TerminalBookmark[];
  onJump: (bookmark: TerminalBookmark) => void;
  onRemove: (id: string) => void;
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function TerminalBookmarksSection({ bookmarks, onJump, onRemove }: TerminalBookmarksSectionProps) {
  return (
    <SheetSection title={bookmarks.length > 0 ? `Bookmarks · ${bookmarks.length}` : 'Bookmarks'}>
      {bookmarks.length === 0 ? (
        <li className={styles.sheetHint}>Long-press a line in the terminal to bookmark it.</li>
      ) : bookmarks.map((b) => (
        <li key={b.id} className={styles.bookmarkRow}>
          <button
            type="button"
            className={`${sheet.sheetItem} ${styles.bookmarkJump}`}
            onClick={() => onJump(b)}
            aria-label={`Go to bookmark: ${bookmarkLabel(b.text)}`}
          >
            <span className={sheet.sheetIcon}><BookmarkIcon /></span>
            <span className={styles.bookmarkText}>
              <span className={styles.bookmarkLine}>{bookmarkLabel(b.text)}</span>
              <span className={styles.bookmarkMeta}>{timeOf(b.createdAt)}</span>
            </span>
          </button>
          <button
            type="button"
            className={styles.bookmarkRemove}
            onClick={() => onRemove(b.id)}
            aria-label={`Remove bookmark: ${bookmarkLabel(b.text, 40)}`}
          >
            ×
          </button>
        </li>
      ))}
    </SheetSection>
  );
}

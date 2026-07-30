/**
 * PromptSnippetPicker — insert a kept prompt into whatever prompt box is being
 * typed, and promote raw prompt history into the kept library.
 *
 * Two tabs:
 *   - SAVED   — the curated library (`promptSnippetStore`). Click a row to
 *               insert; ✎ renames, ✕ forgets.
 *   - RECENT  — a read-only pool of prompt history across EVERY session. Click
 *               to insert without keeping; 🔖 promotes into SAVED. This is the
 *               "we have historical prompts, but only the useful ones get kept"
 *               half of the feature: browsing is free, the library stays curated.
 *
 * **Portaled on purpose.** Every call site sits inside a scroll box — the queue
 * compose row and rows live in `.queueBody` (250px `overflow-y: auto`), and the
 * MAIN-prompt / chain-step triggers live in `.chainModalBody`. An absolutely
 * positioned menu inside either is clipped on BOTH axes (per CSS overflow rules
 * a `visible` axis computes to `auto` when the other is `auto`), and worse, the
 * usual flip/clamp helpers measure `window.innerWidth`/`innerHeight` — a
 * boundary far outside the real clip edge — so the guard silently never fires
 * and the menu always renders cropped while *looking* guarded in review. Same
 * fix as `QueueMovePicker` / `SelectionPopup`: portal to <body>, position:
 * fixed, place from the trigger's viewport rect.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  computeMovePickerPosition,
  type HorizontalAlign,
} from '@/lib/queueMovePlacement';
import { usePromptSnippetStore, type PromptSnippet } from '@/stores/promptSnippetStore';
import { poolRecentPrompts, type RecentPrompt } from '@/lib/promptSnippetPool';
import { useSessionStore } from '@/stores/sessionStore';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/PromptSnippetPicker.module.css';

/**
 * Marker attribute on any button that opens a picker. Clicks on a trigger are
 * exempt from the outside-click close, so the button keeps its own toggle
 * instead of close-then-reopening.
 */
export const SNIPPET_TRIGGER_ATTR = 'data-snippet-trigger';

type Tab = 'saved' | 'recent';

interface PromptSnippetPickerProps {
  /** The button this menu hangs off. Placement is measured from its rect. */
  anchor: HTMLElement | null;
  /** Which trigger edge to line up with. Left for wide-container buttons. */
  align?: HorizontalAlign;
  /** Insert the chosen text at the call site. The picker closes itself after. */
  onInsert: (text: string) => void;
  onClose: () => void;
}

/** First line of a snippet, for the row's title when it has no label. */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0].trim();
  return line || text.trim();
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max) + '…' : collapsed;
}

export default function PromptSnippetPicker({
  anchor,
  align = 'right',
  onInsert,
  onClose,
}: PromptSnippetPickerProps) {
  const snippets = usePromptSnippetStore((s) => s.snippets);
  const save = usePromptSnippetStore((s) => s.save);
  const remove = usePromptSnippetStore((s) => s.remove);
  const setLabel = usePromptSnippetStore((s) => s.setLabel);
  const touch = usePromptSnippetStore((s) => s.touch);
  const sessions = useSessionStore((s) => s.sessions);

  const [tab, setTab] = useState<Tab>('saved');
  const [filter, setFilter] = useState('');
  /** Snippet id whose name is being edited inline. */
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const ref = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // ---- Data -------------------------------------------------------------
  /** Most-used first, then most-recently-used, then newest kept. A library is
   *  browsed by "what do I reach for", not by insertion order. */
  const savedRows: PromptSnippet[] = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = snippets.filter((s) =>
      !q || s.text.toLowerCase().includes(q) || s.label.toLowerCase().includes(q),
    );
    return [...rows].sort((a, b) => {
      if (b.useCount !== a.useCount) return b.useCount - a.useCount;
      const la = a.lastUsedAt ?? a.createdAt;
      const lb = b.lastUsedAt ?? b.createdAt;
      if (lb !== la) return lb - la;
      return b.createdAt - a.createdAt;
    });
  }, [snippets, filter]);

  const recentRows: RecentPrompt[] = useMemo(() => {
    // Only pool when the tab is actually showing — the flatten walks every
    // session's full prompt history, which is wasted work while on SAVED.
    if (tab !== 'recent') return [];
    const sources = Array.from(sessions.entries()).map(([id, s]) => ({
      sessionLabel: s.projectName || s.title || id.slice(0, 8),
      promptHistory: s.promptHistory ?? [],
    }));
    const pooled = poolRecentPrompts(sources);
    const q = filter.trim().toLowerCase();
    return q ? pooled.filter((r) => r.text.toLowerCase().includes(q)) : pooled;
  }, [tab, sessions, filter]);

  /** Texts already in the library — drives the ✓ marker on RECENT rows. */
  const keptTexts = useMemo(
    () => new Set(snippets.map((s) => s.text)),
    [snippets],
  );

  // ---- Placement --------------------------------------------------------
  // Measure then place, before paint. Re-runs on scroll/resize so the menu stays
  // glued to its trigger while an ancestor scroll box moves under it.
  // `capture: true` is required: scroll events do not bubble, so a window
  // listener only sees an inner box's scroll during the capture phase.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;

    const place = () => {
      const a = anchor.getBoundingClientRect();
      const m = el.getBoundingClientRect();
      const next = computeMovePickerPosition(
        { top: a.top, bottom: a.bottom, right: a.right, left: a.left },
        { width: m.width, height: m.height },
        { width: window.innerWidth, height: window.innerHeight },
        align,
      );
      setPos((prev) =>
        prev && prev.top === next.top && prev.left === next.left ? prev : next,
      );
    };

    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
    // Row-count changes the menu height, so re-measure when the list changes.
  }, [anchor, align, tab, savedRows.length, recentRows.length]);

  // Close on outside click, but never on a trigger — that button owns the
  // toggle, and closing here first would make it immediately re-open.
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (target.closest(`[${SNIPPET_TRIGGER_ATTR}]`)) return;
      onClose();
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  // Escape closes the picker. An inline rename swallows the first Escape (see
  // the input's own handler) so it cancels the rename instead of the whole menu.
  //
  // NOTE for hosts: `QueueItemEditModal` also listens for Escape on `document`,
  // and stopPropagation does NOT suppress a sibling listener on the same node —
  // so that modal skips its own close while a picker is open. Any future host
  // with a document-level Escape handler must do the same.
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Focus the filter on open so the user can type straight into it.
  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  // ---- Actions ----------------------------------------------------------
  const handleInsertSaved = useCallback(
    (snippet: PromptSnippet) => {
      onInsert(snippet.text);
      void touch(snippet.id);
      onClose();
    },
    [onInsert, touch, onClose],
  );

  const handleInsertRecent = useCallback(
    (row: RecentPrompt) => {
      onInsert(row.text);
      onClose();
    },
    [onInsert, onClose],
  );

  const handleKeepRecent = useCallback(
    async (row: RecentPrompt) => {
      const result = await save(row.text);
      if (result.id == null) {
        showToast('Could not save that prompt', 'error', 2200);
      } else if (result.duplicate) {
        showToast('Already in saved prompts', 'info', 1500);
      } else {
        showToast('Saved for reuse', 'info', 1500);
      }
    },
    [save],
  );

  const startRename = useCallback((snippet: PromptSnippet) => {
    setRenameDraft(snippet.label);
    setRenamingId(snippet.id);
  }, []);

  const commitRename = useCallback(() => {
    if (renamingId === null) return;
    void setLabel(renamingId, renameDraft);
    setRenamingId(null);
    setRenameDraft('');
  }, [renamingId, renameDraft, setLabel]);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameDraft('');
  }, []);

  const emptyMessage =
    tab === 'saved'
      ? snippets.length === 0
        ? 'No saved prompts yet. Click the bookmark icon next to any prompt box — or 🔖 a row in RECENT — to keep it here.'
        : 'No saved prompts match the filter.'
      : 'No prompt history yet.';

  const rowsEmpty = tab === 'saved' ? savedRows.length === 0 : recentRows.length === 0;

  return createPortal(
    <div
      ref={ref}
      className={styles.picker}
      // Geometry is computed, so it has to be inline — same exception the other
      // portaled overlays make. Hidden for the single pre-measure frame so the
      // menu never flashes at the top-left corner on open.
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
      role="dialog"
      aria-label="Saved prompts"
    >
      <div className={styles.tabs} role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'saved'}
          className={`${styles.tab}${tab === 'saved' ? ` ${styles.tabActive}` : ''}`}
          onClick={() => setTab('saved')}
        >
          SAVED{snippets.length > 0 ? ` (${snippets.length})` : ''}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'recent'}
          className={`${styles.tab}${tab === 'recent' ? ` ${styles.tabActive}` : ''}`}
          onClick={() => setTab('recent')}
          title="Prompt history from every session — 🔖 the ones worth keeping"
        >
          RECENT
        </button>
      </div>

      <input
        ref={filterRef}
        className={styles.filter}
        type="text"
        placeholder="Filter…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <div className={styles.body}>
        {rowsEmpty ? (
          <div className={styles.empty}>{emptyMessage}</div>
        ) : tab === 'saved' ? (
          savedRows.map((snippet) => (
            <div key={snippet.id} className={styles.row}>
              {renamingId === snippet.id ? (
                <input
                  className={styles.renameInput}
                  value={renameDraft}
                  autoFocus
                  maxLength={80}
                  placeholder="Name this prompt…"
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                    // Cancel the rename, not the whole picker. The picker's
                    // Escape listener is on `document`, so stop this one here.
                    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRename(); }
                  }}
                />
              ) : (
                <SavedRowButton snippet={snippet} onClick={() => handleInsertSaved(snippet)} />
              )}
              <div className={styles.rowActions}>
                {snippet.useCount > 0 && (
                  <span className={styles.rowCount}>{snippet.useCount}×</span>
                )}
                <button
                  className={styles.rowBtn}
                  onClick={() => startRename(snippet)}
                  title="Rename"
                  aria-label="Rename saved prompt"
                >
                  ✎
                </button>
                <button
                  className={`${styles.rowBtn} ${styles.rowBtnDanger}`}
                  onClick={() => { void remove(snippet.id); }}
                  title="Forget this prompt"
                  aria-label="Forget saved prompt"
                >
                  ✕
                </button>
              </div>
            </div>
          ))
        ) : (
          recentRows.map((row) => {
            const kept = keptTexts.has(row.text);
            return (
              <div key={`${row.timestamp}-${row.text.slice(0, 24)}`} className={styles.row}>
                <button
                  className={styles.rowMain}
                  onClick={() => handleInsertRecent(row)}
                  title={row.text}
                >
                  <span className={styles.rowTitle}>{truncate(row.text, 110)}</span>
                </button>
                <div className={styles.rowActions}>
                  <span className={styles.rowSource} title={`Last used in ${row.sessionLabel}`}>
                    {row.sessionLabel}
                  </span>
                  {kept ? (
                    <span className={styles.rowKept} title="Already in saved prompts">
                      ✓
                    </span>
                  ) : (
                    <button
                      className={styles.rowBtn}
                      onClick={() => { void handleKeepRecent(row); }}
                      title="Keep this prompt for reuse"
                      aria-label="Keep prompt for reuse"
                    >
                      <BookmarkIcon />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * One SAVED row's clickable body.
 *
 * The second (preview) line is rendered ONLY when it says something the title
 * doesn't. An unnamed single-line snippet — the common case, e.g. `/compact` —
 * has an identical title and preview, and printing both just repeats the same
 * string at two font sizes.
 */
function SavedRowButton({
  snippet,
  onClick,
}: {
  snippet: PromptSnippet;
  onClick: () => void;
}) {
  const title = snippet.label || firstLine(snippet.text);
  const preview = truncate(snippet.text, 90);
  return (
    <button className={styles.rowMain} onClick={onClick} title={snippet.text}>
      <span className={styles.rowTitle}>{title}</span>
      {preview !== title && <span className={styles.rowPreview}>{preview}</span>}
    </button>
  );
}

/** Bookmark outline — the shared "keep this text" mark. Inline SVG rather than
 *  the 🔖 character: an emoji glyph renders in full colour on macOS and as tofu
 *  on some Linux builds, and can't inherit the button's hover colour. */
export function BookmarkIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** Bookmark-stack — "open the saved-prompts library". Distinct silhouette from
 *  the single bookmark so keep and insert never read as the same control. */
export function BookmarkStackIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 21l-5-3.5L6 21V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2z" />
      <path d="M20 17V5a2 2 0 0 0-2-2h-1" />
    </svg>
  );
}

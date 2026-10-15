/**
 * DiffScreen — one file's diff from a session's Changes (AASC-44).
 *
 *   ‹ Changes        icons.tsx        ⤶ Wrap
 *     src/components/ui/ · +1 −1
 *   [Collapse all]                         +1 −1
 *   @@ −40,7 +40,7 @@                        ⌄     sticky hunk header (tap: fold)
 *    40  40     <svg viewBox="0 0 14 14">
 *    41     −     <rect y="10.5" … />                red / green, and − / + marks
 *        41 +     <rect y="7" … />
 *   ‹ Previous file              Next file ›
 *
 * Read-only. Long lines scroll sideways per hunk, or wrap (the Wrap toggle).
 * Hold a line → Comment puts a reference ("src/ui/icons.tsx:41 — ") into the
 * session's composer draft; Copy line copies it. A secret file shows that it was
 * edited, never what it holds. Neighbours are found by path in the current list,
 * because indexes shift when the session edits again; the diff shown stays the
 * one that was opened.
 */
import { memo, useCallback, useMemo, useState, type MouseEvent, type PointerEvent } from 'react';
import type { DiffHunk } from '@/types/chat';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { useFileChanges, useSessionChanges } from '@/stores/changesStore';
import { commentReference, hunkHeader, hunkRows, positionsKnown, type DiffRow } from '@/lib/chat/diffRows';
import { basename, dirname, formatCounts } from '@/lib/chat/chatFormat';
import { copyText } from '@/lib/chat/clipboard';
import { diffPath } from '@/lib/chat/phoneRoutes';
import { showToast } from '@/components/ui/ToastContainer';
import { Button, ContextMenu, EmptyState, Screen, type ContextMenuItem } from '../kit';
import { ChevronLeftIcon, ChevronRightIcon } from '../kit/kitIcons';
import { Counts } from '../chat/ChangesView';
import { ChevronIcon, CollapseAllIcon, CommentIcon, CopyIcon, ExpandAllIcon, LockIcon, WrapLinesIcon } from '../chat/chatIcons';
import styles from '@/styles/modules/mobile/Changes.module.css';

/** Lines drawn at first; more on request (a 512 KB diff must not freeze a phone). */
const LINE_BUDGET = 1500;
const SIGN = { add: '+', del: '−', context: ' ' } as const;
const ROW_CLASS = { add: styles.add, del: styles.del, context: '' } as const;
const NO_ITEMS: ReadonlyArray<ContextMenuItem> = [];

interface HunkProps {
  hunk: DiffHunk;
  index: number;
  rows: DiffRow[];
  open: boolean;
  wrap: boolean;
  numbered: boolean;
  onToggle: (index: number) => void;
  /** The line menu (Comment, Copy line) for the line last pressed in this hunk. */
  menuItems: ReadonlyArray<ContextMenuItem>;
  menuLabel: string;
}

const Hunk = memo(function Hunk({ hunk, index, rows, open, wrap, numbered, onToggle, menuItems, menuLabel }: HunkProps) {
  return (
    <section className={styles.hunk} aria-label={hunkHeader(hunk, index)}>
      <button type="button" className={styles.hunkHead} aria-expanded={open} onClick={() => onToggle(index)}>
        <span className={styles.hunkTitle}>{hunkHeader(hunk, index)}</span>
        <span className={`${styles.chev}${open ? ` ${styles.chevOpen}` : ''}`}><ChevronIcon size={16} /></span>
      </button>
      {open && (
        <div className={`${styles.hunkBody}${wrap ? ` ${styles.hunkBodyWrap}` : ''}`}>
          {/* One menu per hunk, around its lines only: closing it hands focus back to its
              trigger, and with no control inside that is a no-op (never a jump to the top). */}
          <ContextMenu items={menuItems} label={menuLabel}>
          <div className={styles.lines}>
            {rows.map((row, i) => (
              <div
                key={i}
                className={`${styles.line} ${ROW_CLASS[row.kind]}`}
                data-hunk={index}
                data-row={i}
              >
                {numbered && <span className={styles.num}>{row.oldNo ?? ''}</span>}
                {numbered && <span className={styles.num}>{row.newNo ?? ''}</span>}
                <span className={styles.sign} role={row.kind === 'context' ? undefined : 'img'} aria-label={row.kind === 'add' ? 'added' : row.kind === 'del' ? 'removed' : undefined}>
                  {SIGN[row.kind]}
                </span>
                <span className={styles.code}>{row.text || ' '}</span>
              </div>
            ))}
          </div>
          </ContextMenu>
        </div>
      )}
    </section>
  );
});

/** Hunks and their rows within `budget` lines. */
function budgeted(hunks: readonly DiffHunk[], budget: number): { rows: DiffRow[][]; cut: boolean } {
  const rows: DiffRow[][] = [];
  let left = budget;
  for (const hunk of hunks) {
    if (left <= 0) return { rows, cut: true };
    const all = hunkRows(hunk);
    rows.push(all.slice(0, left));
    if (all.length > left) return { rows, cut: true };
    left -= all.length;
  }
  return { rows, cut: false };
}

export default function DiffScreen({ sessionId, fileIndex }: { sessionId: string; fileIndex: number }) {
  const pop = usePhoneNavStore((s) => s.pop);
  const replace = usePhoneNavStore((s) => s.replace);
  const appendToDraft = useComposerDraftStore((s) => s.appendToDraft);
  const { data: file, isPending, error, refetch, isFetching } = useFileChanges(sessionId, fileIndex);
  const { data: list } = useSessionChanges(sessionId);
  const [wrap, setWrap] = useState(false);
  const [closed, setClosed] = useState<ReadonlySet<number>>(() => new Set());
  const [budget, setBudget] = useState(LINE_BUDGET);
  const [pressed, setPressed] = useState<{ hunk: number; row: number } | null>(null);

  const shown = useMemo(() => (file ? budgeted(file.hunks, budget) : { rows: [], cut: false }), [file, budget]);
  const numbered = file ? positionsKnown(file.hunks) : false;

  // Neighbours by path in the list as it is now (indexes shift when the session edits again).
  const at = list && file ? list.files.findIndex((f) => f.path === file.path) : -1;
  const prev = at > 0 ? { index: at - 1, file: list!.files[at - 1] } : null;
  const next = at >= 0 && list && at + 1 < list.files.length ? { index: at + 1, file: list.files[at + 1] } : null;

  const toggleHunk = useCallback((index: number) => {
    setClosed((s) => {
      const nextSet = new Set(s);
      if (nextSet.has(index)) nextSet.delete(index);
      else nextSet.add(index);
      return nextSet;
    });
  }, []);

  const allOpen = closed.size === 0;
  const toggleAll = () => setClosed(allOpen && file ? new Set(file.hunks.map((_, i) => i)) : new Set());

  /** The row a finger (or right click) landed on, for the line menu. */
  const notePress = (e: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>) => {
    // The menu is portaled to <body> but its events still bubble through React to here:
    // a tap on one of its items must not change which line it is for.
    if (!(e.target instanceof Element) || !e.currentTarget.contains(e.target)) return;
    const row = e.target.closest<HTMLElement>('[data-row]');
    if (row) setPressed({ hunk: Number(row.dataset.hunk), row: Number(row.dataset.row) });
  };

  const pressedRow = pressed ? shown.rows[pressed.hunk]?.[pressed.row] ?? null : null;
  const menuItems: ContextMenuItem[] = file && pressedRow ? [
    {
      id: 'comment',
      label: 'Comment',
      icon: <CommentIcon size={18} />,
      onSelect: () => {
        appendToDraft(sessionId, commentReference(file.path, pressedRow));
        showToast('Added to your message. Finish it in the chat.', 'info');
      },
    },
    {
      id: 'copy',
      label: 'Copy line',
      icon: <CopyIcon size={18} />,
      onSelect: () => {
        void copyText(pressedRow.text).then((ok) => showToast(ok ? 'Line copied' : 'Couldn’t copy the line', ok ? 'info' : 'error'));
      },
    },
  ] : [];

  const title = file ? basename(file.path) : 'Diff';
  const subtitle = file ? [dirname(file.path), formatCounts(file)].filter(Boolean).join(' · ') : undefined;

  const footer = (prev || next) ? (
    <div className={styles.fileNav}>
      {prev ? (
        <Button small icon={<ChevronLeftIcon />} onClick={() => replace(diffPath(sessionId, prev.index))} aria-label={`Previous file: ${prev.file.path}`}>
          <span className={styles.fileNavLabel}>Previous<span className={styles.fileNavName}>{basename(prev.file.path)}</span></span>
        </Button>
      ) : <span />}
      {next ? (
        <Button small onClick={() => replace(diffPath(sessionId, next.index))} aria-label={`Next file: ${next.file.path}`}>
          <span className={styles.fileNavRow}>
            <span className={styles.fileNavLabel}>Next<span className={styles.fileNavName}>{basename(next.file.path)}</span></span>
            <ChevronRightIcon />
          </span>
        </Button>
      ) : <span />}
    </div>
  ) : undefined;

  return (
    <Screen
      title={title}
      subtitle={subtitle}
      onBack={pop}
      backLabel="Back to Changes"
      testId="phone-diff"
      footer={footer}
      actions={file && !file.redacted && file.hunks.length > 0 ? (
        <button type="button" className={styles.navAction} aria-pressed={wrap} aria-label="Wrap long lines" onClick={() => setWrap((w) => !w)}>
          <WrapLinesIcon size={22} />
        </button>
      ) : undefined}
    >
      {isPending && <EmptyState live title="Loading the diff…" />}
      {!isPending && !file && (
        <EmptyState
          title="Couldn’t open this file’s changes"
          message={error ?? undefined}
          action={(
            <>
              <Button variant="primary" onClick={() => void refetch()} loading={isFetching}>Try again</Button>
              <Button onClick={pop}>Back to Changes</Button>
            </>
          )}
        />
      )}
      {file?.redacted && (
        <EmptyState
          icon={<LockIcon size={28} />}
          title="Hidden on phones: a secret file"
          message={`This session edited ${file.path}. Phones never see a secret file’s content; open it on the Mac.`}
        />
      )}
      {file && !file.redacted && (
        <>
          {(file.created || file.deleted || file.replaced || file.truncated || !numbered) && (
            <div className={styles.diffNotes}>
              {file.created && <span>A new file: every line is added.</span>}
              {file.deleted && <span>The session deleted this file.</span>}
              {file.replaced && <span>Overwritten with content the transcript never showed before, so every line shows as added.</span>}
              {file.truncated && <span>Long diff: the phone received the first 512 KB.</span>}
              {!numbered && file.hunks.length > 0 && <span>Line numbers weren’t recorded for these edits.</span>}
            </div>
          )}
          {file.hunks.length > 1 && (
            <div className={styles.toolbar}>
              <Button small variant="plain" icon={allOpen ? <CollapseAllIcon size={18} /> : <ExpandAllIcon size={18} />} onClick={toggleAll}>
                {allOpen ? 'Collapse all' : 'Expand all'}
              </Button>
              <span className={styles.toolbarCounts}><Counts added={file.added} removed={file.removed} /></span>
            </div>
          )}
          {file.hunks.length === 0 ? (
            <EmptyState title="No lines to show" message={file.deleted ? 'The file was deleted.' : 'This edit changed no lines.'} />
          ) : (
            <div className={styles.hunks} onPointerDownCapture={notePress} onContextMenuCapture={notePress}>
              {shown.rows.map((rows, i) => (
                <Hunk
                  key={i}
                  hunk={file.hunks[i]}
                  index={i}
                  rows={rows}
                  open={!closed.has(i)}
                  wrap={wrap}
                  numbered={numbered}
                  onToggle={toggleHunk}
                  menuItems={pressed?.hunk === i ? menuItems : NO_ITEMS}
                  menuLabel={`Line actions for ${basename(file.path)}`}
                />
              ))}
            </div>
          )}
          {shown.cut && (
            <div className={styles.more}>
              <Button small onClick={() => setBudget((b) => b + LINE_BUDGET)}>Show more lines</Button>
            </div>
          )}
        </>
      )}
    </Screen>
  );
}

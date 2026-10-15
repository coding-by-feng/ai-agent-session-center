/**
 * InlineDiff — an edit row expanded in the chat (AASC-41): the call's own hunks,
 * red and green with − and + marks (never colour alone), 12 lines and then "Show
 * all N lines". Long lines scroll sideways inside the box. A secret file's edit
 * shows that it happened, not what it was.
 */
import { Fragment, useState } from 'react';
import type { EditFile } from '@/lib/chat/editDiff';
import { hunkRows, type DiffRow } from '@/lib/chat/diffRows';
import { basename } from '@/lib/chat/chatFormat';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

const VISIBLE_LINES = 12;
const SIGN = { add: '+', del: '−', context: ' ' } as const;
const ROW_CLASS = { add: styles.diffAdd, del: styles.diffDel, context: '' } as const;

interface Shown {
  file: EditFile;
  hunks: DiffRow[][];
}

/** The files and rows that fit in `budget` lines, in order. */
function visible(files: readonly EditFile[], budget: number): Shown[] {
  const out: Shown[] = [];
  let left = budget;
  for (const file of files) {
    if (left <= 0) break;
    const hunks: DiffRow[][] = [];
    for (const hunk of file.hunks) {
      if (left <= 0) break;
      const rows = hunkRows(hunk).slice(0, left);
      left -= rows.length;
      hunks.push(rows);
    }
    out.push({ file, hunks });
  }
  return out;
}

export default function InlineDiff({ files }: { files: readonly EditFile[] }) {
  const [all, setAll] = useState(false);
  const total = files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
  const multi = files.length > 1;
  const shown = visible(files, all ? Infinity : VISIBLE_LINES);

  return (
    <>
      <div className={styles.diff} role="group" aria-label="Changed lines">
        <div className={styles.diffLines}>
          {shown.map(({ file, hunks }) => (
            <Fragment key={file.path}>
              {(multi || file.redacted) && <div className={styles.diffFile}>{basename(file.path)}</div>}
              {file.redacted && <div className={styles.diffGap}>Hidden on phones: a secret file</div>}
              {hunks.map((rows, h) => (
                <Fragment key={h}>
                  {h > 0 && <div className={styles.diffGap} aria-hidden="true">⋯</div>}
                  {rows.map((row, i) => (
                    <div key={i} className={`${styles.diffLine} ${ROW_CLASS[row.kind]}`}>
                      <span className={styles.diffSign} role={row.kind === 'context' ? undefined : 'img'} aria-label={row.kind === 'add' ? 'added' : row.kind === 'del' ? 'removed' : undefined}>
                        {SIGN[row.kind]}
                      </span>
                      <span>{row.text || ' '}</span>
                    </div>
                  ))}
                </Fragment>
              ))}
              {!file.redacted && file.hunks.length === 0 && (
                <div className={styles.diffGap}>{file.deleted ? 'Deleted' : 'No lines to show'}</div>
              )}
            </Fragment>
          ))}
        </div>
      </div>
      {total > VISIBLE_LINES && (
        <button type="button" className={`${styles.smallBtn} ${styles.plainBtn}`} onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? 'Show less' : `Show all ${total} lines`}
        </button>
      )}
    </>
  );
}

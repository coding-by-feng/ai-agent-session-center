/**
 * OpenFilesSheet — the Project tab's open and recent files (AASC-56), the phone's
 * take on the desktop's file tabs: what you opened (each with its own Close, and
 * Close all), then what you read lately. A row opens the file where you left it.
 *
 * A row and its Close are siblings, never a button inside a button.
 */
import { Sheet } from '../kit';
import FileTypeIcon from '@/components/ui/FileTypeIcon';
import { baseName, parentRel } from '@/lib/phoneProject';
import { CloseIcon } from '../projectIcons';
import styles from '@/styles/modules/PhoneProject.module.css';

const DETENTS = ['medium', 'large'] as const;

export interface OpenFilesSheetProps {
  open: boolean;
  onClose: () => void;
  openFiles: readonly string[];
  recentFiles: readonly string[];
  /** The file on screen, if any (said as "Reading"). */
  current: string | null;
  onOpenFile: (path: string) => void;
  onCloseFile: (path: string) => void;
  onCloseAll: () => void;
}

const folderWords = (path: string) => (parentRel(path) === '/' ? 'Project folder' : parentRel(path).slice(1));

function FileRow({ path, meta, onOpen }: { path: string; meta: string; onOpen: () => void }) {
  return (
    <button type="button" className={styles.row} onClick={onOpen} aria-label={`Open ${path.slice(1)}`}>
      <span className={styles.rowIcon} aria-hidden="true"><FileTypeIcon name={baseName(path)} isDir={false} /></span>
      <span className={styles.rowText}>
        <span className={styles.rowName}>{baseName(path)}</span>
        <span className={styles.rowMeta}>{meta}</span>
      </span>
    </button>
  );
}

export default function OpenFilesSheet({
  open,
  onClose,
  openFiles,
  recentFiles,
  current,
  onOpenFile,
  onCloseFile,
  onCloseAll,
}: OpenFilesSheetProps) {
  const pick = (path: string) => () => {
    onClose();
    onOpenFile(path);
  };
  const empty = openFiles.length === 0 && recentFiles.length === 0;
  return (
    <Sheet open={open} onClose={onClose} title="Open and recent files" detents={DETENTS} testId="project-files-sheet">
      {empty && <p className={styles.sheetNote}>Files you open show up here, so you can go back to one in a tap.</p>}
      {openFiles.length > 0 && (
        <section aria-labelledby="project-open-files" className={styles.sheetSection}>
          <div className={styles.sheetHeader}>
            <h3 id="project-open-files" className={styles.sheetHeading}>Open · {openFiles.length}</h3>
            <button type="button" className={styles.textBtn} onClick={onCloseAll}>Close all</button>
          </div>
          <ul className={styles.sheetList}>
            {[...openFiles].reverse().map((path) => (
              <li key={path} className={styles.openRow}>
                <FileRow path={path} meta={path === current ? `Reading · ${folderWords(path)}` : folderWords(path)} onOpen={pick(path)} />
                <button type="button" className={styles.iconBtn} onClick={() => onCloseFile(path)} aria-label={`Close ${baseName(path)}`}>
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {recentFiles.length > 0 && (
        <section aria-labelledby="project-recent-files" className={styles.sheetSection}>
          <div className={styles.sheetHeader}>
            <h3 id="project-recent-files" className={styles.sheetHeading}>Recent</h3>
          </div>
          <ul className={styles.sheetList}>
            {recentFiles.map((path) => (
              <li key={path}>
                <FileRow path={path} meta={folderWords(path)} onOpen={pick(path)} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </Sheet>
  );
}

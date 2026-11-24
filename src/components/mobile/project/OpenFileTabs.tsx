/**
 * OpenFileTabs — the Project tab's open files as a row of tabs under its header (Nov 25 2026), the phone's and the
 * iPad's take on the desktop Project tab's file tabs. One tab per open file, in the order opened: its icon and name
 * (the whole path in its label), tapped to show the file; its ✕ closes it. The file on screen is marked
 * (`aria-current`) and kept in view while the row scrolls sideways. Drawn only while a file is open.
 *
 * The open files are the Project tab's per-project memory (`phoneProjectFiles.ts`), so the tabs come back after
 * leaving the tab, another session or a restart. A tab and its ✕ are siblings, never a button inside a button.
 */
import { useEffect, useRef } from 'react';
import FileTypeIcon from '@/components/ui/FileTypeIcon';
import { baseName } from '@/lib/phoneProject';
import { tabName } from '@/lib/phoneProjectFiles';
import { CloseIcon } from '../projectIcons';
import styles from '@/styles/modules/PhoneProject.module.css';

export interface OpenFileTabsProps {
  openFiles: readonly string[];
  /** The file on screen, if any. */
  current: string | null;
  onShowFile: (path: string) => void;
  onCloseFile: (path: string) => void;
}

export default function OpenFileTabs({ openFiles, current, onShowFile, onCloseFile }: OpenFileTabsProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  // The tab on screen stays in view: a file opened from a link or the sheet may sit past the row's edge.
  useEffect(() => {
    if (!current) return;
    // The whole tab, its ✕ included, not just its name.
    const active = rowRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.parentElement;
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [current, openFiles.length]);

  if (openFiles.length === 0) return null;
  return (
    <nav className={styles.fileTabs} aria-label="Open files">
      <div ref={rowRef} className={styles.fileTabsRow} data-testid="project-file-tabs">
        {openFiles.map((path) => {
          const active = path === current;
          const name = baseName(path);
          return (
            <div key={path} className={`${styles.fileTab}${active ? ` ${styles.fileTabActive}` : ''}`}>
              <button
                type="button"
                className={styles.fileTabOpen}
                onClick={() => onShowFile(path)}
                aria-current={active ? 'page' : undefined}
                aria-label={`Show ${path.slice(1)}`}
                title={path.slice(1)}
              >
                <span className={styles.fileTabIcon} aria-hidden="true"><FileTypeIcon name={name} isDir={false} /></span>
                <span className={styles.fileTabName}>{tabName(name)}</span>
              </button>
              <button type="button" className={styles.fileTabClose} onClick={() => onCloseFile(path)} aria-label={`Close ${name}`}>
                <CloseIcon />
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

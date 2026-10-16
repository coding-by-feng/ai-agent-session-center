/**
 * ProjectFolder — one folder of the Project tab (AASC-20): its folders and files
 * as 56px rows, read through GET /api/files/list. A refused folder (a paired
 * phone's plain 404) says so in words, with Try again and a way to the top.
 */
import { useEffect, useState } from 'react';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import FileTypeIcon from '@/components/ui/FileTypeIcon';
import { listDir, type DirItem, type FilesResult } from '@/lib/phoneFiles';
import { baseName, fileErrorText, formatSize, joinRel } from '@/lib/phoneProject';
import { ChevronIcon } from '../projectIcons';
import styles from '@/styles/modules/PhoneProject.module.css';

export default function ProjectFolder({
  projectPath,
  path,
  onOpenDir,
  onOpenFile,
  onGoRoot,
}: {
  projectPath: string;
  path: string;
  onOpenDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onGoRoot: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ attempt: number; result: FilesResult<{ items: DirItem[] }> } | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    listDir(projectPath, path, ac.signal).then(
      (result) => setLoaded({ attempt, result }),
      () => { /* aborted */ },
    );
    return () => ac.abort();
  }, [projectPath, path, attempt]);

  const result = loaded?.attempt === attempt ? loaded.result : null;
  if (!result) return <EmptyState busy title="Loading…" fill />;
  if (!result.ok) {
    const text = fileErrorText(result.status, 'folder');
    return (
      <EmptyState
        tone="error"
        fill
        title={text.title}
        hint={text.hint}
        action={
          <>
            <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
            {path !== '/' && <Button onClick={onGoRoot}>Project folder</Button>}
          </>
        }
      />
    );
  }
  const items = result.data.items ?? [];
  if (items.length === 0) return <EmptyState fill title="This folder is empty" />;
  return (
    <ul className={styles.list} aria-label={`Files in ${path === '/' ? 'the project' : baseName(path)}`}>
      {items.map((item) => {
        const target = joinRel(path, item.name);
        const isDir = item.type === 'dir';
        return (
          <li key={item.name}>
            <button
              type="button"
              className={styles.row}
              onClick={() => (isDir ? onOpenDir(target) : onOpenFile(target))}
              aria-label={isDir ? `Folder ${item.name}` : item.name}
            >
              <span className={`${styles.rowIcon}${isDir ? ` ${styles.rowIconDir}` : ''}`} aria-hidden="true">
                <FileTypeIcon name={item.name} isDir={isDir} />
              </span>
              <span className={styles.rowText}>
                <span className={styles.rowName}>{item.name}</span>
                <span className={styles.rowMeta}>{isDir ? 'Folder' : formatSize(item.size)}</span>
              </span>
              {isDir && <ChevronIcon className={styles.rowChevron} />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * NewFolderConfirm — "Start in a new folder?" before a phone starts a session
 * in a folder no agent has worked in (AASC-54). A recent project starts with
 * one tap; a folder found by browsing (or typed) asks first, because the agent
 * takes that folder as its project. The Mac doesn't confirm Claude's "trust
 * this folder?" prompt for a phone's new folder (its hooks and MCP servers run
 * once trusted), so the sheet says the person will answer it.
 *
 * Phone-only (the kit): the desktop's NewSessionModal loads it with lazy().
 */
import { ConfirmSheet } from './kit';
import styles from '@/styles/modules/mobile/FolderBrowser.module.css';

export interface NewFolderConfirmProps {
  /** The folder to confirm; null = closed. */
  dir: string | null;
  /** "Claude" or "Codex". */
  cliLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const lastName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

export default function NewFolderConfirm({ dir, cliLabel, busy, onConfirm, onCancel }: NewFolderConfirmProps) {
  return (
    <ConfirmSheet
      open={dir !== null}
      title="Start in a new folder?"
      message={dir !== null && (
        <>
          No agent has worked in <strong>{lastName(dir)}</strong> yet. {cliLabel} will start there and use it as its project.
          {cliLabel === 'Claude' && ' Claude will ask whether you trust the folder: answer it in the session’s terminal.'}
          <span className={styles.confirmPath}>{dir}</span>
        </>
      )}
      confirmLabel="Start here"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

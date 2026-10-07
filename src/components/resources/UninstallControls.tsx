/**
 * UninstallControls — the RESOURCES tab's one destructive control.
 *
 * `UninstallAction` sits in the detail header: the **Uninstall** button where
 * the shared rule (`uninstallBlocker`, src/types/resources.ts) allows — the
 * server enforces the same rule — the reason in its place for the other in-scope
 * types, and nothing for types uninstall never handles (hooks, MCP servers,
 * settings, instructions, plugins).
 *
 * `UninstallDialog` is rendered by ResourcesView, NOT inside the detail pane:
 * the pane is keyed by the catalog's `scannedAt` and remounts whenever a scan
 * lands — usually the very rescan an earlier uninstall started — and a dialog
 * inside it vanished mid-typing. It demands the exact name, says what moves and
 * what stays, says how long Restore is offered and where the trash is, and keeps
 * the server's refusal on screen. Portaled to <body>: an overlay inside a
 * scrolling or transformed ancestor is clipped or misplaced.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ResourceSummary, UninstallResult } from '@/types/resources';
import { isUninstallableType, uninstallBlocker } from '@/types/resources';
import { RESOURCE_TYPE_SINGULAR, formatBytes } from '@/lib/resourceFilters';
import { ResourcesUnavailableError, errorMessage, uninstallResource } from '@/lib/resourcesApi';
import { useUiStore } from '@/stores/uiStore';
import Modal from '@/components/ui/Modal';
import styles from '@/styles/modules/Resources.module.css';
import u from '@/styles/modules/ResourceUninstall.module.css';

export const UNINSTALL_MODAL_ID = 'resource-uninstall';
/** How long the "Uninstalled … · Restore" toast stays — the dialog says so. */
export const RESTORE_WINDOW_MS = 10_000;

export function UninstallAction({ summary, onRequest }: { summary: ResourceSummary; onRequest: () => void }) {
  if (!isUninstallableType(summary.type)) return null;
  const blocker = uninstallBlocker(summary);
  if (blocker) return <p className={u.uninstallBlocked}>{blocker}</p>;
  return (
    <button type="button" className={u.uninstallButton} onClick={onRequest}>
      Uninstall
    </button>
  );
}

interface UninstallDialogProps {
  summary: ResourceSummary;
  /** Labels of the other copies ("Also in") — named as left alone. */
  otherCopies: readonly string[];
  /** Display path of the trash (catalog `roots.trash`), when the server named it. */
  trashPath?: string;
  onUninstalled: (result: UninstallResult) => void;
}

export function UninstallDialog({ summary, otherCopies, trashPath, onUninstalled }: UninstallDialogProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeModal = useUiStore((s) => s.closeModal);
  const singular = RESOURCE_TYPE_SINGULAR[summary.type].toLowerCase();
  const files = summary.fileCount === 1 ? '1 file' : `${summary.fileCount} files`;
  const matches = typed === summary.name;
  const seconds = Math.round(RESTORE_WINDOW_MS / 1000);

  // After Modal's own focus (its close button): child effects run first.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!matches || pending) return;
    setPending(true);
    setError(null);
    uninstallResource(summary.id, typed).then(
      (result) => {
        closeModal();
        onUninstalled(result);
      },
      (err: unknown) => {
        setPending(false);
        // A 404 here is a resource gone since the scan, not a remote device.
        setError(err instanceof ResourcesUnavailableError ? 'It is no longer there — rescan to refresh.' : errorMessage(err));
      },
    );
  };

  return createPortal(
    <Modal modalId={UNINSTALL_MODAL_ID} title={`Uninstall ${singular} “${summary.name}”?`} panelClassName={u.uninstallPanel}>
      <form className={u.uninstallForm} onSubmit={submit}>
        <p>Moves it to the AASC trash:</p>
        <p className={u.uninstallPath}>
          <code>{summary.path}</code>{' '}
          <span className={styles.muted}>{`${files} · ${formatBytes(summary.bytes)}`}</span>
        </p>
        <p>
          {`A Restore button shows for ${seconds} seconds afterwards`}
          {trashPath ? <>; after that it stays in <code className={u.uninstallPath}>{trashPath}</code>.</> : '.'}
        </p>
        {summary.type === 'memory' && summary.name !== 'MEMORY.md' && (
          <p>Its line in this folder’s MEMORY.md goes too, and comes back on Restore.</p>
        )}
        {otherCopies.length > 0 && <p>Not touched: {otherCopies.join(', ')}.</p>}
        <p className={styles.muted}>Sessions that already loaded it keep it until they restart.</p>
        {/* The label is uppercased; the name must show in the exact case it has to be typed in. */}
        <label htmlFor={inputId} className={u.confirmLabel}>
          Type <code className={u.confirmName}>{summary.name}</code> to confirm
        </label>
        <input
          ref={inputRef}
          id={inputId}
          className={u.confirmInput}
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
        />
        {error && <p role="alert" className={u.uninstallError}>{error}</p>}
        <div className={u.uninstallActions}>
          <button type="button" className={styles.button} onClick={closeModal}>Cancel</button>
          <button type="submit" className={u.dangerButton} disabled={!matches || pending}>
            {pending ? 'Uninstalling…' : 'Uninstall'}
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}

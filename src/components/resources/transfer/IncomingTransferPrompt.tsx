/**
 * IncomingTransferPrompt — another computer asks to send a project here (Nov 27 2026,
 * docs/plans/project-transfer.md). One request at a time, the oldest first: Decline or Allow.
 * Allowing also lets that computer send projects here from now on (the server remembers it).
 *
 * Mounted from the app root only while the store holds requests, so this chunk loads only then.
 * It waits for any other open dialog to close rather than replacing it. Escape or ✕ hides a
 * request in this window; the sender keeps waiting until it is answered or cancelled there.
 */
import { useEffect, useState } from 'react';
import type { IncomingTransferRequest } from '@/types/projectTransfer';
import { projectTransferApi } from '@/lib/projectTransferApi';
import { count, formatBytes } from '@/lib/projectTransferFormat';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { useProjectTransferStore } from '@/stores/projectTransferStore';
import { useUiStore } from '@/stores/uiStore';
import styles from '@/styles/modules/TransferDialog.module.css';

export const INCOMING_TRANSFER_ID = 'project-transfer-incoming';

function oldestOf(list: IncomingTransferRequest[]): IncomingTransferRequest | null {
  let oldest: IncomingTransferRequest | null = null;
  for (const r of list) if (!oldest || r.requestedAt < oldest.requestedAt) oldest = r;
  return oldest;
}

const message = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;

export default function IncomingTransferPrompt() {
  const requests = useProjectTransferStore((s) => s.requests);
  const activeModal = useUiStore((s) => s.activeModal);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<'allow' | 'decline' | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const request = oldestOf(requests.filter((r) => !hidden.has(r.id)));

  // A WS message sent while the socket was down is not replayed: read the list once on mount.
  useEffect(() => {
    let live = true;
    projectTransferApi.requests().then(
      (list) => live && useProjectTransferStore.getState().setRequests(list),
      () => undefined, // The WS list already on screen stays; the next message refreshes it.
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const ui = useUiStore.getState();
    if (request && activeModal === null) ui.openModal(INCOMING_TRANSFER_ID);
    if (!request && activeModal === INCOMING_TRANSFER_ID) ui.closeModal();
  }, [request, activeModal]);

  useEffect(
    () => () => {
      if (useUiStore.getState().activeModal === INCOMING_TRANSFER_ID)
        useUiStore.getState().closeModal();
    },
    [],
  );

  if (!request) return null;
  const who = request.computerLabel;

  async function answer(kind: 'allow' | 'decline') {
    if (!request) return;
    setBusy(kind);
    setError(null);
    try {
      await (kind === 'allow'
        ? projectTransferApi.allow(request.id)
        : projectTransferApi.decline(request.id));
      useProjectTransferStore.getState().removeRequest(request.id);
    } catch (e) {
      setError({
        id: request.id,
        text: message(e, kind === 'allow' ? 'Could not allow it.' : 'Could not decline it.'),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      modalId={INCOMING_TRANSFER_ID}
      title={`Allow ${who} to send a project here?`}
      onClose={() => setHidden((h) => new Set(h).add(request.id))}
      locked={busy !== null}
      panelClassName={styles.dialog}
    >
      <p className={styles.line}>
        {`${request.projectName} → ${request.destination} · ${count(request.files)} ${request.files === 1 ? 'file' : 'files'} · ${formatBytes(request.bytes)}. Allowing lets ${who} send projects here from now on.`}
      </p>
      {error?.id === request.id && (
        <div className={styles.error} role="alert">
          {error.text}
        </div>
      )}
      <div className={styles.actions}>
        <Button disabled={busy !== null} onClick={() => void answer('decline')}>
          Decline
        </Button>
        <Button variant="primary" disabled={busy !== null} onClick={() => void answer('allow')}>
          Allow
        </Button>
      </div>
    </Modal>
  );
}

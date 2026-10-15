/**
 * InterruptedSessionsPrompt — after a restore, offers to continue the sessions whose
 * turn was cut off when AASC quit (see lib/interruptedRestore.ts). Nothing is typed
 * into any agent until the user clicks Continue. Lazy: App.tsx mounts it only while
 * an offer is pending.
 */
import { useEffect, useSyncExternalStore } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useUiStore } from '@/stores/uiStore';
import {
  continueInterrupted,
  dismissInterrupted,
  getInterruptedOffer,
  subscribeInterrupted,
} from '@/lib/interruptedRestore';
import modalStyles from '@/styles/modules/Modal.module.css';
import styles from '@/styles/modules/InterruptedSessionsPrompt.module.css';

export const INTERRUPTED_MODAL_ID = 'interrupted-sessions';

const STATUS_LABEL: Readonly<Record<string, string>> = {
  working: 'working',
  prompting: 'starting a reply',
  approval: 'waiting on approval',
};

export default function InterruptedSessionsPrompt() {
  const offer = useSyncExternalStore(subscribeInterrupted, getInterruptedOffer);
  const activeModal = useUiStore((s) => s.activeModal);
  const openModal = useUiStore((s) => s.openModal);
  const closeModal = useUiStore((s) => s.closeModal);

  // One dialog at a time: wait for anything else that is open (a kill confirm, settings).
  useEffect(() => {
    if (offer && activeModal === null) openModal(INTERRUPTED_MODAL_ID);
  }, [offer, activeModal, openModal]);

  if (!offer) return null;
  const n = offer.items.length;
  const title = `${n} session${n === 1 ? ' was' : 's were'} interrupted when AASC closed`;

  const handleContinue = () => {
    const { items, restoreStartedAt } = offer;
    dismissInterrupted();
    closeModal();
    void continueInterrupted(items, restoreStartedAt);
  };

  const handleNotNow = () => {
    dismissInterrupted();
    closeModal();
  };

  return (
    <Modal modalId={INTERRUPTED_MODAL_ID} title={title} onClose={dismissInterrupted}>
      <ul className={styles.list}>
        {offer.items.map((item) => (
          <li key={item.terminalId} className={styles.row}>
            <span className={styles.name} title={item.title}>{item.title}</span>
            <span className={styles.status}>{STATUS_LABEL[item.status] ?? item.status}</span>
          </li>
        ))}
      </ul>
      <p>
        Continue sends each one &ldquo;Continue from exactly where you left off&rdquo; as soon as it has
        finished resuming. Sessions that aren&rsquo;t ready within 3 minutes are left for you.
      </p>
      <div className={modalStyles.actions}>
        <Button onClick={handleNotNow}>Not now</Button>
        <Button variant="primary" onClick={handleContinue}>
          Continue {n} session{n === 1 ? '' : 's'}
        </Button>
      </div>
    </Modal>
  );
}

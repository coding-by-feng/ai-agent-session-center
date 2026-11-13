/**
 * CloudAccountButton — the AASC Cloud account at the end of the RESOURCES tab row (Nov 13 2026; it
 * was the Connection tab). The button says which device this Mac is in the cloud, or that it isn't
 * connected; it opens the account dialog (CloudAccountPanel: sign in or pair, disconnect,
 * skill-notes sync, cloud aliases).
 *
 *   Library · Projects · Machines                ☁ kason-mac   ⟳ Rescan
 */
import { lazy, Suspense } from 'react';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import Modal from '@/components/ui/Modal';
import { CloudAccountIcon } from '@/components/ui/icons';
import { useUiStore } from '@/stores/uiStore';
import type { CloudStatus } from '@/types/cloud';
import styles from '@/styles/modules/CloudResources.module.css';
import { useCloudSession } from './cloudSession';

const CloudAccountPanel = lazy(() => import('./CloudAccountPanel'));

export const CLOUD_ACCOUNT_MODAL_ID = 'cloud-account';

/** What the button says, and how a screen reader hears it. A failed status read says so rather
 *  than "Not connected": the provider reports no connection then, but it never knew. */
function accountWords(status: CloudStatus, loaded: boolean, failed: boolean): { text: string; spoken: string } {
  if (!loaded) return { text: 'Cloud', spoken: 'Cloud account: checking' };
  if (failed) return { text: 'Cloud', spoken: 'Cloud account: status unavailable' };
  const device = status.connection?.deviceName;
  if (status.state === 'revoked') return { text: 'Reconnect', spoken: 'Cloud account: reconnect needed' };
  if (device) return { text: device, spoken: `Cloud account: ${device}, ${status.state}` };
  return { text: 'Not connected', spoken: 'Cloud account: not connected' };
}

export default function CloudAccountButton({
  className,
  onClose,
}: {
  className?: string;
  /** After the dialog closes (ResourcesView drops an old Connection link from the URL). */
  onClose?: () => void;
}) {
  const { status, loaded, error } = useCloudSession();
  const activeModal = useUiStore((s) => s.activeModal);
  const openModal = useUiStore((s) => s.openModal);
  const words = accountWords(status, loaded, Boolean(error));
  return (
    <>
      <Button
        className={className ? `${styles.accountButton} ${className}` : styles.accountButton}
        icon={<CloudAccountIcon />}
        aria-label={words.spoken}
        aria-haspopup="dialog"
        title={words.text}
        onClick={() => openModal(CLOUD_ACCOUNT_MODAL_ID)}
      >
        <span className={styles.accountName}>{words.text}</span>
      </Button>
      {activeModal === CLOUD_ACCOUNT_MODAL_ID && (
        // .dialog caps it at the window's height and scrolls inside: the account panel is taller
        // than most windows, and Modal alone let its title and close button run off the top.
        <Modal modalId={CLOUD_ACCOUNT_MODAL_ID} title="Cloud account" onClose={onClose} panelClassName={styles.dialog}>
          <Suspense fallback={<EmptyState busy title="Loading the cloud account…" />}>
            <CloudAccountPanel />
          </Suspense>
        </Modal>
      )}
    </>
  );
}

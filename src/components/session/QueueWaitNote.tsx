/**
 * One line under the queue's notices saying why a plain queue with Auto-send on is not sending right
 * now (Nov 28 2026): the agent is mid-turn, waits for an answer, every prompt is switched off, or, in the
 * phone app, no AASC window on the Mac is there to send. The rule is `queueWaitReason`.
 */
import { getClientId } from '@/lib/deviceIdentity';
import { isNativeMobileApp } from '@/lib/platform';
import { queueWaitReason, type QueueWaitItem } from '@/lib/queueWaitReason';
import { usePresenceStore } from '@/stores/presenceStore';
import styles from '@/styles/modules/QueueWaitNote.module.css';

interface Props {
  items: readonly QueueWaitItem[];
  autoSend: boolean;
  automationPaused: boolean;
  held: boolean;
  sessionStatus: string;
  cliName: string;
  phone: boolean;
}

/** The phone app never fires the queue; it is the writer only when no window on the Mac is connected. */
function usePhoneAppIsAlone(): boolean {
  const received = usePresenceStore((s) => s.received);
  const writer = usePresenceStore((s) => s.workspaceWriter);
  if (!isNativeMobileApp() || !received) return false;
  return writer === null || writer === getClientId();
}

export default function QueueWaitNote({ items, autoSend, automationPaused, held, sessionStatus, cliName, phone }: Props) {
  const noSender = usePhoneAppIsAlone();
  const reason = queueWaitReason({ items, autoSend, automationPaused, held, sessionStatus, cliName, noSender });
  if (!reason) return null;
  return (
    <p className={styles.note} data-kind={reason.kind} data-phone={phone ? '' : undefined} role="status" data-testid="queue-wait-note">
      <span className={styles.icon} aria-hidden="true">
        {reason.kind === 'busy' || reason.kind === 'approval' ? '⏳' : '⏸'}
      </span>
      <span>{reason.text}</span>
    </p>
  );
}

/**
 * ConnectionBanner — "Reconnecting to your Mac…" under the nav bar while the
 * socket is down after the first snapshot (AASC-39). The content stays readable;
 * the session list is the last one received.
 */
import { Banner } from '../kit';
import { useWsStore } from '@/stores/wsStore';

export default function ConnectionBanner() {
  const connected = useWsStore((s) => s.connected);
  const snapshotReceived = useWsStore((s) => s.snapshotReceived);
  if (connected || !snapshotReceived) return null;
  return (
    <Banner tone="offline" title="Reconnecting to your Mac…">
      What you see is from the last update.
    </Banner>
  );
}

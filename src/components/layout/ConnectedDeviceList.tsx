/**
 * ConnectedDeviceList — the devices panel's list of who is connected right now: this computer plus any remote
 * device, how many sessions each drives, when it joined, and its address. It was inline in DevicePresenceChip
 * until Nov 20 2026 and draws exactly what it drew there.
 */
import { presenceDeviceKind } from '@/lib/deviceKind';
import { drivingCount } from '@/lib/devicePresenceSummary';
import DeviceKindIcon from '@/components/layout/DeviceKindIcon';
import type { ControlHolderView, DevicePresence } from '@/types';
import styles from '@/styles/modules/DevicePresence.module.css';

function relativeTime(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/**
 * `d.address` is a raw `req.socket.remoteAddress` — on a dual-stack machine
 * that's frequently an IPv4-mapped IPv6 form (`::ffff:192.168.6.42`) or bare
 * `::1` for loopback, neither of which reads as an IP a person recognizes.
 * Mirrors the normalization `isLoopbackAddress` already does server-side
 * (`address.replace(/^::ffff:/, '')`), but for DISPLAY only — `d.isLocal`
 * itself is computed server-side and untouched here. An empty address (no
 * socket info available, e.g. behind a proxy) shows as '—' rather than blank.
 */
function formatAddress(address: string): string {
  if (!address) return '—';
  const stripped = address.replace(/^::ffff:/, '');
  return stripped === '::1' ? '127.0.0.1' : stripped;
}

interface Props {
  devices: readonly DevicePresence[];
  /** Read from the presence store by the caller, so a moved baton re-renders the counts. */
  controllers: Map<string, ControlHolderView>;
  myId: string;
}

export default function ConnectedDeviceList({ devices, controllers, myId }: Props) {
  return (
    <ul className={styles.deviceList}>
      {devices.map((d) => {
        const driving = drivingCount(controllers, d.clientId);
        const isMe = d.clientId === myId;
        return (
          <li key={d.clientId} className={styles.device}>
            <span className={styles.deviceIcon}>
              <DeviceKindIcon kind={presenceDeviceKind(d)} />
            </span>
            <span className={styles.deviceMain}>
              <span className={styles.deviceLabel}>
                <span className={styles.deviceName} title={d.label}>{d.label}</span>
                {isMe && <span className={styles.youTag}>this device</span>}
              </span>
              <span className={styles.deviceMeta}>
                {driving > 0
                  ? `driving ${driving} session${driving === 1 ? '' : 's'}`
                  : 'watching only'}
                {' · '}
                joined {relativeTime(d.connectedAt)}
              </span>
              <span className={styles.deviceAddress}>{formatAddress(d.address)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The header device chip's phone count (Oct 22 2026). The 🖥 number counts live
 * sockets, so a paired phone whose app is closed or asleep was invisible; the
 * phone part counts the Mac's active paired phones and how many have a socket now.
 * Nov 2 2026: tablets (an iPad by name, `pairedDeviceKind`) count apart, with their own icon.
 */
import type { PairedPhone } from './mobilePairingApi';
import { pairedDeviceKind } from './deviceKind';

export interface PhoneSummary {
  /** Active paired phones (tablets, pending, revoked and paired computers left out). */
  paired: number;
  /** Active paired tablets. */
  tablets: number;
  /** "iPad" when every paired tablet is one, else "tablet". */
  tabletNoun: 'iPad' | 'tablet';
  /** Of the phones and tablets, how many have an open socket right now. */
  online: number;
}

export function summarizePhones(phones: PairedPhone[] | null): PhoneSummary | null {
  if (!phones) return null;
  // The header counts handhelds: a paired computer (`desktop`) is not one.
  const active = phones.filter((p) => p.status === 'active' && p.platform !== 'desktop');
  const tablets = active.filter((p) => pairedDeviceKind(p) === 'tablet');
  return {
    paired: active.length - tablets.length,
    tablets: tablets.length,
    tabletNoun: tablets.every((p) => p.platform === 'ios') ? 'iPad' : 'tablet',
    online: active.filter((p) => p.online === true).length,
  };
}

const plural = (n: number, noun: string) => `${n} paired ${noun}${n === 1 ? '' : 's'}`;

export function deviceChipTitle(liveDevices: number, phones: PhoneSummary | null): string {
  const live = `${liveDevices} device${liveDevices === 1 ? '' : 's'} connected`;
  if (!phones || phones.paired + phones.tablets === 0) return live;
  const parts = [
    ...(phones.paired > 0 ? [plural(phones.paired, 'phone')] : []),
    ...(phones.tablets > 0 ? [plural(phones.tablets, phones.tabletNoun)] : []),
  ];
  const online = phones.online === 0 ? 'none online' : `${phones.online} online`;
  return `${live} · ${parts.join(', ')} (${online})`;
}

/**
 * The header device chip's phone count (Oct 22 2026). The 🖥 number counts live
 * sockets, so a paired phone whose app is closed or asleep was invisible; the 📱
 * part counts the Mac's active paired phones and how many have a socket now.
 */
import type { PairedPhone } from './mobilePairingApi';

export interface PhoneSummary {
  /** Active paired phones (pending, revoked and paired computers left out). */
  paired: number;
  /** Of those, how many have an open socket right now. */
  online: number;
}

export function summarizePhones(phones: PairedPhone[] | null): PhoneSummary | null {
  if (!phones) return null;
  // The header's 📱 counts phones: a paired computer (`desktop`) is not one.
  const active = phones.filter((p) => p.status === 'active' && p.platform !== 'desktop');
  return { paired: active.length, online: active.filter((p) => p.online === true).length };
}

export function deviceChipTitle(liveDevices: number, phones: PhoneSummary | null): string {
  const live = `${liveDevices} device${liveDevices === 1 ? '' : 's'} connected`;
  if (!phones || phones.paired === 0) return live;
  const online = phones.online === 0 ? 'none online' : `${phones.online} online`;
  return `${live} · ${phones.paired} paired phone${phones.paired === 1 ? '' : 's'} (${online})`;
}

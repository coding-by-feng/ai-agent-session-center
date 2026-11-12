// accountPhoneNotice.ts — tell the Mac's owner when a phone joins through the AASC Cloud account (plan 17, review M3).
//
// An account phone connects with no QR and no Allow click, so the owner would otherwise only find it in the
// device list. The device chip already re-reads the paired list when presence changes (a phone that just
// enrolled opens its socket at once) and every 30 s; it diffs each read against the last with this and shows a
// toast per new account phone. The first read in a window only seeds the list: those phones were already there.
import type { PairedPhone } from './mobilePairingApi';

/** Active account phones in `next` that `prev` didn't have; none on the first read (`prev` null). */
export function newAccountPhones(prev: readonly PairedPhone[] | null, next: readonly PairedPhone[]): PairedPhone[] {
  if (prev === null) return [];
  const seen = new Set(prev.map((p) => p.id));
  return next.filter((p) => p.origin === 'account' && p.status === 'active' && !seen.has(p.id));
}

export function accountPhoneNotice(phone: Pick<PairedPhone, 'label' | 'accountEmail'>): string {
  const base = `${phone.label} connected through your AASC Cloud account`;
  return phone.accountEmail ? `${base} (${phone.accountEmail})` : base;
}

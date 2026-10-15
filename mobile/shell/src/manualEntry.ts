// manualEntry.ts — pairing without the QR: the code typed by hand (AASC-17).
//
// The Mac shows its code under the QR ("ABCDE-FGHJK"); the address is the
// Mac's Tailscale address (100.x.y.z) or its home-network address. The typed
// fields become a pairing-link fragment and go through the same parser as a
// scanned link, so typing can't reach anything a QR couldn't.
import { parsePairingLink, type PairingLink } from './pairingLink.js';

export interface ManualEntry {
  address: string;
  port: string;
  code: string;
}

export type ManualResult = { ok: true; link: PairingLink } | { ok: false; field: keyof ManualEntry; message: string };

/** "abcde-fghjk" / "ABCDE FGHJK" → "ABCDEFGHJK". */
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

export function manualLink(entry: ManualEntry, macName = 'Mac'): ManualResult {
  const address = entry.address.trim();
  const port = entry.port.trim();
  const code = normalizeCode(entry.code);
  const params = new URLSearchParams({ v: '2', name: macName });
  // Which kind of address it is decides the field; the parser checks the range.
  params.set(address.startsWith('100.') ? 'ts' : 'lan', address);
  params.set('p', port);
  params.set('mc', code);

  const link = parsePairingLink(params.toString());
  if (link) return { ok: true, link };
  // Say which field is wrong; the order matches the form.
  if (!parsePairingLink(`v=2&name=x&${address.startsWith('100.') ? 'ts' : 'lan'}=${encodeURIComponent(address)}&p=1&mc=ABCDEFGHJK`)) {
    return { ok: false, field: 'address', message: 'Enter the Mac’s Tailscale address (100.x.y.z) or its home-network address (for example 192.168.1.20).' };
  }
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return { ok: false, field: 'port', message: 'Enter the port AASC uses on the Mac (a number up to 65535).' };
  }
  return { ok: false, field: 'code', message: 'Enter the 10-character code shown under the QR on your Mac.' };
}

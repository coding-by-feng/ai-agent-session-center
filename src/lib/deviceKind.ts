/**
 * deviceKind.ts — is a device a computer, a phone or a tablet (Nov 2 2026)? One rule for the
 * header device chip, its Connected devices rows and the Phones & computers list, which all
 * used to draw 📱 for anything that wasn't this Mac, a paired iPad included.
 *
 * A paired device carries only a platform (`ios` | `android` | `desktop`) and the name its owner
 * typed; the phone app now offers "iPad" / "Android tablet" as that name on a tablet, so the
 * name is what tells one apart. A renamed tablet with neither word reads as a phone, which is
 * what every tablet read as before. Pure: no DOM, no store.
 */
import type { PairedPhone } from './mobilePairingApi';

export type DeviceKind = 'computer' | 'phone' | 'tablet';

const TABLET_IN_NAME = /\bipad\b|\btablet\b/i;

export function pairedDeviceKind(p: Pick<PairedPhone, 'label' | 'platform'>): DeviceKind {
  if (p.platform === 'desktop') return 'computer';
  return TABLET_IN_NAME.test(p.label) ? 'tablet' : 'phone';
}

/** What to call a paired device in a sentence: "Code on the iPad", "Allow only if your phone…". */
export function pairedDeviceNoun(p: Pick<PairedPhone, 'label' | 'platform'>): string {
  const kind = pairedDeviceKind(p);
  if (kind === 'tablet') return p.platform === 'ios' ? 'iPad' : 'tablet';
  return kind;
}

/**
 * A connected device, from its presence label (`deriveDeviceLabel`: "iPad · AASC App",
 * "Windows · Chrome"). The phone app on an iPad sends a desktop user agent, so it reads as
 * "Mac · AASC App": the app on a Mac-looking device is an iPad, since the app runs on no Mac.
 */
export function presenceDeviceKind(d: { isLocal: boolean; label: string }): DeviceKind {
  if (d.isLocal) return 'computer';
  const label = d.label;
  if (TABLET_IN_NAME.test(label) || /^Mac\b.*\bAASC App\b/.test(label)) return 'tablet';
  if (/^(iPhone|iPod|Android)\b/.test(label)) return 'phone';
  return 'computer';
}

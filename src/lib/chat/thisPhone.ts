/**
 * thisPhone.ts — More → This phone (AASC-47): what this page knows about the
 * pairing, and the way to the app's own settings.
 *
 * The lock (Face ID / fingerprint) and unpairing live in the phone app's own
 * screens (mobile/shell): their secrets never reach a page the Mac serves, and
 * a Mac page has no bridge to call them. So the Mac's page opens the shell's
 * home (its list of Macs, each with its settings: connection, lock, unpair).
 * `?tap=1` lands there without the shell reopening the Mac straight away
 * (mobile/shell/src/app.ts boot()).
 */
import { nativeShellReauthUrl } from '@/lib/platform';

/** The shell's own home screen, or null outside the phone app. */
export function nativeShellHomeUrl(userAgent?: string): string | null {
  const reauth = nativeShellReauthUrl('/', userAgent);
  if (!reauth) return null;
  // capacitor://localhost/?reauth=1… → capacitor://localhost (URL() has no origin for capacitor:).
  const base = reauth.slice(0, reauth.indexOf('/?'));
  return `${base}/?tap=1`;
}

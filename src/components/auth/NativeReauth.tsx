/**
 * NativeReauth — what the phone app shows instead of the password form (AASC-17).
 *
 * The app's shell holds the phone's device token in the Keychain/Keystore and
 * can trade it for a fresh session. When this page finds its session gone, it
 * hands control back to the shell, which signs in again and returns here.
 */
import { useEffect } from 'react';
import { nativeShellReauthUrl } from '@/lib/platform';
import appLayout from '@/styles/modules/AppLayout.module.css';

export default function NativeReauth() {
  useEffect(() => {
    const url = nativeShellReauthUrl(`${window.location.pathname}${window.location.search}`);
    if (url) window.location.replace(url);
  }, []);
  return <div className={appLayout.bootScreen}>Signing in again…</div>;
}

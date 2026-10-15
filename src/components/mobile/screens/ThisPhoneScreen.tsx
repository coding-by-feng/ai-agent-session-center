/**
 * ThisPhoneScreen — More → This phone (AASC-47): the paired Mac and how this
 * phone reaches it, this phone's name on the Mac, and the way to the lock and
 * unpairing, which live in the AASC app's own settings (lib/chat/thisPhone.ts).
 */
import { ListRow, ListSection, Screen } from '../kit';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useWsStore } from '@/stores/wsStore';
import { getClientId } from '@/lib/deviceIdentity';
import { isNativeMobileApp, nativeAppPlatform } from '@/lib/platform';
import { CONNECTION_WORDS, connectionPath } from '@/lib/chat/sessionsModel';
import { nativeShellHomeUrl } from '@/lib/chat/thisPhone';

export default function ThisPhoneScreen() {
  const pop = usePhoneNavStore((s) => s.pop);
  const connected = useWsStore((s) => s.connected);
  const macName = usePresenceStore((s) => s.devices.find((d) => d.isLocal)?.label);
  const myName = usePresenceStore((s) => s.devices.find((d) => d.clientId === getClientId())?.label);
  const path = connectionPath(window.location.hostname);
  const inApp = isNativeMobileApp();
  const shellHome = nativeShellHomeUrl();
  const biometric = nativeAppPlatform() === 'android' ? 'Fingerprint or face lock' : 'Face ID lock';
  const openApp = shellHome ? () => window.location.assign(shellHome) : undefined;

  return (
    <Screen title="This phone" onBack={pop} backLabel="Back to More" testId="phone-more-phone">
      <ListSection header="Paired Mac">
        <ListRow title="Mac" value={macName ?? 'Your Mac'} />
        <ListRow title="Status" value={connected ? 'Online' : 'Reconnecting…'} />
        <ListRow title="Connection" value={CONNECTION_WORDS[path]} />
        <ListRow title="Address" value={window.location.host} />
      </ListSection>
      <ListSection header="On your Mac" footer="This is the name your Mac shows for this phone in its devices list.">
        <ListRow title="This phone’s name" value={myName ?? '—'} />
      </ListSection>
      {inApp ? (
        <ListSection header="Security" footer="The lock and the pairing are kept by the AASC app on this phone, never by the page your Mac serves.">
          <ListRow title={biometric} subtitle="Set in the AASC app’s settings" chevron onClick={openApp} disabledReason={openApp ? undefined : 'Not available here.'} />
          <ListRow title="Unpair from this Mac" subtitle="In the AASC app’s settings, with a confirm" chevron onClick={openApp} disabledReason={openApp ? undefined : 'Not available here.'} destructive />
        </ListSection>
      ) : (
        <ListSection header="Security" footer="Locking with Face ID or a fingerprint, and pairing, come with the AASC phone app. This is a phone browser signed in with your Mac’s password.">
          <ListRow title="Lock and unpair" value="In the AASC app" />
        </ListSection>
      )}
    </Screen>
  );
}

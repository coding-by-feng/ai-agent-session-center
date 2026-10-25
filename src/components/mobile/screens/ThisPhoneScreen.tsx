/**
 * ThisPhoneScreen — More → This phone (AASC-47): the paired Mac and how this
 * phone reaches it, its AASC Cloud connection (AASC-51: connected or not, the
 * last sync, a problem in plain words; the account has no name the Mac knows,
 * so none is shown), this phone's name on the Mac, and the way to the lock and
 * unpairing, which live in the AASC app's own settings (lib/chat/thisPhone.ts).
 * Then what About used to say (folded in Oct 20 2026): the AASC version serving
 * these screens, the phone app's own version (from its user agent), and where they
 * run; the designers' UI kit only in a dev build.
 */
import { ListRow, ListSection, Screen } from '../kit';
import { GalleryIcon } from '../kit/kitIcons';
import { APP_VERSION } from '@/lib/appVersion';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useWsStore } from '@/stores/wsStore';
import { getClientId } from '@/lib/deviceIdentity';
import { isNativeMobileApp, nativeAppPlatform, nativeAppVersion, type NativeAppVersion } from '@/lib/platform';
import { CONNECTION_WORDS, connectionPath } from '@/lib/chat/sessionsModel';
import { nativeShellHomeUrl } from '@/lib/chat/thisPhone';
import { resourcesPath } from '@/lib/chat/phoneRoutes';
import { CLOUD_FETCH_SHORT, fetchCloudStatus, type CloudStatus } from '@/lib/chat/cloudBrowseApi';
import { cloudStateWords, firstSentence, syncWords } from '@/lib/chat/cloudBrowseModel';
import { useClock } from '@/lib/chat/clock';
import { useCloudRead } from './useCloudRead';

/** The app's own version as This phone says it: `1.0.0 (3)`; the apps before 1.0.0 sent no build. */
function appVersionWords(v: NativeAppVersion | null): string {
  if (!v) return 'Unknown';
  return v.build === null ? 'Older app (before 1.0.0)' : `${v.version} (${v.build})`;
}

const readStatus = ({ signal }: { refresh: boolean; signal: AbortSignal }) => fetchCloudStatus(signal);

/** The Cloud row: the Mac's connection to AASC Cloud as this phone sees it; opens Resources → Cloud sync. */
function CloudRow() {
  const push = usePhoneNavStore((s) => s.push);
  const now = useClock();
  const status = useCloudRead<CloudStatus>(readStatus);
  const data = status.data;
  const value = data ? cloudStateWords(data.state) : status.loaded ? 'Unknown' : 'Checking…';
  const subtitle = data
    ? (data.problem ? firstSentence(data.problem) : syncWords(data, now))
    : status.error ? CLOUD_FETCH_SHORT[status.error.problem] : undefined;
  return <ListRow title="Cloud" value={value} subtitle={subtitle} tall chevron onClick={() => push(resourcesPath('cloud'))} testId="this-phone-cloud" />;
}

export default function ThisPhoneScreen() {
  const pop = usePhoneNavStore((s) => s.pop);
  const push = usePhoneNavStore((s) => s.push);
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
      <ListSection header="AASC Cloud" footer="Read through your Mac’s own connection. Connecting, uploads and installs stay on your Mac.">
        <CloudRow />
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
      <ListSection header="AASC" footer="These screens are served by your Mac, so they update with AASC there. Nothing here is stored in the cloud.">
        <ListRow title="AASC on your Mac" value={APP_VERSION ?? 'Unknown'} />
        {inApp && <ListRow title="AASC app on this phone" value={appVersionWords(nativeAppVersion())} />}
        <ListRow title="Running in" value={inApp ? `The ${nativeAppPlatform() === 'android' ? 'Android' : 'iPhone'} app` : 'A phone browser'} />
        {import.meta.env.DEV && (
          <ListRow leading={<GalleryIcon />} title="UI kit" subtitle="For designers: every phone component and its states" chevron onClick={() => push('/more/gallery')} />
        )}
      </ListSection>
    </Screen>
  );
}

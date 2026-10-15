/**
 * AboutScreen — More → About (AASC-39): what this is.
 */
import { ListRow, ListSection, Screen } from '../kit';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { isNativeMobileApp, nativeAppPlatform } from '@/lib/platform';

export default function AboutScreen() {
  const pop = usePhoneNavStore((s) => s.pop);
  const platform = nativeAppPlatform();
  return (
    <Screen title="About" onBack={pop} backLabel="Back to More" testId="phone-more-about">
      <ListSection header="AI Agent Session Center" footer="This screen is served by your Mac. Nothing here is stored in the cloud.">
        <ListRow title="Running in" value={isNativeMobileApp() ? `The ${platform === 'android' ? 'Android' : 'iPhone'} app` : 'A phone browser'} />
        <ListRow title="Layout" value="New design (preview)" />
      </ListSection>
    </Screen>
  );
}

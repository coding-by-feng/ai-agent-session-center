/**
 * AboutScreen — More → About (AASC-39): what this is, and the UI kit gallery.
 */
import { ListRow, ListSection, Screen } from '../kit';
import { GalleryIcon } from '../kit/kitIcons';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { isNativeMobileApp, nativeAppPlatform } from '@/lib/platform';

export default function AboutScreen() {
  const pop = usePhoneNavStore((s) => s.pop);
  const push = usePhoneNavStore((s) => s.push);
  const platform = nativeAppPlatform();
  return (
    <Screen title="About" onBack={pop} backLabel="Back to More" testId="phone-more-about">
      <ListSection header="AI Agent Session Center" footer="This screen is served by your Mac. Nothing here is stored in the cloud.">
        <ListRow title="Running in" value={isNativeMobileApp() ? `The ${platform === 'android' ? 'Android' : 'iPhone'} app` : 'A phone browser'} />
      </ListSection>
      <ListSection header="For designers">
        <ListRow
          leading={<GalleryIcon />}
          title="UI kit"
          subtitle="Every phone component and its states"
          chevron
          onClick={() => push('/more/gallery')}
        />
      </ListSection>
    </Screen>
  );
}

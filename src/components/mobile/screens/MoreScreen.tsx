/**
 * MoreScreen — the More tab's root (AASC-39 placeholder; AASC-47 restyles what
 * it opens). Library, Settings, the "New design" switch, About.
 */
import { ListRow, ListSection, Screen } from '../kit';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { usePhoneUi } from '@/hooks/usePhoneUi';
import type { MorePage } from '@/lib/chat/phoneRoutes';

const LIBRARY: ReadonlyArray<{ page: MorePage; title: string; subtitle: string }> = [
  { page: 'history', title: 'History', subtitle: 'Past sessions, resume one' },
  { page: 'prompts', title: 'Prompt Trace', subtitle: 'Every prompt you sent' },
  { page: 'review', title: 'Review', subtitle: 'Saved AI popups' },
  { page: 'agenda', title: 'Agenda', subtitle: 'Tasks' },
];

export default function MoreScreen() {
  const push = usePhoneNavStore((s) => s.push);
  const [phoneUi, setPhoneUi] = usePhoneUi();

  return (
    <Screen title="More" large testId="phone-more">
      <ListSection header="Library">
        {LIBRARY.map((item) => (
          <ListRow
            key={item.page}
            title={item.title}
            subtitle={item.subtitle}
            chevron
            onClick={() => push(`/more/${item.page}`)}
          />
        ))}
      </ListSection>
      <ListSection header="Settings">
        <ListRow title="Settings" subtitle="Appearance, API keys, translation" chevron onClick={() => push('/more/settings')} />
        <ListRow
          title="New design"
          subtitle="Turn off to go back to the classic phone layout."
          toggle={{ checked: phoneUi === 'app', onChange: (on) => setPhoneUi(on ? 'app' : 'classic') }}
        />
      </ListSection>
      <ListSection header="About">
        <ListRow title="About" chevron onClick={() => push('/more/about')} />
      </ListSection>
    </Screen>
  );
}

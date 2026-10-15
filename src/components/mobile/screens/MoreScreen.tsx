/**
 * MoreScreen — the More tab's root (AASC-47, design §5.8): a grouped list.
 *
 *   LIBRARY     History · Prompt Trace · Saved prompts · Review · Agenda
 *   AASC CLOUD  Cloud: resources and projects, read through the Mac (AASC-51)
 *   SETTINGS    Appearance · Notifications · API keys · Translation · Advanced
 *   THIS PHONE  the paired Mac and how this phone reaches it; lock and unpair
 *   ABOUT
 *
 * Each row pushes a screen of its own (lib/chat/phoneRoutes.ts: `/more/<page>`, a
 * Settings page at `/more/settings/<section>`, so back from it returns to Settings).
 */
import { ListRow, ListSection, Screen } from '../kit';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { usePhoneAppearance, PHONE_APPEARANCES } from '@/lib/chat/phoneAppearance';
import { CONNECTION_WORDS, connectionPath } from '@/lib/chat/sessionsModel';
import { CLOUD_PAGE, LIBRARY_PAGES, SETTINGS_PAGES } from '@/lib/chat/morePages';
import { morePath } from '@/lib/chat/phoneRoutes';

/** The settings rows, shared by More and More → Settings. */
export function SettingsRows() {
  const push = usePhoneNavStore((s) => s.push);
  const [appearance] = usePhoneAppearance();
  return (
    <>
      {SETTINGS_PAGES.map((item) => (
        <ListRow
          key={item.page}
          title={item.title}
          subtitle={item.subtitle}
          value={item.page === 'appearance' ? PHONE_APPEARANCES.find((a) => a.value === appearance)?.label : undefined}
          chevron
          onClick={() => push(morePath(item.page))}
        />
      ))}
    </>
  );
}

export default function MoreScreen() {
  const push = usePhoneNavStore((s) => s.push);
  const macName = usePresenceStore((s) => s.devices.find((d) => d.isLocal)?.label);
  return (
    <Screen title="More" large testId="phone-more">
      <ListSection header="Library">
        {LIBRARY_PAGES.map((item) => (
          <ListRow key={item.page} title={item.title} subtitle={item.subtitle} chevron onClick={() => push(morePath(item.page))} />
        ))}
      </ListSection>
      <ListSection header="AASC Cloud">
        <ListRow title={CLOUD_PAGE.title} subtitle={CLOUD_PAGE.subtitle} chevron onClick={() => push(morePath(CLOUD_PAGE.page))} />
      </ListSection>
      <ListSection header="Settings">
        <SettingsRows />
      </ListSection>
      <ListSection header="This phone">
        <ListRow
          title={macName ? `Paired with ${macName}` : 'Paired Mac'}
          subtitle={`${CONNECTION_WORDS[connectionPath(window.location.hostname)]} · lock, unpair`}
          chevron
          onClick={() => push('/more/phone')}
        />
      </ListSection>
      <ListSection header="About">
        <ListRow title="About" subtitle="What this is, and the UI kit" chevron onClick={() => push('/more/about')} />
      </ListSection>
    </Screen>
  );
}

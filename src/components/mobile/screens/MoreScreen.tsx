/**
 * MoreScreen — the More tab's root (AASC-47, design §5.8): a grouped list.
 *
 *   LIBRARY     History · Prompt Trace (on the Mac itself) · Saved prompts · Review · Agenda
 *   RESOURCES   Resources: the desktop's Library, Cloud sync and Projects, through the Mac (plan 16)
 *   SETTINGS    Appearance · Notifications · Voice · Translation · Advanced
 *   THIS PHONE  the paired Mac and how this phone reaches it; lock and unpair; AASC's
 *               version (About folded in here, Oct 20 2026); in the app, Switch AASC → the
 *               app's Your Macs (Oct 21 2026; "AASC", not "Mac", since Oct 29 2026)
 *
 * Each row pushes a screen of its own (lib/chat/phoneRoutes.ts: `/more/<page>`, a
 * Settings page at `/more/settings/<section>`, so back from it returns to Settings).
 */
import { ListRow, ListSection, Screen } from '../kit';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useSettingsStore, THEMES } from '@/stores/settingsStore';
import { CONNECTION_WORDS, connectionPath } from '@/lib/chat/sessionsModel';
import { LIBRARY_PAGES, RESOURCES_ENTRY, SETTINGS_PAGES } from '@/lib/chat/morePages';
import { morePath, resourcesPath } from '@/lib/chat/phoneRoutes';
import { nativeShellHomeUrl } from '@/lib/chat/thisPhone';
import { useIsHostDevice } from '../views/hostAccess';

/** The settings rows, shared by More and More → Settings. */
export function SettingsRows() {
  const push = usePhoneNavStore((s) => s.push);
  const themeName = useSettingsStore((s) => s.themeName);
  return (
    <>
      {SETTINGS_PAGES.map((item) => (
        <ListRow
          key={item.page}
          title={item.title}
          subtitle={item.subtitle}
          value={item.page === 'appearance' ? THEMES.find((t) => t.name === themeName)?.label : undefined}
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
  const isHost = useIsHostDevice();
  // The app's own Your Macs (null in a phone browser): the shell reopens the Mac used last, so this is the way back.
  // Its row says AASC: the computer you switch to isn't always a Mac.
  const shellHome = nativeShellHomeUrl();
  return (
    <Screen title="More" testId="phone-more">
      <ListSection header="Library">
        {LIBRARY_PAGES.filter((item) => isHost || !item.hostOnly).map((item) => (
          <ListRow key={item.page} title={item.title} subtitle={item.subtitle} chevron onClick={() => push(morePath(item.page))} />
        ))}
      </ListSection>
      <ListSection header="Resources">
        <ListRow title={RESOURCES_ENTRY.title} subtitle={RESOURCES_ENTRY.subtitle} chevron onClick={() => push(resourcesPath())} />
      </ListSection>
      <ListSection header="Settings">
        <SettingsRows />
      </ListSection>
      <ListSection header="This phone">
        <ListRow
          title={macName ? `Paired with ${macName}` : 'Paired Mac'}
          subtitle={`${CONNECTION_WORDS[connectionPath(window.location.hostname)]} · lock, unpair, version`}
          chevron
          onClick={() => push('/more/phone')}
        />
        {shellHome && (
          <ListRow title="Switch AASC" subtitle="Open another AASC or pair a new one" chevron onClick={() => window.location.assign(shellHome)} />
        )}
      </ListSection>
    </Screen>
  );
}

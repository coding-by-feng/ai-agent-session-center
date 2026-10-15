/**
 * SettingsScreen — More → Settings and each of its pages (AASC-47), every one
 * a pushed screen:
 *
 *   Appearance     System / Light / Dark, the accent (from a theme), terminal text size
 *   Notifications  which sessions may notify this phone (mute = no pushes, no sounds)
 *   API keys       today's phone section, kept on this phone
 *   Translation    today's phone section
 *   Advanced       Reset to defaults (confirms)
 *
 * Every setting here is this phone's own (settingsStore keeps them in this
 * phone's storage), except a session's notifications, which are the session's.
 * Hooks, shortcuts and import / export stay on the Mac (AASC-20).
 */
import { lazy, Suspense, useCallback, useMemo, useState, type CSSProperties } from 'react';
import { Banner, Button, ConfirmSheet, EmptyState, ListRow, ListSection, Screen } from '../kit';
import { SettingsRows } from './MoreScreen';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { useSettingsStore, THEMES, type ThemeName } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { showToast } from '@/components/ui/ToastContainer';
import { PHONE_APPEARANCES, usePhoneAppearance } from '@/lib/chat/phoneAppearance';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { isNativeMobileApp } from '@/lib/platform';
import { nativeShellHomeUrl } from '@/lib/chat/thisPhone';
import { useSessionActions } from './info/useSessionActions';
import styles from '@/styles/modules/mobile/MoreScreens.module.css';

const ApiKeySettings = lazy(() => import('@/components/settings/ApiKeySettings'));
const TranslationSettings = lazy(() => import('@/components/settings/TranslationSettings'));

export type SettingsPage = 'settings' | 'appearance' | 'notifications' | 'api-keys' | 'translation' | 'advanced';

const TITLES: Record<SettingsPage, string> = {
  settings: 'Settings',
  appearance: 'Appearance',
  notifications: 'Notifications',
  'api-keys': 'API keys',
  translation: 'Translation',
  advanced: 'Advanced',
};

const FONT_MIN = 10;
const FONT_MAX = 20;

function AppearancePage() {
  const [appearance, setAppearance] = usePhoneAppearance();
  const themeName = useSettingsStore((s) => s.themeName);
  const setThemeName = useSettingsStore((s) => s.setThemeName);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  return (
    <>
      <ListSection header="Light or dark" footer="System follows this phone’s own setting.">
        {PHONE_APPEARANCES.map((a) => (
          <ListRow
            key={a.value}
            title={a.label}
            value={appearance === a.value ? 'Selected' : undefined}
            ariaLabel={`${a.label}${appearance === a.value ? ', selected' : ''}`}
            onClick={() => setAppearance(a.value)}
          />
        ))}
      </ListSection>
      <ListSection header="Accent colour" footer="The phone takes its accent and status colours from one of AASC’s themes, kept readable in light and dark.">
        {THEMES.map((t) => (
          <ListRow
            key={t.name}
            leading={<span className={styles.swatch} style={{ '--swatch': t.colors[1] } as CSSProperties} aria-hidden="true" />}
            title={t.label}
            value={themeName === t.name ? 'Selected' : undefined}
            ariaLabel={`${t.label}${themeName === t.name ? ', selected' : ''}`}
            onClick={() => setThemeName(t.name as ThemeName)}
          />
        ))}
      </ListSection>
      <ListSection header="Terminal text" footer="The size of the terminal’s text on this phone.">
        <li className={styles.stepperRow}>
          <span className={styles.stepperValue}>{fontSize} px</span>
          <span className={styles.stepperButtons}>
            <Button small onClick={() => setFontSize(Math.max(FONT_MIN, fontSize - 1))} disabledReason={fontSize <= FONT_MIN ? 'Smallest already.' : undefined} aria-label="Smaller text">A−</Button>
            <Button small onClick={() => setFontSize(Math.min(FONT_MAX, fontSize + 1))} disabledReason={fontSize >= FONT_MAX ? 'Largest already.' : undefined} aria-label="Larger text">A+</Button>
          </span>
        </li>
      </ListSection>
    </>
  );
}

function NotificationsPage() {
  const sessions = useSessionStore((s) => s.sessions);
  const { setNotifications } = useSessionActions();
  const live = useMemo(
    () => [...sessions.values()].filter((s) => s.status !== 'ended' && !s.isFloating).sort((a, b) => sessionDisplayTitle(a).localeCompare(sessionDisplayTitle(b))),
    [sessions],
  );
  const inApp = isNativeMobileApp();
  const shellHome = nativeShellHomeUrl();
  return (
    <>
      <div className={styles.banner}>
        <Banner tone="info" title={inApp ? 'Push notifications are set in the app' : 'Push notifications come with the AASC app'}>
          {inApp
            ? 'Whether this phone gets notifications at all is in the AASC app’s own settings. Here you choose which sessions may send them.'
            : 'A phone browser can’t receive AASC’s notifications. Here you choose which sessions notify the devices that can.'}
        </Banner>
      </div>
      {inApp && shellHome && (
        <ListSection label="The app’s settings">
          <ListRow title="Open the app’s settings" subtitle="Notifications, lock, paired Macs" chevron onClick={() => window.location.assign(shellHome)} />
        </ListSection>
      )}
      {live.length === 0 ? (
        <EmptyState title="No live sessions" message="Sessions you can see show up here, each with its own switch." />
      ) : (
        <ListSection header="Sessions" footer="Off mutes a session everywhere: no pushes and no sounds from it.">
          {live.map((s) => (
            <ListRow
              key={s.sessionId}
              title={sessionDisplayTitle(s)}
              subtitle={s.projectName}
              toggle={{ checked: !s.muted, onChange: (on) => setNotifications(s, on) }}
              ariaLabel={`Notifications from ${sessionDisplayTitle(s)}`}
            />
          ))}
        </ListSection>
      )}
    </>
  );
}

function AdvancedPage() {
  const resetDefaults = useSettingsStore((s) => s.resetDefaults);
  const [confirming, setConfirming] = useState(false);
  const cancel = useCallback(() => setConfirming(false), []);
  return (
    <>
      <ListSection header="Reset" footer="Every setting on this phone goes back to its default: theme, sounds, translation and the API keys saved here. Your Mac’s settings are not touched.">
        <ListRow title="Reset to defaults" destructive onClick={() => setConfirming(true)} />
      </ListSection>
      <ConfirmSheet
        open={confirming}
        title="Reset all settings?"
        message="Every setting on this phone goes back to its default, API keys included. This cannot be undone."
        confirmLabel="Reset"
        danger
        onConfirm={() => {
          resetDefaults();
          setConfirming(false);
          showToast('Settings reset to defaults', 'info');
        }}
        onCancel={cancel}
      />
    </>
  );
}

export default function SettingsScreen({ page = 'settings' }: { page?: SettingsPage }) {
  const pop = usePhoneNavStore((s) => s.pop);
  const autosaveVisible = useSettingsStore((s) => s.autosaveVisible);
  let body;
  if (page === 'appearance') body = <AppearancePage />;
  else if (page === 'notifications') body = <NotificationsPage />;
  else if (page === 'advanced') body = <AdvancedPage />;
  else if (page === 'api-keys' || page === 'translation') {
    body = (
      <div className={styles.legacy}>
        <Suspense fallback={<EmptyState live title="Loading…" />}>
          {page === 'api-keys' ? <ApiKeySettings /> : <TranslationSettings phone />}
        </Suspense>
      </div>
    );
  } else {
    body = (
      <ListSection label="Settings" footer="These settings belong to this phone.">
        <SettingsRows />
      </ListSection>
    );
  }
  return (
    <Screen
      title={TITLES[page]}
      onBack={pop}
      backLabel={page === 'settings' ? 'Back to More' : 'Back'}
      testId={`phone-more-${page}`}
    >
      {body}
      <p className={styles.saved} role="status">{autosaveVisible ? 'Saved' : ''}</p>
    </Screen>
  );
}

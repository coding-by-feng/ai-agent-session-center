/**
 * SettingsScreen — More → Settings and each of its pages (AASC-47), every one
 * a pushed screen:
 *
 *   Appearance     the desktop's ten themes (light or dark comes with each), text size
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
import { PHONE_TEXT_SCALES, phoneTextScaleLabel, setPhoneTextScale, stepPhoneTextScale, usePhoneTextScale } from '@/lib/chat/phoneAppearance';
import { phonePalette } from '@/lib/chat/phoneThemes';
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

const SCALE_MIN = PHONE_TEXT_SCALES[0];
const SCALE_MAX = PHONE_TEXT_SCALES[PHONE_TEXT_SCALES.length - 1];

/** A theme in miniature: its background, two lines of its text and its accent, as the phone draws them. */
function ThemeSwatch({ name }: { name: ThemeName }) {
  const p = phonePalette(name);
  const vars = { '--sw-bg': p.bg, '--sw-text': p.text, '--sw-accent': p.accent } as CSSProperties;
  return (
    <span className={styles.themeSwatch} style={vars} data-swatch="" aria-hidden="true">
      <span className={styles.themeSwatchAccent} />
    </span>
  );
}

function AppearancePage() {
  const themeName = useSettingsStore((s) => s.themeName);
  const setThemeName = useSettingsStore((s) => s.setThemeName);
  const [scale, setScale] = usePhoneTextScale();
  return (
    <>
      <ListSection header="Theme" footer="Colours for the whole app on this phone, its terminal included. Light or dark comes with the theme. Your Mac keeps its own.">
        {THEMES.map((t) => {
          const selected = themeName === t.name;
          const scheme = phonePalette(t.name).scheme;
          return (
            <ListRow
              key={t.name}
              leading={<ThemeSwatch name={t.name} />}
              title={t.label}
              subtitle={scheme === 'dark' ? 'Dark' : 'Light'}
              value={selected ? 'Selected' : undefined}
              ariaLabel={`${t.label}, ${scheme}${selected ? ', selected' : ''}`}
              onClick={() => setThemeName(t.name)}
            />
          );
        })}
      </ListSection>
      <ListSection header="Text size" footer="The size of the app’s text on this phone. The terminal has its own A− / A+ above it.">
        <li className={styles.stepperRow}>
          <span className={styles.stepperValue}>{phoneTextScaleLabel(scale)}</span>
          <span className={styles.stepperButtons}>
            <Button small onClick={() => setScale(stepPhoneTextScale(scale, -1))} disabledReason={scale <= SCALE_MIN ? 'Smallest already.' : undefined} aria-label="Smaller text">A−</Button>
            <Button small onClick={() => setScale(stepPhoneTextScale(scale, 1))} disabledReason={scale >= SCALE_MAX ? 'Largest already.' : undefined} aria-label="Larger text">A+</Button>
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
          setPhoneTextScale(1);
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

/**
 * PhoneSettings — Settings on a phone (AASC-20, features 79, 83, 84, 86): full
 * screen, a list of sections that each open in place (Back returns to the
 * list), instead of the desktop's tab row, which ran off a phone's edge.
 *
 *   Appearance   themes, font size, scanlines (no 3D model or animation)
 *   API keys     kept in this device's browser storage
 *   Translation  without "where the result opens" and the ⌥ trigger
 *   Advanced     Reset to defaults, after a confirm sheet
 *
 * Not here, by design: hooks (they install into the Mac's CLI settings),
 * shortcuts (a hardware keyboard), export / import (a desktop file workflow),
 * the terminal buffer sizes, and Sound, which on a phone becomes notification
 * settings (feature 81, its own item). Every setting here is this device's own
 * (settingsStore keeps them in IndexedDB), so Reset touches this phone only.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import BottomSheet, { ConfirmSheet } from '@/components/ui/BottomSheet';
import Button from '@/components/ui/Button';
import { showToast } from '@/components/ui/ToastContainer';
import ThemeSettings from './ThemeSettings';
import ApiKeySettings from './ApiKeySettings';
import TranslationSettings from './TranslationSettings';
import styles from '@/styles/modules/PhoneSettings.module.css';

type Section = 'appearance' | 'apikeys' | 'translation' | 'advanced';

const SECTIONS: ReadonlyArray<{ id: Section; label: string; hint: string }> = [
  { id: 'appearance', label: 'Appearance', hint: 'Theme, font size, scanlines' },
  { id: 'apikeys', label: 'API keys', hint: 'Anthropic and OpenAI, kept on this device' },
  { id: 'translation', label: 'Translation', hint: 'Select-to-translate languages' },
  { id: 'advanced', label: 'Advanced', hint: 'Reset to defaults' },
];

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

function BackGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function AdvancedSection() {
  const resetDefaults = useSettingsStore((s) => s.resetDefaults);
  const [confirming, setConfirming] = useState(false);
  const cancel = useCallback(() => setConfirming(false), []);
  return (
    <div className={styles.section}>
      <h4>Reset</h4>
      <p className={styles.hint}>
        Put every setting on this phone back to its default: theme, sounds, translation and the
        API keys saved here. Your Mac&rsquo;s settings are not touched.
      </p>
      <Button variant="danger" className={styles.alignStart} onClick={() => setConfirming(true)}>
        Reset to defaults
      </Button>
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
    </div>
  );
}

export default function PhoneSettings() {
  const closeModal = useUiStore((s) => s.closeModal);
  const autosaveVisible = useSettingsStore((s) => s.autosaveVisible);
  const [section, setSection] = useState<Section | null>(null);
  const current = SECTIONS.find((s) => s.id === section);

  let content: ReactNode = null;
  if (section === 'appearance') content = <ThemeSettings phone />;
  else if (section === 'apikeys') content = <ApiKeySettings />;
  else if (section === 'translation') content = <TranslationSettings phone />;
  else if (section === 'advanced') content = <AdvancedSection />;

  return (
    <BottomSheet open onClose={closeModal} title={current ? current.label : 'Settings'} fullHeight>
      <div className={styles.root} data-testid="phone-settings">
        {current ? (
          <>
            <Button variant="quiet" icon={<BackGlyph />} className={styles.back} onClick={() => setSection(null)}>
              All settings
            </Button>
            <div className={styles.content}>{content}</div>
          </>
        ) : (
          <ul className={styles.menu} role="list">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button type="button" className={styles.menuItem} onClick={() => setSection(s.id)}>
                  <span className={styles.menuText}>
                    <span className={styles.menuLabel}>{s.label}</span>
                    <span className={styles.menuHint}>{s.hint}</span>
                  </span>
                  <Chevron />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className={styles.saved} role="status">{autosaveVisible ? 'Saved' : ''}</p>
      </div>
    </BottomSheet>
  );
}

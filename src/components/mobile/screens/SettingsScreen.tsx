/**
 * SettingsScreen — More → Settings (AASC-39 placeholder; AASC-47 rebuilds it).
 * Today's phone settings body; a section opens in place and the nav bar's back
 * returns to the list before it leaves the screen.
 */
import { useState } from 'react';
import { Screen } from '../kit';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { PhoneSettingsContent } from '@/components/settings/PhoneSettings';
import { PHONE_SETTINGS_SECTIONS, type PhoneSettingsSection } from '@/components/settings/phoneSettingsSections';
import styles from '@/styles/modules/mobile/Screens.module.css';

export default function SettingsScreen() {
  const pop = usePhoneNavStore((s) => s.pop);
  const [section, setSection] = useState<PhoneSettingsSection | null>(null);
  const current = PHONE_SETTINGS_SECTIONS.find((s) => s.id === section);
  return (
    <Screen
      title={current ? current.label : 'Settings'}
      onBack={current ? () => setSection(null) : pop}
      backLabel={current ? 'Back to all settings' : 'Back to More'}
      testId="phone-more-settings"
    >
      <div className={styles.padded}>
        <PhoneSettingsContent section={section} onSection={setSection} showBackButton={false} />
      </div>
    </Screen>
  );
}

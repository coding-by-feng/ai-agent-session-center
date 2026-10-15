/**
 * The sections of Settings on a phone (AASC-20), shared by the classic sheet
 * (PhoneSettings) and the new phone app's More → Settings screen (AASC-39).
 */
export type PhoneSettingsSection = 'appearance' | 'apikeys' | 'translation' | 'advanced';

export const PHONE_SETTINGS_SECTIONS: ReadonlyArray<{ id: PhoneSettingsSection; label: string; hint: string }> = [
  { id: 'appearance', label: 'Appearance', hint: 'Theme, font size, scanlines' },
  { id: 'apikeys', label: 'API keys', hint: 'Anthropic and OpenAI, kept on this device' },
  { id: 'translation', label: 'Translation', hint: 'Select-to-translate languages' },
  { id: 'advanced', label: 'Advanced', hint: 'Reset to defaults' },
];

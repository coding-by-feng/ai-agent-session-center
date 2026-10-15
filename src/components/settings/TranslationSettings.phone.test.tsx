// TranslationSettings.phone.test.tsx — the phone's Translation page (More → Settings,
// AASC-47): no window target and no ⌥ trigger (AASC-20), and its hint names the
// phone's way in, Ask AI in a chat, not a terminal or a file (AASC-48).
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useSettingsStore } from '@/stores/settingsStore';
import TranslationSettings from './TranslationSettings';

beforeEach(() => {
  useSettingsStore.setState({ translationTrigger: 'auto' });
});

describe('TranslationSettings on a phone', () => {
  it('has no window target and no ⌥ trigger', () => {
    render(<TranslationSettings phone />);
    expect(screen.queryByText('Where the result opens')).toBeNull();
    expect(screen.queryByText(/Hold ⌥/)).toBeNull();
    expect(screen.getByRole('radio', { name: /Auto/ })).toBeTruthy();
  });

  it('says where a phone selects text: a session’s Chat, then Ask AI', () => {
    render(<TranslationSettings phone />);
    expect(screen.getByText(/Select text in a session’s Chat and tap Ask AI/)).toBeTruthy();
    expect(screen.queryByText(/in the terminal or in a markdown file/)).toBeNull();
  });

  it('keeps the desktop’s wording on the desktop', () => {
    render(<TranslationSettings />);
    expect(screen.getByText(/Select text in the terminal or in a markdown file/)).toBeTruthy();
  });
});

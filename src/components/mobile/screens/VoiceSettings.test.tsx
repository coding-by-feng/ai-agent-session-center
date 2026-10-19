// VoiceSettings.test.tsx — More → Settings → Voice (Oct 20 2026): the phone can turn
// read aloud on (a Google key, the switch, the desktop's voices, speed), on the
// desktop's own settings fields.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/ttsEngine', () => ({
  ttsEngine: { speak: vi.fn(async () => {}), stop: vi.fn() },
  checkTTSStatus: vi.fn(async () => ({ ok: true })),
}));

import VoiceSettings from './VoiceSettings';
import { useSettingsStore } from '@/stores/settingsStore';
import { checkTTSStatus, ttsEngine } from '@/lib/ttsEngine';

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ googleTtsApiKey: '', ttsEnabled: false, ttsVoiceEn: 'en-US-Chirp3-HD-Aoede', ttsVoiceZh: 'cmn-CN-Chirp3-HD-Aoede', ttsSpeakingRate: 1 });
});

describe('VoiceSettings', () => {
  it('keeps Read aloud off until a key is saved, then turns it on', async () => {
    const user = userEvent.setup();
    render(<VoiceSettings />);
    const toggle = screen.getByRole('switch', { name: 'Read aloud' });
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getAllByText('Save a key first.').length).toBeGreaterThan(0);

    await user.type(screen.getByTestId('voice-key'), 'AIza-test-key');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(useSettingsStore.getState().googleTtsApiKey).toBe('AIza-test-key');

    await user.click(screen.getByRole('switch', { name: 'Read aloud' }));
    expect(useSettingsStore.getState().ttsEnabled).toBe(true);
  });

  it('checks a saved key through the Mac', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ googleTtsApiKey: 'AIza-saved' });
    render(<VoiceSettings />);
    await user.click(screen.getByRole('button', { name: 'Check key' }));
    expect(checkTTSStatus).toHaveBeenCalledWith('AIza-saved');
    expect(await screen.findByText('✓ The key works')).toBeInTheDocument();
  });

  it('turns Read aloud off when the key is removed', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ googleTtsApiKey: 'AIza-saved', ttsEnabled: true });
    render(<VoiceSettings />);
    await user.clear(screen.getByTestId('voice-key'));
    await user.click(screen.getByRole('button', { name: 'Remove the key' }));
    expect(useSettingsStore.getState()).toMatchObject({ googleTtsApiKey: '', ttsEnabled: false });
  });

  it('picks a voice from the desktop’s list and steps the speed', async () => {
    const user = userEvent.setup();
    render(<VoiceSettings />);
    await user.click(screen.getByRole('button', { name: /English voice/ }));
    await user.click(within(await screen.findByTestId('voice-picker')).getByRole('button', { name: 'Puck (Chirp 3 HD, male)' }));
    expect(useSettingsStore.getState().ttsVoiceEn).toBe('en-US-Chirp3-HD-Puck');

    await user.click(screen.getByRole('button', { name: 'Faster' }));
    expect(useSettingsStore.getState().ttsSpeakingRate).toBe(1.25);
    await user.click(screen.getByRole('button', { name: 'Slower' }));
    await user.click(screen.getByRole('button', { name: 'Slower' }));
    expect(useSettingsStore.getState().ttsSpeakingRate).toBe(0.75);
  });

  it('plays a sample with the chosen voices once it is on', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ googleTtsApiKey: 'AIza-saved', ttsEnabled: true, ttsVoiceEn: 'en-US-Studio-O' });
    render(<VoiceSettings />);
    await user.click(screen.getByRole('button', { name: 'Play a sample' }));
    expect(ttsEngine.speak).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ apiKey: 'AIza-saved', voiceEn: 'en-US-Studio-O', speakingRate: 1 }));
  });
});

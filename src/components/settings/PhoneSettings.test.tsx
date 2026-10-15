// PhoneSettings.test.tsx — Settings on a phone (AASC-20, features 79, 83, 84,
// 86): SettingsPanel opens a full-screen list of Appearance, API keys,
// Translation and Advanced (no hooks, shortcuts, export / import or sound);
// Appearance drops the 3D-only choices, Translation the window target and the
// ⌥ trigger, and Advanced is Reset alone, behind a confirm sheet.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import SettingsPanel from './SettingsPanel';
import { useUiStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { PHONE_UI_KEY, writePhoneUi } from '@/hooks/usePhoneUi';

let resetDefaults: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  platform.isMobile = true;
  resetDefaults = vi.fn<() => void>();
  useUiStore.setState({ activeModal: 'settings' });
  useSettingsStore.setState({ autosaveVisible: false, resetDefaults, translationTrigger: 'auto' });
});

async function openSettings() {
  render(<SettingsPanel />);
  return screen.findByTestId('phone-settings');
}

describe('Settings on a phone', () => {
  it('is a full-screen list of the four phone sections', async () => {
    const root = await openSettings();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    const items = within(root).getAllByRole('button').map((b) => b.textContent ?? '');
    expect(items.map((t) => t.split(/(?=[A-Z][a-z])/)[0])).toEqual(['Appearance', 'API keys', 'Translation', 'Advanced']);
    expect(screen.queryByText(/HOOKS|SHORTCUTS|Export|Import|Sound/)).toBeNull();
  });

  it('renders nothing while closed (and loads nothing)', () => {
    useUiStore.setState({ activeModal: null });
    const { container } = render(<SettingsPanel />);
    expect(container.innerHTML).toBe('');
  });

  it('Appearance: themes and font size, without the 3D model or animation', async () => {
    const user = userEvent.setup();
    await openSettings();
    await user.click(screen.getByRole('button', { name: /^Appearance/ }));
    expect(screen.getByRole('dialog', { name: 'Appearance' })).toBeTruthy();
    expect(screen.getByText('Theme')).toBeTruthy();
    expect(screen.getByText('Font Size')).toBeTruthy();
    expect(screen.queryByText('3D Character Model')).toBeNull();
    expect(screen.queryByText('Animation')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'All settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });

  it('Translation: no window target and no ⌥ trigger', async () => {
    const user = userEvent.setup();
    await openSettings();
    await user.click(screen.getByRole('button', { name: /^Translation/ }));
    expect(screen.queryByText('Where the result opens')).toBeNull();
    expect(screen.queryByText(/Hold ⌥/)).toBeNull();
    expect(screen.getByRole('radio', { name: /Auto/ })).toBeTruthy();
  });

  it('API keys: the key fields', async () => {
    const user = userEvent.setup();
    await openSettings();
    await user.click(screen.getByRole('button', { name: /^API keys/ }));
    expect(screen.getByText('Anthropic API Key')).toBeTruthy();
  });

  it('Advanced: Reset only, after a confirm sheet', async () => {
    const user = userEvent.setup();
    await openSettings();
    await user.click(screen.getByRole('button', { name: /^Advanced/ }));
    expect(screen.queryByText(/Export|Import|Terminal/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(resetDefaults).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('dialog', { name: 'Reset all settings?' });
    await user.click(within(confirm).getByRole('button', { name: 'Reset' }));
    expect(resetDefaults).toHaveBeenCalledTimes(1);
  });

  it('the desktop keeps its tabbed modal', () => {
    platform.isMobile = false;
    render(<SettingsPanel />);
    expect(screen.getByText('APPEARANCE')).toBeTruthy();
    expect(screen.getByText('HOOKS')).toBeTruthy();
    expect(screen.queryByTestId('phone-settings')).toBeNull();
  });

  it('offers the new design as a switch, and closes so the new app opens clean (AASC-38)', async () => {
    const user = userEvent.setup();
    writePhoneUi('classic');
    await openSettings();
    const sw = screen.getByRole('switch', { name: /New design/ });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await user.click(sw);
    expect(localStorage.getItem(PHONE_UI_KEY)).toBe('app');
    expect(useUiStore.getState().activeModal).toBeNull();
    writePhoneUi('classic');
  });
});

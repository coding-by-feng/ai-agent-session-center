// ThemeSettings.instantTyping.test.tsx — Settings ▸ APPEARANCE ▸ Terminal ▸ Instant typing (local echo).
// On by default, saved when changed, and in Lite too: APPEARANCE is one of the three tabs Lite keeps, so this is
// Lite's only off switch for it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const edition = vi.hoisted(() => ({ lite: false }));
vi.mock('@/lib/edition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/edition')>();
  return { ...actual, get IS_LITE() { return edition.lite; } };
});

import ThemeSettings from './ThemeSettings';
import { useSettingsStore } from '@/stores/settingsStore';

const checkbox = () => screen.getByRole('checkbox', { name: /Instant typing/ }) as HTMLInputElement;

describe('Instant typing setting', () => {
  let persist: ReturnType<typeof vi.fn<(key: string, value: unknown) => Promise<void>>>;
  beforeEach(() => {
    edition.lite = false;
    persist = vi.fn<(key: string, value: unknown) => Promise<void>>().mockResolvedValue(undefined);
    useSettingsStore.setState({ instantTyping: true, persistSetting: persist });
  });

  it('is on for a fresh install', () => {
    useSettingsStore.setState({ instantTyping: false });
    useSettingsStore.getState().resetDefaults();
    expect(useSettingsStore.getState().instantTyping).toBe(true);
  });

  it('shows checked under APPEARANCE and saves the change', () => {
    render(<ThemeSettings />);
    expect(checkbox().checked).toBe(true);
    fireEvent.click(checkbox());
    expect(useSettingsStore.getState().instantTyping).toBe(false);
    expect(persist).toHaveBeenCalledWith('instantTyping', false);
  });

  it('comes back as saved', () => {
    useSettingsStore.getState().loadFromDb({ instantTyping: false });
    expect(useSettingsStore.getState().instantTyping).toBe(false);
  });

  it('is offered in Lite, which keeps APPEARANCE', () => {
    edition.lite = true;
    render(<ThemeSettings />);
    expect(checkbox()).toBeInTheDocument();
  });
});

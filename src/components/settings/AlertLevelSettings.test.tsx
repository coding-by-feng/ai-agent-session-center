// AlertLevelSettings.test.tsx — Settings ▸ Sound ▸ Alert levels edits the server's table (Nov 25 2026).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import AlertLevelSettings from './AlertLevelSettings';
import { useAlertConfigStore } from '@/stores/alertConfigStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { getClientId } from '@/lib/deviceIdentity';
import { DEFAULT_ALERT_CONFIG, type AlertConfig } from '@/lib/attention';

describe('AlertLevelSettings', () => {
  const save = vi.fn<(next: AlertConfig) => Promise<boolean>>(async () => true);
  beforeEach(() => {
    save.mockClear();
    useAlertConfigStore.setState({ config: DEFAULT_ALERT_CONFIG, loaded: true, save } as never);
    // This window is on the Mac: the table is the Mac's to change (PUT /api/alert-levels answers it alone).
    usePresenceStore.setState({ devices: [{ clientId: getClientId(), isLocal: true }] } as never);
  });

  it('shows every level, with Silent fixed and the others editable', () => {
    render(<AlertLevelSettings />);
    for (const name of ['Silent', 'Quiet', 'Normal', 'Loud', 'Urgent']) {
      expect(screen.getByRole('rowheader', { name })).toBeTruthy();
    }
    expect(screen.queryByLabelText('Silent: sound')).toBeNull();
    expect((screen.getByLabelText('Urgent: repeat') as HTMLSelectElement).value).toBe('5');
    expect((screen.getByLabelText('Normal: notification') as HTMLSelectElement).value).toBe('proceed');
    expect((screen.getByLabelText('Loud: glowing card') as HTMLInputElement).checked).toBe(true);
  });

  it('saves the whole table with the one change', () => {
    render(<AlertLevelSettings />);
    fireEvent.change(screen.getByLabelText('Quiet: sound'), { target: { value: 'normal' } });
    expect(save).toHaveBeenCalledTimes(1);
    const next = save.mock.calls[0]![0];
    expect(next.levels.quiet.sound).toBe('normal');
    expect(next.levels.loud).toEqual(DEFAULT_ALERT_CONFIG.levels.loud);

    fireEvent.click(screen.getByLabelText('Normal: phone push'));
    expect(save.mock.calls[1]![0].levels.normal.push).toBe(false);

    fireEvent.change(screen.getByLabelText('Default level'), { target: { value: 'quiet' } });
    expect(save.mock.calls[2]![0].defaultLevel).toBe('quiet');
  });

  it('offers Reset only once the table differs from the defaults', () => {
    const { rerender } = render(<AlertLevelSettings />);
    expect(screen.queryByRole('button', { name: 'Reset to defaults' })).toBeNull();
    act(() => useAlertConfigStore.setState({ config: { ...DEFAULT_ALERT_CONFIG, defaultLevel: 'loud' } } as never));
    rerender(<AlertLevelSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(save).toHaveBeenLastCalledWith(DEFAULT_ALERT_CONFIG);
  });

  it('elsewhere, or before the server says where it is, shows the table to read: only the Mac changes it', () => {
    const changed = { ...DEFAULT_ALERT_CONFIG, defaultLevel: 'loud' as const };
    for (const devices of [[{ clientId: getClientId(), isLocal: false }], []]) {
      usePresenceStore.setState({ devices } as never);
      useAlertConfigStore.setState({ config: changed } as never);
      const { unmount } = render(<AlertLevelSettings />);
      expect(screen.queryAllByRole('combobox')).toHaveLength(0);
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Reset to defaults' })).toBeNull();
      expect(screen.getByText('Only your Mac can change these.')).toBeTruthy();
      const urgent = screen.getByRole('rowheader', { name: 'Urgent' }).closest('tr')!;
      expect(within(urgent).getByText('5 min')).toBeTruthy();
      expect(within(urgent).getAllByText('On')).toHaveLength(2);
      unmount();
    }
    expect(save).not.toHaveBeenCalled();
  });
});

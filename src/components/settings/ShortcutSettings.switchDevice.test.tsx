// The `switchDevice` key in the two places the app lists its shortcuts: Settings → Shortcuts (rebindable) and the
// `?` panel (read-only, the one Lite has). Listed only in a window whose devices panel has the Switch part.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ShortcutSettings from './ShortcutSettings';
import ShortcutsPanel from '@/components/modals/ShortcutsPanel';
import { buildBindings, isMac } from '@/lib/shortcutKeys';
import { useShortcutStore } from '@/stores/shortcutStore';
import { useUiStore } from '@/stores/uiStore';

const KEY_TEXT = isMac ? 'Cmd+Shift+S' : 'Ctrl+Shift+S';

function withAccountChannels(): void {
  window.electronAPI = { remotes: { accountMachines: () => Promise.resolve({ ok: true, data: { state: 'signed-out' } }) } } as unknown as typeof window.electronAPI;
}

beforeEach(() => {
  useUiStore.setState({ activeModal: null });
});

afterEach(() => {
  delete window.electronAPI;
  useShortcutStore.setState({ bindings: buildBindings() } as never);
  useUiStore.setState({ activeModal: null });
});

describe('the switchDevice key in the shortcut lists', () => {
  it('Settings lists "Switch computer" with its key, under Session Switch', () => {
    withAccountChannels();
    useShortcutStore.setState({ bindings: buildBindings() } as never);
    render(<ShortcutSettings />);
    const section = screen.getByText('Session Switch').parentElement as HTMLElement;
    const row = within(section).getByText('Switch computer').closest('div') as HTMLElement;
    expect(within(row).getByText(KEY_TEXT)).toBeTruthy();
    // After "Search sessions", before the numbered session keys.
    const labels = [...section.querySelectorAll('span')].map((el) => el.textContent);
    expect(labels.indexOf('Switch computer')).toBe(labels.indexOf('Search sessions') + 1);
    expect(labels.indexOf('Switch to session 1')).toBe(labels.indexOf('Switch computer') + 1);
  });

  it('the ? panel lists it too', () => {
    withAccountChannels();
    useShortcutStore.setState({ bindings: buildBindings() } as never);
    useUiStore.setState({ activeModal: 'shortcuts' });
    render(<ShortcutsPanel />);
    expect(screen.getByText('Switch computer')).toBeTruthy();
    expect(screen.getByText(KEY_TEXT)).toBeTruthy();
  });

  it('neither lists it in a window with no devices switcher', () => {
    useShortcutStore.setState({ bindings: buildBindings() } as never);
    const settings = render(<ShortcutSettings />);
    expect(screen.queryByText('Switch computer')).toBeNull();
    settings.unmount();
    useUiStore.setState({ activeModal: 'shortcuts' });
    render(<ShortcutsPanel />);
    expect(screen.queryByText('Switch computer')).toBeNull();
    expect(screen.queryByText(KEY_TEXT)).toBeNull();
  });
});

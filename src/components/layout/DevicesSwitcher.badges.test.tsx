// DevicesSwitcher.badges.test.tsx — the Switch part as a quick switcher (Nov 27 2026): each row's state, connection
// and counts as pills, and the `switchDevice` key named where it is used.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { buildBindings, isMac } from '@/lib/shortcutKeys';
import { useShortcutStore } from '@/stores/shortcutStore';
import { HERE, directoryOf, installWorld, linked, machine, offline, online, record, renderSwitcher, type World } from './DevicesSwitcher.fixtures';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

let world: World;

beforeEach(() => {
  world = installWorld();
  useShortcutStore.setState({ bindings: buildBindings() });
});

afterEach(() => {
  delete window.electronAPI;
  vi.clearAllMocks();
});

const tones = (row: HTMLElement) =>
  [...row.querySelectorAll('[data-tone]')].map((p) => `${p.getAttribute('data-tone')}:${p.textContent}`);
const rowOf = (name: string) => screen.getByText(name, { selector: 'span[title]' }).closest('li') as HTMLElement;

describe('DevicesSwitcher — row badges', () => {
  it('an account computer and a computer paired by link draw their state, connection and counts as pills', async () => {
    world.directory = directoryOf(HERE, machine({}), machine({ deviceId: 'd-vps', name: 'VPS' }));
    world.stored = [record({}), record({ id: 'r-vps', name: 'VPS', backendDeviceId: 'd-vps' }), linked()];
    world.answers = {
      'r-mini': online({ needsYou: 2 }),
      'r-vps': offline('no address answered'),
      'r-nuc': online({ via: 'public', sharedSessions: 0 }),
    };
    renderSwitcher();
    await screen.findByText('Online · Tailscale · 4 shared · 2 need you');
    expect(tones(rowOf('Mac mini'))).toEqual(['online:Online', 'neutral:Tailscale', 'neutral:4 shared', 'warn:2 need you']);
    await waitFor(() => expect(tones(rowOf('VPS'))).toEqual(['offline:Offline']));
    expect(within(rowOf('VPS')).getByText('No address answered')).toBeTruthy();
    const link = rowOf(world.stored[2].name);
    expect(tones(link)).toEqual(['online:Online', 'warn:Public IP, unencrypted', 'neutral:0 shared']);
  });

  it('an account computer never connected to says so in one grey pill', async () => {
    world.directory = directoryOf(HERE, machine({ deviceId: 'd-imac', name: 'Studio iMac' }));
    world.stored = [];
    renderSwitcher();
    await waitFor(() => expect(tones(rowOf('Studio iMac'))).toEqual(['checking:Not connected yet']));
  });
});

describe('DevicesSwitcher — the key line', () => {
  it('names the switchDevice key as bound now, and follows a rebinding', async () => {
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [record({})];
    world.answers = { 'r-mini': online() };
    renderSwitcher();
    const line = await screen.findByText(/closes$/);
    expect(line.textContent).toContain(isMac ? '⇧⌘S' : 'Ctrl+Shift+S');
    useShortcutStore.getState().rebind('switchDevice', isMac ? { key: 'k', altKey: true, metaKey: true } : { key: 'k', altKey: true, ctrlKey: true });
    await waitFor(() => expect(screen.getByText(/closes$/).textContent).toContain(isMac ? '⌥⌘K' : 'K'));
  });

  it('is not drawn where the key has no binding', async () => {
    useShortcutStore.setState({ bindings: useShortcutStore.getState().bindings.filter((b) => b.actionId !== 'switchDevice') });
    world.directory = directoryOf(HERE);
    renderSwitcher();
    await screen.findByRole('region', { name: 'This computer' });
    expect(screen.queryByText(/closes$/)).toBeNull();
  });
});

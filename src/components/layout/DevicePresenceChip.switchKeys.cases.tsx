// DevicePresenceChip.switchKeys.cases.tsx — the devices panel's Switch part from the keyboard (plan 18 §5.4), in
// Full AND Lite: where focus lands when the panel opens, Escape, and the `switchDevice` key (⇧⌘S / Ctrl+Shift+S),
// with the chip on screen and without it (a session panel hides the header, and the chip with it).
// Shared by DevicePresenceChip.switchKeys.test.tsx (Full) and DevicePresenceChip.switchKeys.lite.test.tsx.
// The panel without the Switch part is in DevicePresenceChip.keys.test.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import DevicePresenceChip from './DevicePresenceChip';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { DEVICES_SWITCH_EVENT } from '@/lib/devicesSwitcher';
import { buildBindings, isMac } from '@/lib/shortcutKeys';
import { usePresenceStore } from '@/stores/presenceStore';
import { useShortcutStore } from '@/stores/shortcutStore';
import { useUiStore } from '@/stores/uiStore';
import type { DevicePresence } from '@/types';
import { HERE, directoryOf, fleet, installWorld, linked, machine, type World } from './DevicesSwitcher.fixtures';

/** The `switchDevice` key as each platform reports it. */
const SWITCH_KEY = isMac ? { key: 's', shiftKey: true, metaKey: true } : { key: 'S', shiftKey: true, ctrlKey: true };

function device(overrides: Partial<DevicePresence>): DevicePresence {
  return { clientId: 'me', label: 'MacBook Pro', address: '::1', isLocal: true, connections: 1, connectedAt: Date.now(), lastSeenAt: Date.now(), ...overrides };
}

export function describeSwitchKeys(edition: 'Full' | 'Lite'): void {
  let world: World;

  beforeEach(() => {
    usePresenceStore.setState({ devices: [device({})], controllers: new Map() });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/config') return json(200, { localIP: '192.168.6.42', passwordEnabled: true });
      if (url === '/api/mobile/devices') return json(200, { success: true, data: { devices: [], pairingOffered: true } });
      if (url === '/api/mobile/cloud-phones') return json(200, { success: true, data: { cloud: false } });
      if (url === '/api/sharing-default') return json(200, { shareNewSessions: false });
      return json(404, { error: 'Not found' });
    }));
    world = installWorld();
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [linked()];
    // The bindings are built for the window: this one has the account channels, so it has the key.
    useShortcutStore.setState({ bindings: buildBindings() } as never);
    useUiStore.setState({ activeModal: null });
  });

  afterEach(() => {
    delete window.electronAPI;
    useShortcutStore.setState({ bindings: buildBindings() } as never);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const chip = () => screen.getByRole('button', { name: /devices? connected/ });
  const tab = (name: string) => screen.getByRole('tab', { name });
  const fetched = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);

  async function openPanel(): Promise<HTMLElement> {
    fireEvent.click(chip());
    return screen.findByRole('dialog', { name: 'Connected devices' });
  }

  /** The This computer part, once its lazy sections have landed. */
  async function thisComputer(panel: HTMLElement): Promise<void> {
    fireEvent.click(tab('This computer'));
    const part = within(within(panel).getByRole('tabpanel'));
    await part.findByText(/^http:\/\/192\.168\.6\.42/);
    await part.findByText('No phones or computers paired.');
  }

  describe(`DevicePresenceChip — the Switch part from the keyboard (${edition})`, () => {
    const focused = () => document.activeElement as HTMLElement;
    const dialog = () => screen.queryByRole('dialog', { name: 'Connected devices' });
    const connect = () => screen.getByRole('button', { name: 'Connect Mac mini' });

    /** The chip beside something else that can hold focus, with the app's shortcut handler mounted as AppLayout mounts it. */
    function renderApp(chip = <DevicePresenceChip />) {
      renderHook(() => useKeyboardShortcuts());
      render(
        <MemoryRouter>
          <button type="button">Elsewhere</button>
          {chip}
        </MemoryRouter>,
      );
      const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
      elsewhere.focus();
      return elsewhere;
    }

    it('the chip’s tooltip names the key as bound now; its accessible name stays the device count (Nov 27 2026)', () => {
      renderApp();
      expect(chip().getAttribute('title')).toBe(`1 device connected · Switch computer ${isMac ? '⇧⌘S' : 'Ctrl+Shift+S'}`);
      expect(chip().getAttribute('aria-label')).toBe('1 device connected');
    });

    it('opening the panel moves focus into Switch: the first row’s primary action', async () => {
      render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
      chip().focus();
      await openPanel();
      await waitFor(() => expect(focused()).toBe(connect()));
    });

    it('a part that is left is unmounted at once, even while the other part’s sections are still loading', async () => {
      render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
      const panel = await openPanel();
      await within(panel).findByRole('button', { name: 'Connect Mac mini' });
      fireEvent.click(tab('This computer'));
      // Not merely hidden: a part kept mounted behind the other one would go on polling, and would come back
      // with its focus rule already spent.
      expect(panel.querySelector('section[aria-label="My computers"]')).toBeNull();
      expect(panel.querySelector('[data-primary-action]')).toBeNull();
    });

    it('coming back to Switch by its tab moves no focus', async () => {
      render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
      const panel = await openPanel();
      await thisComputer(panel);
      tab('Switch').focus();
      fireEvent.click(tab('Switch'));
      // Every row is drawn and the account has answered. An opening moves focus in an effect, a task after the rows
      // are drawn, so wait a real moment before saying nothing moved (proved by taking `setArrival(false)` out).
      await within(panel).findByRole('button', { name: 'Connect Mac mini' });
      await within(panel).findByRole('button', { name: 'Open Old NUC' });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      expect(focused()).toBe(tab('Switch'));
    });

    it('Escape closes the panel and returns focus to the chip', async () => {
      render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
      chip().focus();
      await openPanel();
      await waitFor(() => expect(focused()).toBe(connect()));
      fireEvent.keyDown(focused(), { key: 'Escape' });
      expect(dialog()).toBeNull();
      expect(focused()).toBe(chip());
    });

    it('an Escape the panel takes is the panel’s alone: the session panel behind it, listening on the window, never hears it', async () => {
      const heard: string[] = [];
      const listen = (e: KeyboardEvent) => heard.push(e.key);
      window.addEventListener('keydown', listen);
      try {
        render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
        await openPanel();
        await waitFor(() => expect(focused()).toBe(connect()));
        fireEvent.keyDown(focused(), { key: 'ArrowDown' });
        fireEvent.keyDown(focused(), { key: 'Escape' });
        expect(dialog()).toBeNull();
        // With the panel closed, Escape is the page's again.
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(heard).toEqual(['ArrowDown', 'Escape']);
      } finally {
        window.removeEventListener('keydown', listen);
      }
    });

    it('the switchDevice key opens the panel on Switch with focus in it, and pressed again closes it, back where focus was', async () => {
      const elsewhere = renderApp();
      expect(fireEvent.keyDown(elsewhere, SWITCH_KEY)).toBe(false);
      expect(dialog()).toBeTruthy();
      expect(tab('Switch').getAttribute('aria-selected')).toBe('true');
      await waitFor(() => expect(focused()).toBe(connect()));
      expect(fireEvent.keyDown(focused(), SWITCH_KEY)).toBe(false);
      expect(dialog()).toBeNull();
      expect(focused()).toBe(elsewhere);
    });

    it('takes focus out of what was typed in at once, before any row is drawn', async () => {
      const elsewhere = renderApp();
      fireEvent.keyDown(elsewhere, SWITCH_KEY);
      // The rows are not read yet: focus is on the panel itself, so the next key is the panel's, not a terminal's.
      expect(focused()).toBe(dialog());
      await waitFor(() => expect(focused()).toBe(connect()));
    });

    it('Escape after the key returns focus to where it was, not to the chip', async () => {
      const elsewhere = renderApp();
      fireEvent.keyDown(elsewhere, SWITCH_KEY);
      await waitFor(() => expect(focused()).toBe(connect()));
      fireEvent.keyDown(focused(), { key: 'Escape' });
      expect(dialog()).toBeNull();
      expect(focused()).toBe(elsewhere);
    });

    it('pressed while the panel shows This computer, the key goes to Switch and focuses it as an opening does', async () => {
      const elsewhere = renderApp();
      const panel = await openPanel();
      await thisComputer(panel);
      fireEvent.keyDown(elsewhere, SWITCH_KEY);
      expect(dialog()).toBeTruthy();
      expect(tab('Switch').getAttribute('aria-selected')).toBe('true');
      await waitFor(() => expect(focused()).toBe(connect()));
    });

    it('with the search field shown, focus goes to it, and the key pressed there closes the panel', async () => {
      fleet(world, ['Mac mini', 'Studio iMac', 'Office NUC', 'Build box', 'VPS Sydney', 'MacBook Air', 'Render node'], ['Lab PC', 'Garage Pi']);
      const elsewhere = renderApp();
      fireEvent.keyDown(elsewhere, SWITCH_KEY);
      const field = await screen.findByRole('textbox', { name: 'Search computers' });
      await waitFor(() => expect(focused()).toBe(field));
      expect(fireEvent.keyDown(field, SWITCH_KEY)).toBe(false);
      expect(dialog()).toBeNull();
      expect(focused()).toBe(elsewhere);
    });

    it('does nothing behind a dialog', () => {
      const elsewhere = renderApp();
      useUiStore.setState({ activeModal: 'settings' });
      fireEvent.keyDown(elsewhere, SWITCH_KEY);
      expect(dialog()).toBeNull();
      expect(focused()).toBe(elsewhere);
    });

    describe('with no chip on screen (a session panel hides the header)', () => {
      it('draws nothing and reads nothing until the key is pressed', async () => {
        renderApp(<DevicePresenceChip chipless />);
        expect(screen.queryByRole('button', { name: /devices? connected/ })).toBeNull();
        expect(dialog()).toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(fetched()).toEqual([]);
        expect(world.api.list).not.toHaveBeenCalled();
      });

      it('the key opens the panel under the window’s top right corner, with focus in it', async () => {
        const elsewhere = renderApp(<DevicePresenceChip chipless />);
        fireEvent.keyDown(elsewhere, SWITCH_KEY);
        const panel = dialog()!;
        expect(panel.style.width).toBe('360px');
        expect(panel.style.left).toBe(`${window.innerWidth - 360 - 8}px`);
        expect(panel.style.top).toBe('8px');
        expect(tab('Switch').getAttribute('aria-selected')).toBe('true');
        await waitFor(() => expect(focused()).toBe(connect()));
      });

      it('Escape, or the key again, closes it and returns focus to where it was', async () => {
        const elsewhere = renderApp(<DevicePresenceChip chipless />);
        fireEvent.keyDown(elsewhere, SWITCH_KEY);
        await waitFor(() => expect(focused()).toBe(connect()));
        fireEvent.keyDown(focused(), { key: 'Escape' });
        expect(dialog()).toBeNull();
        expect(focused()).toBe(elsewhere);
        fireEvent.keyDown(elsewhere, SWITCH_KEY);
        await waitFor(() => expect(focused()).toBe(connect()));
        fireEvent.keyDown(focused(), SWITCH_KEY);
        expect(dialog()).toBeNull();
        expect(focused()).toBe(elsewhere);
      });

      it('a press outside closes it', async () => {
        const elsewhere = renderApp(<DevicePresenceChip chipless />);
        fireEvent.keyDown(elsewhere, SWITCH_KEY);
        expect(dialog()).toBeTruthy();
        fireEvent.mouseDown(elsewhere);
        expect(dialog()).toBeNull();
      });
    });

    it('the event alone is enough: whatever asks, the chip answers', async () => {
      render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
      fireEvent(document, new CustomEvent(DEVICES_SWITCH_EVENT));
      expect(dialog()).toBeTruthy();
      fireEvent(document, new CustomEvent(DEVICES_SWITCH_EVENT));
      expect(dialog()).toBeNull();
    });
  });
}

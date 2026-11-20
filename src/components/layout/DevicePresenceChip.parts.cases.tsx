// DevicePresenceChip.parts.cases.tsx — the devices panel's two parts, Switch and This computer (plan 18 stage 2),
// in Full AND Lite. Shared by DevicePresenceChip.parts.test.tsx (Full) and DevicePresenceChip.parts.lite.test.tsx
// (IS_LITE mocked true): the plan puts the switcher and the Account settings in both desktop editions.
//
// The two parts show only with the account channels (`electronAPI.remotes.accountMachines`) on this computer's
// desktop app. What the panel is without them is pinned by DevicePresenceChip.unchanged.test.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router';
import DevicePresenceChip from './DevicePresenceChip';
import { usePresenceStore } from '@/stores/presenceStore';
import type { DevicePresence } from '@/types';
import type { AccountDirectory } from '@/types/electron';
import { HERE, directoryOf, installWorld, linked, machine, type World } from './DevicesSwitcher.fixtures';

const SETTINGS_URL = '/api/resources/cloud/machines/settings';
const SIGNED_OUT = 'Sign in to AASC Cloud to list your computers.';
const NEEDS_SIGN_IN = 'This computer signed in before its computers could be listed. Sign out of AASC Cloud and sign in again.';
/** Lite has no RESOURCES tab, so its lines say where to sign in and carry no action. */
const LITE_SIGNED_OUT = 'Sign in to AASC Cloud in the full AASC app to list your computers.';
const LITE_NEEDS_SIGN_IN = 'This computer signed in before its computers could be listed. Sign out of AASC Cloud and sign in again in the full AASC app.';

function device(overrides: Partial<DevicePresence>): DevicePresence {
  return { clientId: 'me', label: 'MacBook Pro', address: '::1', isLocal: true, connections: 1, connectedAt: Date.now(), lastSeenAt: Date.now(), ...overrides };
}

const settings = (publisher: unknown) => ({
  showOnAccount: true,
  addresses: { lan: true, tailnet: true, public: false },
  computerEnroll: 'ask',
  pinned: { showOnAccount: false, computerEnroll: false },
  publisher,
});
const PUBLISHED = { state: 'published', published: { lan: '192.168.1.57', tailnet: null, public: null, port: 3333 } };

export function describeParts(edition: 'Full' | 'Lite'): void {
  let world: World;
  let publisher: unknown;

  beforeEach(() => {
    usePresenceStore.setState({ devices: [device({})], controllers: new Map() });
    publisher = PUBLISHED;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/config') return json(200, { localIP: '192.168.6.42', passwordEnabled: true });
      if (url === '/api/mobile/devices') return json(200, { success: true, data: { devices: [], pairingOffered: true } });
      if (url === '/api/mobile/cloud-phones') return json(200, { success: true, data: { cloud: false } });
      if (url === '/api/sharing-default') return json(200, { shareNewSessions: false });
      if (url === SETTINGS_URL) return json(200, { success: true, data: settings(publisher) });
      return json(404, { error: 'Not found' });
    }));
    world = installWorld();
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [linked()];
  });

  afterEach(() => {
    delete window.electronAPI;
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

  /** The This computer part, once its lazy sections and their first reads have landed. */
  async function thisComputer(panel: HTMLElement): Promise<HTMLElement> {
    fireEvent.click(tab('This computer'));
    const part = within(panel).getByRole('tabpanel');
    await within(part).findByText('No phones or computers paired.');
    await within(part).findByText(/^http:\/\/192\.168\.6\.42/);
    await waitFor(() => expect((within(part).getByRole('switch') as HTMLInputElement).disabled).toBe(false));
    return part;
  }

  describe(`DevicePresenceChip — Switch and This computer (${edition})`, () => {
    it('opens on Switch, with This computer beside it', async () => {
      render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
      const panel = await openPanel();
      // Wider than the panel it replaces (320px): the footer's two actions need 327px to share a row.
      expect(panel.style.width).toBe('360px');
      const tabs = within(panel).getAllByRole('tab');
      expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([['Switch', 'true'], ['This computer', 'false']]);
      const part = within(panel).getByRole('tabpanel');
      expect(await within(part).findByRole('region', { name: 'My computers' })).toBeTruthy();
      expect(within(part).getByText('Not connected yet')).toBeTruthy();
      expect(await within(part).findByRole('region', { name: 'Paired by link' })).toBeTruthy();
      expect(within(part).getByRole('button', { name: '+ Add a computer by link' })).toBeTruthy();
      // Nothing of the other part is mounted: no pairing poll, no settings read.
      expect(within(panel).queryByRole('region', { name: 'Sharing' })).toBeNull();
      expect(within(panel).queryByText('Connected devices')).toBeNull();
      expect(fetched()).not.toContain(SETTINGS_URL);
      expect(fetched()).not.toContain('/api/sharing-default');
    });

    it('This computer holds Sharing, pairing, the Account group and the connected devices, and no remote computers', async () => {
      render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
      const part = await thisComputer(await openPanel());
      expect(tab('This computer').getAttribute('aria-selected')).toBe('true');
      const account = await within(part).findByRole('region', { name: 'Account' });
      expect(within(account).getByRole('checkbox', { name: 'Show this computer to my account' })).toBeTruthy();
      expect(within(account).getByText('Listed at 192.168.1.57 (home network), port 3333.')).toBeTruthy();
      const order = [
        within(part).getByRole('region', { name: 'Sharing' }),
        within(part).getByRole('region', { name: 'Paired phones and computers' }),
        account,
        within(part).getByText('Connected devices'),
      ];
      for (let i = 1; i < order.length; i++) {
        expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      expect(within(part).queryByRole('region', { name: 'Remote computers' })).toBeNull();
      expect(within(part).queryByRole('region', { name: 'My computers' })).toBeNull();
      expect(within(part).queryByText('Old NUC')).toBeNull();
      expect(screen.queryByRole('button', { name: /Add a computer/ })).toBeNull();
    });

    it('This computer is today’s panel with the remote computers taken out and the Account group put in', async () => {
      // Today's panel, as a browser on this computer draws it (no remote computers there).
      const api = window.electronAPI;
      delete window.electronAPI;
      const before = render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
      const old = await openPanel();
      await within(old).findByText('No phones or computers paired.');
      await within(old).findByText(/^http:\/\/192\.168\.6\.42/);
      await waitFor(() => expect((within(old).getByRole('switch') as HTMLInputElement).disabled).toBe(false));
      const today = old.innerHTML;
      before.unmount();

      window.electronAPI = api;
      render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
      const part = await thisComputer(await openPanel());
      await within(part).findByRole('region', { name: 'Account' });
      const copy = part.cloneNode(true) as HTMLElement;
      copy.querySelector('section[aria-label="Account"]')?.remove();
      expect(copy.innerHTML).toBe(today);
    });

    it('draws no Account group on a computer that is not signed in to AASC Cloud', async () => {
      publisher = { state: 'no-cloud', published: null };
      render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
      const part = await thisComputer(await openPanel());
      await waitFor(() => expect(fetched()).toContain(SETTINGS_URL));
      await within(part).findByText('No phones or computers paired.');
      expect(within(part).queryByRole('region', { name: 'Account' })).toBeNull();
      expect(within(part).queryByText('Show this computer to my account')).toBeNull();
    });

    it('opens on Switch again after it was closed on This computer', async () => {
      render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
      await thisComputer(await openPanel());
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: 'Connected devices' })).toBeNull();
      await openPanel();
      expect(tab('Switch').getAttribute('aria-selected')).toBe('true');
    });

    it('a press inside a row’s portaled ⋯ menu keeps the panel open', async () => {
      render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
      const panel = await openPanel();
      fireEvent.click(await within(panel).findByRole('button', { name: 'More for Old NUC' }));
      const item = screen.getByRole('menuitem', { name: 'Rename' });
      fireEvent.mouseDown(item);
      fireEvent.click(item);
      expect(screen.getByRole('dialog', { name: 'Connected devices' })).toBeTruthy();
      expect(screen.getByRole('textbox', { name: 'Computer name' })).toBeTruthy();
    });

    if (edition === 'Full') {
      it('"Manage devices…" goes to RESOURCES → Machines and closes the panel', async () => {
        const router = createMemoryRouter([{ path: '*', element: <DevicePresenceChip /> }], { initialEntries: ['/'] });
        render(<RouterProvider router={router} />);
        const panel = await openPanel();
        fireEvent.click(await within(panel).findByRole('link', { name: 'Manage devices…' }));
        await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe('/resources?section=machines'));
        expect(screen.queryByRole('dialog', { name: 'Connected devices' })).toBeNull();
      });

      it('"Open AASC Cloud" goes to RESOURCES with its account dialog asked for, and closes the panel', async () => {
        world.directory = { state: 'signed-out', machines: [] } satisfies AccountDirectory;
        // A data router, so the test can read where the app went. The chip is the header: it stays on every route.
        const router = createMemoryRouter([{ path: '*', element: <DevicePresenceChip /> }], { initialEntries: ['/'] });
        render(<RouterProvider router={router} />);
        const panel = await openPanel();
        expect(await within(panel).findByText(SIGNED_OUT)).toBeTruthy();
        expect(within(panel).queryByText(LITE_SIGNED_OUT)).toBeNull();
        expect(router.state.location.pathname + router.state.location.search).toBe('/');
        fireEvent.click(within(panel).getByRole('button', { name: 'Open AASC Cloud' }));
        await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe('/resources?account=1'));
        expect(screen.queryByRole('dialog', { name: 'Connected devices' })).toBeNull();
      });
    } else {
      it('has no "Manage devices…": Lite has no RESOURCES tab to manage them in', async () => {
        render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
        const panel = await openPanel();
        await within(panel).findByRole('region', { name: 'My computers' });
        expect(await within(panel).findByRole('button', { name: '+ Add a computer by link' })).toBeTruthy();
        expect(within(panel).queryByText(/Manage devices/)).toBeNull();
      });

      it.each([
        ['signed-out', LITE_SIGNED_OUT, SIGNED_OUT],
        ['needs-sign-in', LITE_NEEDS_SIGN_IN, NEEDS_SIGN_IN],
      ] as const)('%s: says to use the full app, with no action (Lite has no RESOURCES tab to open)', async (state, words, fullWords) => {
        world.directory = { state, machines: [] } satisfies AccountDirectory;
        render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
        const panel = await openPanel();
        expect(await within(panel).findByText(words)).toBeTruthy();
        expect(within(panel).queryByText(fullWords)).toBeNull();
        expect(within(panel).queryByRole('button', { name: 'Open AASC Cloud' })).toBeNull();
        expect(within(panel).queryByRole('button', { name: 'Retry' })).toBeNull();
        expect(await within(panel).findByRole('button', { name: '+ Add a computer by link' })).toBeTruthy();
      });
    }
  });
}

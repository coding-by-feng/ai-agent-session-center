// ThisPhoneScreen.test.tsx — This phone's AASC Cloud row (AASC-51): the Mac's connection as this phone
// sees it, read through the Mac. Resource sync left the phone in Nov 2026, so the row opens
// Resources → Projects. Nothing here offers to connect, upload or install.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/deviceIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/deviceIdentity')>()),
  getClientId: () => 'phone',
}));

import ThisPhoneScreen from './ThisPhoneScreen';
import { usePhoneNavStore, defaultStacks } from '@/stores/phoneNavStore';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const STATUS = { connected: true, state: 'connected', lastSyncAt: ago(120_000), problem: null };

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let routes: Record<string, () => Response | Promise<Response>>;

beforeEach(() => {
  routes = { '/api/phone-cloud/status': () => reply(STATUS) };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (routes[url] ? routes[url]() : reply({ error: 'Not found' }, 404))));
  usePhoneNavStore.setState({ tab: 'more', stacks: defaultStacks() });
});

afterEach(() => vi.unstubAllGlobals());

describe('This phone → AASC Cloud', () => {
  it('shows connected or not and the last sync, and opens Resources → Projects', async () => {
    const user = userEvent.setup();
    render(<ThisPhoneScreen />);
    const row = screen.getByTestId('this-phone-cloud');
    expect(row.textContent).toContain('Checking…');
    await waitFor(() => expect(row.textContent).toContain('Connected'));
    expect(row.textContent).toContain('Last synced 2 min ago');
    await user.click(within(row).getByRole('button'));
    expect(usePhoneNavStore.getState().stacks.more.at(-1)).toBe('/more/resources/projects');
  });

  it('says a sync problem in plain words, and an older Mac plainly too', async () => {
    routes['/api/phone-cloud/status'] = () => reply({ connected: true, state: 'offline', lastSyncAt: null, problem: 'Your Mac can’t reach AASC Cloud right now. Check its internet connection, then try again.' });
    const { unmount } = render(<ThisPhoneScreen />);
    const row = screen.getByTestId('this-phone-cloud');
    await waitFor(() => expect(row.textContent).toContain('Offline'));
    expect(row.textContent).toContain('Your Mac can’t reach AASC Cloud right now.');
    expect(row.textContent).not.toContain('Check its internet connection');
    unmount();
    delete routes['/api/phone-cloud/status'];
    render(<ThisPhoneScreen />);
    const older = screen.getByTestId('this-phone-cloud');
    await waitFor(() => expect(older.textContent).toContain('Update AASC on your Mac to see it'));
  });
});

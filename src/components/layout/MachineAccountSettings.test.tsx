// MachineAccountSettings.test.tsx — the "Account" group of the devices panel's This computer part (plan 18 stage 2).
// How its saves queue up is in MachineAccountSettings.saves.test.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import MachineAccountSettings from './MachineAccountSettings';
import {
  AUTO, PINNED, PUBLISHED, SHOW, answer, box, installServer, json, settings, type FakeServer, type Publisher, type Settings,
} from './MachineAccountSettings.fixtures';

let server: FakeServer;

beforeEach(() => {
  server = installServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function shown(): Promise<HTMLElement> {
  render(<MachineAccountSettings />);
  return screen.findByRole('region', { name: 'Account' });
}

describe('MachineAccountSettings — when it shows', () => {
  it('shows the three settings as this computer has them', async () => {
    server.onGet = () => answer(settings({ addresses: { lan: true, tailnet: false, public: true }, computerEnroll: 'auto' }));
    const group = await shown();
    expect(group.textContent).toContain('Account');
    expect(box(SHOW).checked).toBe(true);
    expect(box('Home network').checked).toBe(true);
    expect(box('Tailscale').checked).toBe(false);
    expect(box('Public IP, unencrypted').checked).toBe(true);
    expect(box(AUTO).checked).toBe(true);
    expect(server.calls).toEqual([{ method: 'GET', body: undefined, contentType: null }]);
  });

  it('reads "ask" as an empty box', async () => {
    await shown();
    expect(box(AUTO).checked).toBe(false);
  });

  it('is not rendered on a computer that is not signed in to AASC Cloud', async () => {
    server.onGet = () => answer(settings({ publisher: { state: 'no-cloud', published: null } }));
    const { container } = render(<MachineAccountSettings />);
    await waitFor(() => expect(server.calls).toHaveLength(1));
    await act(async () => {});
    expect(container.textContent).toBe('');
  });

  it.each([
    ['a plain 404 (a server without the route)', () => new Response('Not found', { status: 404 })],
    ['a JSON 404', () => json(404, { success: false, error: { code: 'not_found', message: 'Not found' } })],
  ])('is not rendered when the read answers %s', async (_label, respond) => {
    server.onGet = respond;
    const { container } = render(<MachineAccountSettings />);
    await waitFor(() => expect(server.calls).toHaveLength(1));
    await act(async () => {});
    expect(container.textContent).toBe('');
  });

  it('says this computer’s server could not be reached when the read never gets an answer', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await shown();
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t reach this computer’s AASC server. Try again.');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('says why when the read fails some other way, with no boxes to tick', async () => {
    server.onGet = () => json(403, { success: false, error: { code: 'forbidden', message: 'Same-origin request required' } });
    await shown();
    expect(screen.getByRole('alert').textContent).toBe('Same-origin request required');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('MachineAccountSettings — a change', () => {
  it('sends the whole choice with the one change, as JSON, and shows what the server answers', async () => {
    server.onPut = (body) => answer(settings({ ...(body as Partial<Settings>), publisher: { state: 'off', published: null } }));
    await shown();
    expect(screen.getByText(/^Listed at /)).toBeTruthy();
    fireEvent.click(box(SHOW));
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    expect(server.puts()[0]).toEqual({
      method: 'PUT',
      contentType: 'application/json',
      body: { showOnAccount: false, addresses: { lan: true, tailnet: true, public: false }, computerEnroll: 'ask' },
    });
    await waitFor(() => expect(box(SHOW).getAttribute('aria-busy')).toBe('false'));
    expect(box(SHOW).checked).toBe(false);
    // The answer's publisher, not the one from before the save.
    expect(screen.queryByText(/^Listed at /)).toBeNull();
  });

  it('changes one address and leaves the rest of the choice as it was', async () => {
    await shown();
    fireEvent.click(box('Public IP, unencrypted'));
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    expect(server.puts()[0].body).toEqual({ showOnAccount: true, addresses: { lan: true, tailnet: true, public: true }, computerEnroll: 'ask' });
    await waitFor(() => expect(box('Public IP, unencrypted').getAttribute('aria-busy')).toBe('false'));
    expect(box('Public IP, unencrypted').checked).toBe(true);
  });

  it('ticked means the account’s computers connect without asking; unticked asks again', async () => {
    await shown();
    fireEvent.click(box(AUTO));
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    expect(server.puts()[0].body).toEqual({ showOnAccount: true, addresses: { lan: true, tailnet: true, public: false }, computerEnroll: 'auto' });
    await waitFor(() => expect(box(AUTO).getAttribute('aria-busy')).toBe('false'));
    expect(box(AUTO).checked).toBe(true);
    fireEvent.click(box(AUTO));
    await waitFor(() => expect(server.puts()).toHaveLength(2));
    expect((server.puts()[1].body as Settings).computerEnroll).toBe('ask');
  });

  it('shows the server’s values even where they differ from what was sent', async () => {
    server.onPut = () => answer(settings({ showOnAccount: true, addresses: { lan: true, tailnet: false, public: false } }));
    await shown();
    fireEvent.click(box('Public IP, unencrypted'));
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    await waitFor(() => expect(box('Tailscale').checked).toBe(false));
    expect(box('Public IP, unencrypted').checked).toBe(false);
  });

  it.each([
    ['its message', { success: false, error: { code: 'save_failed', message: 'Couldn’t save the settings. Check server-config.json.' } }, 'Couldn’t save the settings. Check server-config.json.'],
    ['a bare string', { success: false, error: 'Nope' }, 'Nope'],
  ])('puts the box back and shows the error when the save fails with %s', async (_label, body, words) => {
    let finish: (r: Response) => void = () => {};
    server.onPut = () => new Promise<Response>((r) => { finish = r; });
    await shown();
    fireEvent.click(box(AUTO));
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    // Shown at once, held while the save is out.
    expect(box(AUTO).checked).toBe(true);
    expect(box(AUTO).getAttribute('aria-busy')).toBe('true');
    await act(async () => finish(json(500, body)));
    expect(box(AUTO).checked).toBe(false);
    expect(screen.getByRole('alert').textContent).toBe(words);
    expect(screen.getByText(/^Listed at /)).toBeTruthy();
  });

  it('clears the error on the next change', async () => {
    server.onPut = () => json(409, { success: false, error: { code: 'set_by_environment', message: 'AASC_SHOW_ON_ACCOUNT is set in this computer’s environment, so it decides this setting.' } });
    await shown();
    fireEvent.click(box(SHOW));
    expect((await screen.findByRole('alert')).textContent).toContain('AASC_SHOW_ON_ACCOUNT is set');
    expect(box(SHOW).checked).toBe(true);

    server.onPut = () => new Promise<Response>(() => {});
    fireEvent.click(box(AUTO));
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(server.puts()).toHaveLength(2));
  });

  it('says this computer’s server could not be reached when a save never gets an answer', async () => {
    await shown();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    fireEvent.click(box(AUTO));
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t reach this computer’s AASC server. Try again.');
    expect(box(AUTO).checked).toBe(false);
  });

  it('holds the three address boxes while "Show this computer" is off', async () => {
    server.onGet = () => answer(settings({ showOnAccount: false, publisher: { state: 'off', published: null } }));
    await shown();
    for (const name of ['Home network', 'Tailscale', 'Public IP, unencrypted']) expect(box(name).disabled).toBe(true);
    expect(box(SHOW).disabled).toBe(false);
    expect(box(AUTO).disabled).toBe(false);
    fireEvent.click(box(SHOW));
    await waitFor(() => expect(box('Home network').disabled).toBe(false));
  });
});

describe('MachineAccountSettings — a setting the environment decides', () => {
  it('holds "Show this computer" and says why, leaving the rest to change', async () => {
    server.onGet = () => answer(settings({ pinned: { showOnAccount: true, computerEnroll: false } }));
    await shown();
    expect(box(SHOW).disabled).toBe(true);
    expect(box(SHOW)).toHaveAccessibleDescription(PINNED);
    expect(screen.getAllByText(PINNED)).toHaveLength(1);
    expect(box(AUTO).disabled).toBe(false);
    expect(box('Home network').disabled).toBe(false);
    // A change to another setting sends the pinned one back as the server reported it.
    fireEvent.click(box('Tailscale'));
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    expect(server.puts()[0].body).toEqual({ showOnAccount: true, addresses: { lan: true, tailnet: false, public: false }, computerEnroll: 'ask' });
  });

  it('holds "Connect without asking" and says why', async () => {
    server.onGet = () => answer(settings({ computerEnroll: 'auto', pinned: { showOnAccount: false, computerEnroll: true } }));
    await shown();
    expect(box(AUTO).disabled).toBe(true);
    expect(box(AUTO).checked).toBe(true);
    expect(box(AUTO)).toHaveAccessibleDescription(PINNED);
    expect(box(SHOW).disabled).toBe(false);
    expect(box(SHOW)).not.toHaveAccessibleDescription(PINNED);
  });

  it('says it for both when both are pinned', async () => {
    server.onGet = () => answer(settings({ pinned: { showOnAccount: true, computerEnroll: true } }));
    await shown();
    expect(screen.getAllByText(PINNED)).toHaveLength(2);
  });
});

describe('MachineAccountSettings — the status line', () => {
  const published = (lan: string | null, tailnet: string | null, pub: string | null): Publisher =>
    ({ state: 'published', published: { lan, tailnet, public: pub, port: 3333 } });

  it.each<[string, Publisher, string | null]>([
    ['published at two addresses', PUBLISHED, 'Listed at 192.168.1.57 (home network) and 100.101.102.103 (Tailscale), port 3333.'],
    ['published at one', published('192.168.1.57', null, null), 'Listed at 192.168.1.57 (home network), port 3333.'],
    ['published on Tailscale alone', published(null, '100.101.102.103', null), 'Listed at 100.101.102.103 (Tailscale), port 3333.'],
    ['published at all three', published('192.168.1.57', '100.101.102.103', '45.63.31.79'), 'Listed at 192.168.1.57 (home network), 100.101.102.103 (Tailscale) and 45.63.31.79 (public IP, unencrypted), port 3333.'],
    ['pending', { state: 'pending', published: null }, 'Checking…'],
    ['off', { state: 'off', published: null }, null],
    ['pairing-off', { state: 'pairing-off', published: null }, 'Not listed: device pairing is off on this computer.'],
    ['no-password', { state: 'no-password', published: null }, 'Not listed: set a dashboard password first.'],
    ['no-address', { state: 'no-address', published: null }, 'Not listed: none of the ticked addresses is available right now.'],
    ['needs-sign-in', { state: 'needs-sign-in', published: null }, 'Not listed: sign out of AASC Cloud and sign in again.'],
    ['unsupported', { state: 'unsupported', published: null }, 'Not listed: AASC Cloud doesn’t support this yet.'],
    ['failed', { state: 'failed', published: null }, 'Couldn’t update AASC Cloud. It will try again.'],
    ['a state a later server adds', { state: 'paused', published: null }, null],
  ])('%s', async (_label, publisher, words) => {
    server.onGet = () => answer(settings({ publisher }));
    const group = await shown();
    const line = group.querySelector('[data-status-line]');
    expect(line?.textContent ?? null).toBe(words);
    expect(box(SHOW)).toBeTruthy();
  });

  it('reads again every 3 s while the publisher is still checking, then stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server.onGet = () => answer(settings({ publisher: { state: 'pending', published: null } }));
    await shown();
    expect(screen.getByText('Checking…')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(server.calls).toHaveLength(2);
    server.onGet = () => answer(settings());
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(server.calls).toHaveLength(3);
    expect(screen.getByText(/^Listed at /)).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(server.calls).toHaveLength(3);
  });

  it('stops reading when the panel closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server.onGet = () => answer(settings({ publisher: { state: 'pending', published: null } }));
    render(<MachineAccountSettings />).unmount();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(server.calls).toHaveLength(1);
  });
});

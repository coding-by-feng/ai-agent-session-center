// MachineAccountSettings.saves.test.tsx — how the Account group's saves queue up (code review, Nov 20 2026): one
// at a time, each on top of what the one before it answered, and still sent after the group has gone away.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import MachineAccountSettings from './MachineAccountSettings';
import {
  AUTO, answer, box, installServer, json, settings, type FakeServer, type Settings,
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

describe('MachineAccountSettings — saves, one at a time', () => {
  // Two quick ticks used to race: the second was built from the values before the first save, so whichever
  // answer landed last undid the other.
  it('saves two quick changes one after the other, the second built from what the first one answered', async () => {
    const out: Array<(r: Response) => void> = [];
    server.onPut = () => new Promise<Response>((r) => { out.push(r); });
    await shown();
    fireEvent.click(box(AUTO));
    fireEvent.click(box('Tailscale'));
    // Both show at once; one save is out, the other waits for its answer.
    expect(box(AUTO).checked).toBe(true);
    expect(box('Tailscale').checked).toBe(false);
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    expect(server.puts()[0].body).toEqual({ showOnAccount: true, addresses: { lan: true, tailnet: true, public: false }, computerEnroll: 'auto' });
    await act(async () => {});
    expect(server.puts()).toHaveLength(1);

    // The first answer differs from the page in a box nobody touched (another window changed it meanwhile).
    await act(async () => out[0](answer(settings({ computerEnroll: 'auto', addresses: { lan: false, tailnet: true, public: false } }))));
    await waitFor(() => expect(server.puts()).toHaveLength(2));
    expect(server.puts()[1].body).toEqual({ showOnAccount: true, addresses: { lan: false, tailnet: false, public: false }, computerEnroll: 'auto' });
    // Still held, and the change that waits still shows.
    expect(box('Tailscale').checked).toBe(false);
    expect(box('Tailscale').getAttribute('aria-busy')).toBe('true');

    await act(async () => out[1](answer(settings({ computerEnroll: 'auto', addresses: { lan: false, tailnet: false, public: false } }))));
    expect(server.puts()).toHaveLength(2);
    expect(box(AUTO).checked).toBe(true);
    expect(box('Tailscale').checked).toBe(false);
    expect(box('Home network').checked).toBe(false);
    expect(box(AUTO).getAttribute('aria-busy')).toBe('false');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ticking one box off and on again quickly ends as the last tick, with both saves sent in order', async () => {
    const out: Array<(r: Response) => void> = [];
    server.onPut = (body) => new Promise<Response>((r) => { out.push(() => r(answer(settings({ ...(body as Partial<Settings>) })))); });
    await shown();
    fireEvent.click(box('Tailscale'));
    fireEvent.click(box('Tailscale'));
    expect(box('Tailscale').checked).toBe(true);
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    await act(async () => out[0](new Response()));
    await waitFor(() => expect(server.puts()).toHaveLength(2));
    await act(async () => out[1](new Response()));
    expect(server.puts().map((p) => (p.body as Settings).addresses.tailnet)).toEqual([false, true]);
    expect(box('Tailscale').checked).toBe(true);
  });

  it('when a save fails, a change that was waiting is not sent: every box goes back to what is saved', async () => {
    let finish: (r: Response) => void = () => {};
    server.onPut = () => new Promise<Response>((r) => { finish = r; });
    await shown();
    fireEvent.click(box(AUTO));
    fireEvent.click(box('Tailscale'));
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    await act(async () => finish(json(500, { success: false, error: { code: 'save_failed', message: 'Couldn’t save the settings. Check server-config.json.' } })));
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t save the settings. Check server-config.json.');
    expect(box(AUTO).checked).toBe(false);
    expect(box('Tailscale').checked).toBe(true);
    expect(box(AUTO).getAttribute('aria-busy')).toBe('false');
    await act(async () => {});
    expect(server.puts()).toHaveLength(1);
  });

  // The Switch tab unmounts this group: a second quick tick used to be dropped silently when the first save landed.
  it('saves the ticks still waiting when the group goes away, in order, and touches no state after that', async () => {
    const complain = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out: Array<(r: Response) => void> = [];
    server.onPut = () => new Promise<Response>((r) => { out.push(r); });
    const { unmount } = render(<MachineAccountSettings />);
    await screen.findByRole('region', { name: 'Account' });
    fireEvent.click(box(AUTO));
    fireEvent.click(box('Tailscale'));
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    unmount();
    await act(async () => out[0](answer(settings({ computerEnroll: 'auto' }))));
    await waitFor(() => expect(server.puts()).toHaveLength(2));
    expect(server.puts().map((p) => p.body)).toEqual([
      { showOnAccount: true, addresses: { lan: true, tailnet: true, public: false }, computerEnroll: 'auto' },
      { showOnAccount: true, addresses: { lan: true, tailnet: false, public: false }, computerEnroll: 'auto' },
    ]);
    await act(async () => out[1](answer(settings({ computerEnroll: 'auto', addresses: { lan: true, tailnet: false, public: false } }))));
    await act(async () => {});
    expect(server.puts()).toHaveLength(2);
    expect(complain).not.toHaveBeenCalled();
    complain.mockRestore();
  });

  // Closing the panel and opening it again within a save's few seconds: a fresh read would show the settings
  // from before the ticks still on their way, and the next tick would then undo them.
  it('a group mounted again while saves are still going out shows them, reads nothing, and builds on their answers', async () => {
    const out: Array<(r: Response) => void> = [];
    server.onPut = () => new Promise<Response>((r) => { out.push(r); });
    const first = render(<MachineAccountSettings />);
    await screen.findByRole('region', { name: 'Account' });
    fireEvent.click(box(AUTO));
    fireEvent.click(box('Tailscale'));
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    first.unmount();

    render(<MachineAccountSettings />);
    // At once, with both ticks, and still held.
    expect(box(AUTO).checked).toBe(true);
    expect(box('Tailscale').checked).toBe(false);
    expect(box(AUTO).getAttribute('aria-busy')).toBe('true');
    expect(server.calls.filter((c) => c.method === 'GET')).toHaveLength(1);

    fireEvent.click(box('Public IP, unencrypted'));
    await act(async () => out[0](answer(settings({ computerEnroll: 'auto' }))));
    await waitFor(() => expect(server.puts()).toHaveLength(2));
    await act(async () => out[1](answer(settings({ computerEnroll: 'auto', addresses: { lan: true, tailnet: false, public: false } }))));
    await waitFor(() => expect(server.puts()).toHaveLength(3));
    expect(server.puts()[2].body).toEqual({ showOnAccount: true, addresses: { lan: true, tailnet: false, public: true }, computerEnroll: 'auto' });
    await act(async () => out[2](answer(settings({ computerEnroll: 'auto', addresses: { lan: true, tailnet: false, public: true } }))));
    expect(box(AUTO).checked).toBe(true);
    expect(box('Tailscale').checked).toBe(false);
    expect(box('Public IP, unencrypted').checked).toBe(true);
    expect(box(AUTO).getAttribute('aria-busy')).toBe('false');
    expect(server.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('after the group goes away, a save that fails still drops the ticks behind it', async () => {
    const out: Array<(r: Response) => void> = [];
    server.onPut = () => new Promise<Response>((r) => { out.push(r); });
    const { unmount } = render(<MachineAccountSettings />);
    await screen.findByRole('region', { name: 'Account' });
    fireEvent.click(box(AUTO));
    fireEvent.click(box('Tailscale'));
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    unmount();
    await act(async () => out[0](json(500, { success: false, error: { code: 'save_failed', message: 'Couldn’t save the settings. Check server-config.json.' } })));
    await act(async () => {});
    expect(server.puts()).toHaveLength(1);
  });
});

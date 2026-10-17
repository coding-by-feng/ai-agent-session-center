// "Share new sessions with my devices" in the Mac's devices panel (Oct 2026, by request).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
import { showToast } from '@/components/ui/ToastContainer';
import SharingDefault from './SharingDefault';

let calls: Array<{ url: string; method: string; body?: unknown }> = [];
let serverOn = false;

beforeEach(() => {
  calls = [];
  serverOn = false;
  vi.mocked(showToast).mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === '/api/sharing-default' && method === 'PUT') serverOn = (body as { shareNewSessions: boolean }).shareNewSessions;
    if (url === '/api/sessions/share-all') return new Response(JSON.stringify({ ok: true, shared: 3 }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, shareNewSessions: serverOn }), { status: 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('SharingDefault', () => {
  it('shows the Mac\'s setting, off at first, and says what it does', async () => {
    render(<SharingDefault />);
    const sw = await screen.findByRole('switch', { name: 'Share new sessions with my devices' });
    await waitFor(() => expect(sw).not.toBeChecked());
    expect(screen.getByText(/📡 on a session still hides it/)).toBeInTheDocument();
  });

  it('turns it on through the Mac and says so', async () => {
    render(<SharingDefault />);
    const sw = await screen.findByRole('switch', { name: 'Share new sessions with my devices' });
    await waitFor(() => expect(sw).not.toBeDisabled());
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toBeChecked());
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ shareNewSessions: true });
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/New sessions will be shared/), 'success');
  });

  it('shares every open session now, saying how many', async () => {
    render(<SharingDefault />);
    fireEvent.click(await screen.findByRole('button', { name: 'Share all open sessions now' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Shared 3 open sessions with your devices', 'success'));
    expect(calls.some((c) => c.url === '/api/sessions/share-all' && c.method === 'POST')).toBe(true);
  });
});

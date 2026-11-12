import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CliLoginBanner from './CliLoginBanner';
import { usePhoneNavStore } from '@/stores/phoneNavStore';

afterEach(() => { vi.unstubAllGlobals(); });

describe('CliLoginBanner', () => {
  it('opens the login terminal on the phone, on its Terminal (a shell has no Chat)', async () => {
    const openTerminal = vi.spyOn(usePhoneNavStore.getState(), 'openTerminal');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('/login')
      ? new Response(JSON.stringify({ success: true, data: { cli: 'codex', terminalId: 'term-7' } }), { status: 201 })
      : new Response(JSON.stringify({ success: true, data: { host: 'mbp', clis: [{ cli: 'codex', state: 'logged-out', method: null, detail: null, checkedAt: 1 }] } }), { status: 200 })));
    render(<CliLoginBanner />);
    expect(await screen.findByText("Codex isn't logged in on mbp")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(openTerminal).toHaveBeenCalledWith('term-7', false));
  });
});

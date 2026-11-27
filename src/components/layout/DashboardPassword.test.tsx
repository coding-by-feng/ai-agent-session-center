// DashboardPassword.test.tsx — the devices panel sets or changes the dashboard password (Nov 27 2026).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import DashboardPassword from './DashboardPassword';
import { AUTH_SESSION_EVENT } from '@/hooks/useAuth';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

type Route = (init?: RequestInit) => { status: number; body: unknown };

function serve(passwordRequired: boolean | 'fail', post?: Route) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === '/api/auth/status') {
      if (passwordRequired === 'fail') throw new Error('down');
      return new Response(JSON.stringify({ passwordRequired, authenticated: true }), { status: 200 });
    }
    const answer = post?.(init) ?? { status: 200, body: { success: true, passwordEnabled: true, expiresIn: 3600 } };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }));
  return calls;
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DashboardPassword', () => {
  it('says when none is set, and sets one that signs this window in', async () => {
    const calls = serve(false);
    const started = vi.fn();
    document.addEventListener(AUTH_SESSION_EVENT, started);
    render(<DashboardPassword />);
    const section = await screen.findByRole('region', { name: 'Dashboard password' });
    expect(within(section).queryByText('On')).toBeNull();
    expect(within(section).getByText(/can’t connect until you set one/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Set password…' }));
    expect(screen.queryByLabelText('Current password')).toBeNull();
    type('New password', 'Tr1cky-pass');
    type('Confirm new password', 'Tr1cky-pass');
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));

    expect(await within(section).findByText('On')).toBeTruthy();
    const sent = calls.find((c) => c.url === '/api/auth/password');
    expect(JSON.parse(String(sent?.init?.body))).toEqual({ password: 'Tr1cky-pass' });
    expect(started).toHaveBeenCalledTimes(1);
    expect((started.mock.calls[0][0] as CustomEvent).detail).toEqual({ expiresIn: 3600 });
    expect(screen.getByRole('button', { name: 'Change password…' })).toBeTruthy();
    document.removeEventListener(AUTH_SESSION_EVENT, started);
  });

  it('catches two passwords that differ before asking the server', async () => {
    const calls = serve(false);
    render(<DashboardPassword />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set password…' }));
    type('New password', 'Tr1cky-pass');
    type('Confirm new password', 'Tr1cky-pas');
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/don’t match/);
    expect(calls.some((c) => c.url === '/api/auth/password')).toBe(false);
  });

  it('asks for the current password to change it, and shows the server’s refusal', async () => {
    const calls = serve(true, () => ({ status: 401, body: { success: false, error: 'The current password is wrong.', attemptsLeft: 4 } }));
    render(<DashboardPassword />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change password…' }));
    type('Current password', 'wrong');
    type('New password', 'N3w-and-better');
    type('Confirm new password', 'N3w-and-better');
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The current password is wrong.');
    const sent = calls.find((c) => c.url === '/api/auth/password');
    expect(JSON.parse(String(sent?.init?.body))).toEqual({ current: 'wrong', password: 'N3w-and-better' });
    expect(screen.getByText('On')).toBeTruthy();
  });

  it('shows nothing when the server can’t say', async () => {
    serve('fail');
    const { container } = render(<DashboardPassword />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
  });
});

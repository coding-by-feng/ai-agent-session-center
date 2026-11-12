import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CliLoginStrip from './CliLoginStrip';
import { useSessionStore } from '@/stores/sessionStore';
import { loginNeededTitle } from '@/lib/cliAuthClient';
import type { CliAuthReport } from '@/types/cliAuth';

const report = (states: Record<string, string>): CliAuthReport => ({
  host: 'Kasons-MacBook-Pro-2019',
  clis: Object.entries(states).map(([cli, state]) => ({ cli, state, method: null, detail: null, checkedAt: 1 })) as CliAuthReport['clis'],
});

function serve(r: CliAuthReport, login: { status: number; body: unknown } = { status: 201, body: { success: true, data: { cli: 'claude', terminalId: 'term-9' } } }) {
  const calls: Array<[string, string]> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([init?.method ?? 'GET', String(url)]);
    if (String(url).includes('/login')) return new Response(JSON.stringify(login.body), { status: login.status });
    return new Response(JSON.stringify({ success: true, data: r }), { status: 200 });
  }));
  return calls;
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('CliLoginStrip', () => {
  it('shows nothing when every enabled CLI is logged in or unclear', async () => {
    const calls = serve(report({ claude: 'logged-in', codex: 'unknown' }));
    const { container } = render(<CliLoginStrip />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(container).toBeEmptyDOMElement();
  });

  it('names the CLI and the host, and Log in opens the login terminal', async () => {
    const select = vi.spyOn(useSessionStore.getState(), 'selectSession');
    const calls = serve(report({ claude: 'logged-out', codex: 'logged-in' }));
    render(<CliLoginStrip />);
    expect(await screen.findByText("Claude Code isn't logged in on Kasons-MacBook-Pro-2019")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(calls).toContainEqual(['POST', '/api/cli-auth/claude/login']));
    await waitFor(() => expect(select).toHaveBeenCalledWith('term-9'));
  });

  it('gives each logged-out CLI its own button', async () => {
    serve(report({ claude: 'logged-out', codex: 'logged-out' }));
    render(<CliLoginStrip />);
    expect(await screen.findByRole('button', { name: 'Log in to Claude Code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in to Codex' })).toBeInTheDocument();
  });

  it('shows the server\'s refusal in place of the hint', async () => {
    serve(report({ claude: 'logged-out' }), { status: 429, body: { success: false, error: 'A login terminal was opened from this device a moment ago. Use that one.' } });
    render(<CliLoginStrip />);
    await userEvent.click(await screen.findByRole('button', { name: 'Log in' }));
    expect(await screen.findByText(/a moment ago/)).toBeInTheDocument();
  });
});

describe('loginNeededTitle', () => {
  it('joins two CLIs', () => {
    const r = report({ claude: 'logged-out', codex: 'logged-out' });
    expect(loginNeededTitle(r.clis, 'mbp')).toBe("Claude Code and Codex aren't logged in on mbp");
  });
});

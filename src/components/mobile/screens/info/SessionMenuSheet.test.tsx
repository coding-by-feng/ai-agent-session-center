// SessionMenuSheet.test.tsx — the session screen's ⋯ (AASC-46): restart or
// resume, fork, mute, Info and kill; restart and kill confirm first. The
// request helpers are mocked: nothing here reaches a real process.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/types';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/sessionActions', () => ({
  requestSessionKill: vi.fn(async () => ({ ok: true, message: 'PID 1 terminated' })),
  requestSessionResume: vi.fn(async () => ({ ok: true, message: 'Resuming' })),
}));
vi.mock('@/lib/restartSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restartSession')>()),
  requestSessionRestart: vi.fn(async () => ({ ok: true, terminalId: 'term-2' })),
}));
vi.mock('@/lib/sessionCopy', () => ({ copySession: vi.fn(async () => 'term-copy') }));
vi.mock('@/lib/alarmEngine', () => ({ muteSession: vi.fn(), unmuteSession: vi.fn(), alertSession: vi.fn(), unalertSession: vi.fn() }));

import SessionMenuSheet from './SessionMenuSheet';
import SessionSheets from './SessionSheets';
import { useSessionStore } from '@/stores/sessionStore';
import { usePhoneNavStore, defaultStacks } from '@/stores/phoneNavStore';
import { requestSessionKill, requestSessionResume } from '@/lib/sessionActions';
import { requestSessionRestart } from '@/lib/restartSession';
import { copySession } from '@/lib/sessionCopy';

const make = (over: Partial<Session> = {}) => ({
  sessionId: 's1', title: 'web', projectName: 'web', status: 'idle', source: 'ssh', terminalId: 'term-1', cliSource: 'claude',
  startedAt: 0, lastActivityAt: 0, events: [], promptHistory: [], toolLog: [], responseLog: [], ...over,
}) as unknown as Session;

function setup(over: Partial<Session> = {}) {
  useSessionStore.setState({ sessions: new Map([['s1', make(over)]]) });
  const onClose = vi.fn();
  render(<SessionMenuSheet sessionId="s1" onClose={onClose} />);
  return { onClose, sheet: screen.getByRole('dialog', { name: 'web' }) };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  usePhoneNavStore.setState({ tab: 'sessions', stacks: { ...defaultStacks(), sessions: ['/sessions', '/sessions/s1/chat'] } });
  for (const fn of [requestSessionKill, requestSessionResume, requestSessionRestart, copySession]) vi.mocked(fn).mockClear();
});

describe('SessionMenuSheet', () => {
  it('offers the four actions and Info, and no Pin', () => {
    const { sheet } = setup();
    const rows = within(sheet).getAllByRole('button').map((b) => b.textContent ?? '');
    for (const label of ['Restart', 'Fork', 'Mute', 'Info', 'Kill session']) expect(rows.some((t) => t.startsWith(label))).toBe(true);
    expect(rows.some((t) => /Pin/.test(t))).toBe(false);
  });

  it('offers Terminal when the screen gives it a way there (AASC-56), and closes first', async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ sessions: new Map([['s1', make()]]) });
    const onClose = vi.fn();
    const onTerminal = vi.fn();
    render(<SessionMenuSheet sessionId="s1" onClose={onClose} onTerminal={onTerminal} />);
    const sheet = screen.getByRole('dialog', { name: 'web' });
    await user.click(within(sheet).getByRole('button', { name: /^Terminal/ }));
    expect(onClose).toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it('offers no Terminal without one (on the terminal itself)', () => {
    const { sheet } = setup();
    expect(within(sheet).queryByRole('button', { name: /^Terminal/ })).toBeNull();
  });

  // Oct 21 2026: the chat's search bar opens from here, not by scrolling up.
  it('offers Search this chat, second, when the screen gives it a way there, and closes first', async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ sessions: new Map([['s1', make()]]) });
    const onClose = vi.fn();
    const onSearch = vi.fn();
    render(<SessionMenuSheet sessionId="s1" onClose={onClose} onTerminal={() => {}} onSearch={onSearch} />);
    const sheet = screen.getByRole('dialog', { name: 'web' });
    const rows = within(sheet).getAllByRole('button').map((b) => b.textContent ?? '').filter((t) => t.trim() !== '');
    expect(rows[0]).toMatch(/^Terminal/);
    expect(rows[1]).toMatch(/^Search this chat/);
    await user.click(within(sheet).getByRole('button', { name: /^Search this chat/ }));
    expect(onClose).toHaveBeenCalled();
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('offers no Search without a chat to search (a shell)', () => {
    const { sheet } = setup();
    expect(within(sheet).queryByRole('button', { name: /^Search this chat/ })).toBeNull();
  });

  it('the Sessions list’s actions sheet offers Terminal too', async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ sessions: new Map([['s1', make()]]) });
    const onOpenTerminal = vi.fn();
    const onSheet = vi.fn();
    render(<SessionSheets sessionId="s1" sheet="actions" onSheet={onSheet} onOpenTerminal={onOpenTerminal} />);
    await user.click(within(screen.getByTestId('session-actions-sheet')).getByRole('button', { name: /^Terminal/ }));
    expect(onSheet).toHaveBeenCalledWith(null);
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
  });

  it('restarts only after a confirm', async () => {
    const user = userEvent.setup();
    const { sheet, onClose } = setup();
    await user.click(within(sheet).getByRole('button', { name: /^Restart/ }));
    expect(requestSessionRestart).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole('dialog', { name: 'Restart this session?' })).getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(requestSessionRestart).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('kills only after a confirm', async () => {
    const user = userEvent.setup();
    const { sheet } = setup();
    await user.click(within(sheet).getByRole('button', { name: 'Kill session' }));
    expect(requestSessionKill).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole('dialog', { name: 'Kill this session?' })).getByRole('button', { name: 'Kill session' }));
    await waitFor(() => expect(requestSessionKill).toHaveBeenCalledWith('s1', 'term-1'));
  });

  it('resumes an ended session instead of restarting it', async () => {
    const user = userEvent.setup();
    const { sheet } = setup({ status: 'ended' });
    expect(within(sheet).queryByRole('button', { name: /^Restart/ })).toBeNull();
    await user.click(within(sheet).getByRole('button', { name: /^Resume/ }));
    await waitFor(() => expect(requestSessionResume).toHaveBeenCalledWith('s1'));
  });

  it('forks in one tap', async () => {
    const user = userEvent.setup();
    const { sheet } = setup();
    await user.click(within(sheet).getByRole('button', { name: /^Fork/ }));
    await waitFor(() => expect(copySession).toHaveBeenCalledWith('s1', 'fork'));
  });

  it('mutes the session', async () => {
    const user = userEvent.setup();
    const { sheet } = setup();
    await user.click(within(sheet).getByRole('button', { name: /^Mute/ }));
    expect(useSessionStore.getState().sessions.get('s1')?.muted).toBe(true);
  });

  it('opens Info', async () => {
    const user = userEvent.setup();
    const { sheet } = setup();
    await user.click(within(sheet).getByRole('button', { name: /^Info/ }));
    expect(usePhoneNavStore.getState().stacks.sessions.at(-1)).toBe('/sessions/s1/info');
  });
});

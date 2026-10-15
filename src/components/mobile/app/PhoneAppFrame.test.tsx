// PhoneAppFrame.test.tsx — the new phone app's frame (AASC-38/39), on the real
// browser history (jsdom): tabs and their stacks, the Inbox badge, back through
// history, the tab bar hiding on a session, old ?session= links, the selection
// bridge for today's views, "N more need you ›", and the body-scoped tokens.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/types';

vi.mock('@/components/terminal/TerminalContainer', () => ({
  default: ({ terminalId }: { terminalId: string | null }) => <div data-testid="terminal-container">{terminalId}</div>,
}));
vi.mock('@/routes/QueueView', () => ({ default: () => <div data-testid="queue-view" /> }));
vi.mock('@/components/modals/NewSessionModal', () => ({ default: () => null }));
vi.mock('@/components/modals/GlobalSearchModal', () => ({ default: () => null }));
vi.mock('@/components/session/FloatingTerminalRoot', () => ({ default: () => null }));
vi.mock('@/components/session/FileOpenChooser', () => ({ default: () => null }));

import PhoneAppFrame from './PhoneAppFrame';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { PHONE_NAV_KEY, usePhoneNavStore } from '@/stores/phoneNavStore';
import { PHONE_UI_KEY, writePhoneUi } from '@/hooks/usePhoneUi';
import { PHONE_APPEARANCE_ATTR, resetPhoneAppearanceForTest, setPhoneAppearance } from '@/lib/chat/phoneAppearance';

function session(id: string, title: string, status: string, extra: Partial<Session> = {}): Session {
  return {
    sessionId: id, title, status, projectName: 'agent-manager', cliSource: 'claude', model: 'claude-opus-5-5',
    lastActivityAt: 1, terminalId: `term-${id}`, source: 'ssh', events: [], promptHistory: [], toolLog: [],
    ...extra,
  } as unknown as Session;
}

const fixtures = () => new Map([
  ['s1', session('s1', 'Approve me', 'approval', { pendingTool: 'Bash', pendingToolDetail: 'npm test', lastActivityAt: 1 })],
  ['s2', session('s2', 'Working one', 'working', { lastActivityAt: 5 })],
  ['s3', session('s3', 'Question', 'input', { lastActivityAt: 2 })],
  ['s4', session('s4', 'Idle one', 'idle', { lastActivityAt: 3 })],
]);

function goTo(url: string) {
  window.history.replaceState(null, '', url);
}

beforeEach(() => {
  goTo('/');
  writePhoneUi('app');
  localStorage.removeItem(PHONE_NAV_KEY);
  useSessionStore.setState({ sessions: fixtures(), selectedSessionId: null });
  useWsStore.setState({ snapshotReceived: true, connected: true, hiddenCount: 0 });
});

afterEach(() => {
  writePhoneUi('classic');
});

const tabButton = (name: RegExp | string) => within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name });

describe('PhoneAppFrame', () => {
  it('opens on Sessions, the waiting sessions first, with the Inbox badge', async () => {
    render(<PhoneAppFrame />);
    const sessions = await screen.findByTestId('phone-sessions');
    expect(within(sessions).getByRole('heading', { level: 1, name: 'Sessions' })).toBeTruthy();
    const needsYou = within(sessions).getByRole('region', { name: 'Needs you' });
    expect(within(needsYou).getAllByRole('listitem')).toHaveLength(2);
    expect(tabButton('Inbox, 2 waiting for you')).toBeTruthy();
    expect(tabButton('Sessions')).toHaveAttribute('aria-current', 'page');
    expect(window.location.search).toBe('?m=/sessions');
  });

  it('counts an interrupted turn as waiting', async () => {
    const interruption = { kind: 'overloaded', line: 'API Error: 529', detectedAt: 1 } as unknown as Session['interruption'];
    useSessionStore.setState({ sessions: new Map([...fixtures(), ['s5', session('s5', 'Stopped', 'waiting', { interruption })]]) });
    render(<PhoneAppFrame />);
    expect(await screen.findByRole('button', { name: 'Inbox, 3 waiting for you' })).toBeTruthy();
  });

  it('pushes a session, hides the tab bar there, and comes back through history', async () => {
    const user = userEvent.setup();
    render(<PhoneAppFrame />);
    await user.click(await screen.findByRole('button', { name: /Working one/ }));
    const screenEl = await screen.findByTestId('phone-session');
    expect(within(screenEl).getByRole('heading', { level: 1 })).toHaveTextContent('Working one');
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(window.location.search).toBe('?m=/sessions/s2/chat');
    expect(useSessionStore.getState().selectedSessionId).toBe('s2');

    await user.click(within(screenEl).getByRole('button', { name: 'Back to the list' }));
    await waitFor(() => expect(usePhoneNavStore.getState().stacks.sessions).toEqual(['/sessions']));
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeTruthy();
    await waitFor(() => expect(useSessionStore.getState().selectedSessionId).toBeNull());
  });

  it('switches segments in place, the terminal being today’s phone terminal', async () => {
    const user = userEvent.setup();
    render(<PhoneAppFrame />);
    await user.click(await screen.findByRole('button', { name: /Working one/ }));
    const before = await screen.findByTestId('phone-session');
    await user.click(await screen.findByRole('tab', { name: 'Terminal' }));
    expect(await screen.findByTestId('terminal-container')).toHaveTextContent('term-s2');
    // The same screen, not a new one: focus stays on the segment that was chosen.
    expect(screen.getByTestId('phone-session')).toBe(before);
    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: 'Terminal' })).toBeTruthy();
    expect(window.location.search).toBe('?m=/sessions/s2/terminal');
    expect(usePhoneNavStore.getState().stacks.sessions).toHaveLength(2);
  });

  it('keeps each tab its own stack', async () => {
    const user = userEvent.setup();
    render(<PhoneAppFrame />);
    await screen.findByTestId('phone-sessions');
    await user.click(tabButton('More'));
    await user.click(await screen.findByRole('button', { name: /About/ }));
    expect(await screen.findByTestId('phone-more-about')).toBeTruthy();
    await user.click(tabButton('Queue'));
    expect(await screen.findByTestId('phone-queue')).toBeTruthy();
    await user.click(tabButton('More'));
    expect(await screen.findByTestId('phone-more-about')).toBeTruthy();
  });

  it('pops to the tab’s root when the current tab is tapped again', async () => {
    const user = userEvent.setup();
    render(<PhoneAppFrame />);
    await screen.findByTestId('phone-sessions');
    await user.click(tabButton('More'));
    await user.click(await screen.findByRole('button', { name: /About/ }));
    await user.click(await screen.findByRole('button', { name: /UI kit/ }));
    expect(await screen.findByTestId('phone-gallery')).toBeTruthy();
    await user.click(tabButton('More'));
    await waitFor(() => expect(usePhoneNavStore.getState().stacks.more).toEqual(['/more']));
  });

  it('opens an old ?session= link on the chat when the session waits for an answer', async () => {
    goTo('/?session=s1&tab=terminal');
    render(<PhoneAppFrame />);
    const screenEl = await screen.findByTestId('phone-session');
    expect(within(screenEl).getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    expect(window.location.search).toBe('?m=/sessions/s1/chat');
  });

  it('opens an old link on the terminal when that was asked for', async () => {
    goTo('/?session=s4&tab=terminal');
    render(<PhoneAppFrame />);
    expect(await screen.findByTestId('terminal-container')).toHaveTextContent('term-s4');
  });

  it('does nothing with a link to a session this phone can’t see', async () => {
    goTo('/?session=hidden1&tab=conversation');
    render(<PhoneAppFrame />);
    expect(await screen.findByTestId('phone-sessions')).toBeTruthy();
    expect(window.location.search).toBe('?m=/sessions');
  });

  it('waits for the first snapshot before acting on a link', async () => {
    useWsStore.setState({ snapshotReceived: false });
    goTo('/?session=s3');
    render(<PhoneAppFrame />);
    expect(await screen.findByTestId('phone-sessions')).toBeTruthy();
    act(() => useWsStore.setState({ snapshotReceived: true }));
    expect(await screen.findByTestId('phone-session')).toBeTruthy();
  });

  it('opens a session another view selects (History "Open", search, a fork)', async () => {
    render(<PhoneAppFrame />);
    await screen.findByTestId('phone-sessions');
    act(() => useSessionStore.getState().selectSession('s4'));
    const screenEl = await screen.findByTestId('phone-session');
    expect(within(screenEl).getByRole('heading', { level: 1 })).toHaveTextContent('Idle one');
  });

  it('jumps to the next waiting session from "N more need you"', async () => {
    const user = userEvent.setup();
    render(<PhoneAppFrame />);
    await user.click(await screen.findByRole('button', { name: /Approve me/ }));
    await user.click(await screen.findByRole('button', { name: /1 more needs you/ }));
    await waitFor(() => expect(usePhoneNavStore.getState().stacks.sessions).toEqual(['/sessions', '/sessions/s3/chat']));
    expect(within(screen.getByTestId('phone-session')).getByRole('heading', { level: 1 })).toHaveTextContent('Question');
  });

  it('lists the waiting sessions in the Inbox and opens them on its own stack', async () => {
    const user = userEvent.setup();
    render(<PhoneAppFrame />);
    await screen.findByTestId('phone-sessions');
    await user.click(tabButton(/Inbox/));
    const inbox = await screen.findByTestId('phone-inbox');
    expect(within(inbox).getByText('Wants to run: npm test')).toBeTruthy();
    await user.click(within(inbox).getByRole('button', { name: /Question/ }));
    await screen.findByTestId('phone-session');
    expect(usePhoneNavStore.getState().tab).toBe('inbox');
    expect(usePhoneNavStore.getState().stacks.inbox).toEqual(['/inbox', '/sessions/s3/chat']);
  });

  it('turns the new design off from More', async () => {
    const user = userEvent.setup();
    render(<PhoneAppFrame />);
    await screen.findByTestId('phone-sessions');
    await user.click(tabButton('More'));
    const sw = await screen.findByRole('switch', { name: /New design/ });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);
    expect(localStorage.getItem(PHONE_UI_KEY)).toBe('classic');
  });

  it('scopes the phone tokens to <body> while mounted and drops ?m= when it goes', async () => {
    const { unmount } = render(<PhoneAppFrame />);
    await screen.findByTestId('phone-sessions');
    expect(document.body.classList.contains('phoneApp')).toBe(true);
    unmount();
    expect(document.body.classList.contains('phoneApp')).toBe(false);
    expect(window.location.search).toBe('');
  });

  it('hides the tab bar on a session\'s Info too, one level deeper than the session', async () => {
    const user = userEvent.setup();
    render(<PhoneAppFrame />);
    await user.click(await screen.findByRole('button', { name: /Working one/ }));
    const sessionEl = await screen.findByTestId('phone-session');
    await user.click(within(sessionEl).getByRole('button', { name: /^Working one/ }));
    expect(await screen.findByTestId('phone-info')).toBeTruthy();
    expect(window.location.search).toBe('?m=/sessions/s2/info');
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('goes back from a Settings page to the Settings list, by back or a link', async () => {
    const user = userEvent.setup();
    goTo('/?m=/more/settings');
    const { unmount } = render(<PhoneAppFrame />);
    const list = await screen.findByTestId('phone-more-settings');
    await user.click(within(list).getByRole('button', { name: /^Appearance/ }));
    expect(await screen.findByTestId('phone-more-appearance')).toBeTruthy();
    expect(usePhoneNavStore.getState().stacks.more).toEqual(['/more', '/more/settings', '/more/settings/appearance']);
    // The Android back button walks the browser history.
    act(() => window.history.back());
    await waitFor(() => expect(usePhoneNavStore.getState().stacks.more).toEqual(['/more', '/more/settings']));
    expect(await screen.findByTestId('phone-more-settings')).toBeTruthy();
    unmount();

    // A link straight to a Settings page stacks the Settings list under it.
    goTo('/?m=/more/settings/notifications');
    localStorage.removeItem(PHONE_NAV_KEY);
    render(<PhoneAppFrame />);
    expect(await screen.findByTestId('phone-more-notifications')).toBeTruthy();
    expect(usePhoneNavStore.getState().stacks.more).toEqual(['/more', '/more/settings', '/more/settings/notifications']);
    act(() => window.history.back());
    await waitFor(() => expect(usePhoneNavStore.getState().stacks.more.at(-1)).toBe('/more/settings'));
  });

  it('keeps a chosen Dark on <body> while mounted, and clears it when the frame goes', async () => {
    resetPhoneAppearanceForTest();
    act(() => setPhoneAppearance('dark'));
    const { unmount } = render(<PhoneAppFrame />);
    await screen.findByTestId('phone-sessions');
    expect(document.body.getAttribute(PHONE_APPEARANCE_ATTR)).toBe('dark');
    unmount();
    expect(document.body.hasAttribute(PHONE_APPEARANCE_ATTR)).toBe(false);
    act(() => setPhoneAppearance('system'));
  });

  it('drops a selection left from the classic layout, so opening that session still works', async () => {
    useSessionStore.setState({ selectedSessionId: 's4' });
    render(<PhoneAppFrame />);
    await screen.findByTestId('phone-sessions');
    await waitFor(() => expect(useSessionStore.getState().selectedSessionId).toBeNull());
    act(() => useSessionStore.getState().selectSession('s4'));
    expect(await screen.findByTestId('phone-session')).toBeTruthy();
  });
});

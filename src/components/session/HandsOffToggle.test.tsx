/**
 * The Hands off toggle (server/mcp): the person's switch that keeps every central from typing into one session,
 * handing it a task or queuing work for it. It is one of the title's icon buttons (beside Pin), the shared
 * IconButton as a toggle with the state in aria-pressed and in the glyph.
 *
 * It does not flip until the server says it took the change: "on" is a protection, and a switch that shows it
 * while the server refused would be a lie. So a click makes the button busy (not disabled: a disabled button drops
 * keyboard focus), waits, and then shows what the server answered; a refusal or a failure leaves the state as it was
 * and says why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import HandsOffToggle from './HandsOffToggle';
import { useMcpStore } from '@/stores/mcpStore';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@/components/ui/ToastContainer', () => toast);

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    status: 'idle',
    animationState: 'Idle',
    emote: null,
    projectName: 'test-project',
    projectPath: '/tmp/test',
    title: 'Session s1',
    source: 'terminal',
    model: 'claude-sonnet-4-5-20250514',
    startedAt: 1,
    lastActivityAt: 1,
    endedAt: null,
    currentPrompt: '',
    promptHistory: [],
    toolUsage: {},
    totalToolCalls: 0,
    toolLog: [],
    responseLog: [],
    events: [],
    pendingTool: null,
    waitingDetail: null,
    subagentCount: 0,
    terminalId: null,
    cachedPid: null,
    archived: 0,
    queueCount: 0,
    ...overrides,
  };
}

/** Mirrors DetailPanel's subscription, so a change in the store re-renders the toggle as it does in the app. */
function Harness({ sessionId }: { sessionId: string }) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  if (!session) return null;
  return <HandsOffToggle session={session} />;
}

const reply = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const button = () => screen.getByRole('button', { name: 'Hands off' });
const stored = (id = 's1') => useSessionStore.getState().sessions.get(id);

describe('HandsOffToggle', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    useMcpStore.setState({ available: true });
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply(200, { ok: true, handsOff: true }));
    vi.stubGlobal('fetch', fetchMock);
    toast.showToast.mockClear();
  });

  afterEach(() => {
    useMcpStore.setState({ available: null });
    vi.unstubAllGlobals();
  });

  describe('when it is offered', () => {
    it('is not, until this window knows it may drive centrals (the list has not been read)', () => {
      useMcpStore.setState({ available: null });
      useSessionStore.getState().addSession(makeSession());

      render(<Harness sessionId="s1" />);

      expect(screen.queryByRole('button', { name: 'Hands off' })).toBeNull();
    });

    it('is not on another device, or with central sessions off (the server answered 404)', () => {
      useMcpStore.setState({ available: false });
      useSessionStore.getState().addSession(makeSession());

      render(<Harness sessionId="s1" />);

      expect(screen.queryByRole('button', { name: 'Hands off' })).toBeNull();
    });

    it('is, once it is known', () => {
      useSessionStore.getState().addSession(makeSession());

      render(<Harness sessionId="s1" />);

      expect(button()).toBeInTheDocument();
    });

    it('appears when the window learns it, without a reload', () => {
      useMcpStore.setState({ available: null });
      useSessionStore.getState().addSession(makeSession());
      render(<Harness sessionId="s1" />);
      expect(screen.queryByRole('button', { name: 'Hands off' })).toBeNull();

      act(() => useMcpStore.setState({ available: true }));

      expect(button()).toBeInTheDocument();
    });

    it('is not on a central itself, which no central ever steers', () => {
      useSessionStore.getState().addSession(makeSession({ central: { centralId: 'c1', kind: 'global', scopeRef: null } }));

      render(<Harness sessionId="s1" />);

      expect(screen.queryByRole('button', { name: 'Hands off' })).toBeNull();
    });
  });

  describe('what it shows', () => {
    it('is off for a session that does not carry the flag', () => {
      useSessionStore.getState().addSession(makeSession());

      render(<Harness sessionId="s1" />);

      expect(button()).toHaveAttribute('aria-pressed', 'false');
    });

    it('is on for a session that carries it', () => {
      useSessionStore.getState().addSession(makeSession({ handsOff: true }));

      render(<Harness sessionId="s1" />);

      expect(button()).toHaveAttribute('aria-pressed', 'true');
    });

    it('has one name whatever the state, as every toggle here does: the state is aria-pressed', () => {
      useSessionStore.getState().addSession(makeSession());
      const off = render(<Harness sessionId="s1" />);
      expect(button()).toHaveAttribute('aria-label', 'Hands off');
      off.unmount();

      useSessionStore.setState({ sessions: new Map() });
      useSessionStore.getState().addSession(makeSession({ handsOff: true }));
      render(<Harness sessionId="s1" />);

      expect(button()).toHaveAttribute('aria-label', 'Hands off');
    });

    it('is a real button, with a decorative icon', () => {
      useSessionStore.getState().addSession(makeSession());

      render(<Harness sessionId="s1" />);

      expect(button().tagName).toBe('BUTTON');
      expect(button().querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    });

    it('shows the state in the glyph too, not only in the button’s fill: a ring while off, a disc while on', () => {
      useSessionStore.getState().addSession(makeSession());
      const off = render(<Harness sessionId="s1" />);
      expect(button().querySelector('circle')).not.toBeNull();
      expect(button().querySelector('path[fill-rule="evenodd"]')).toBeNull();
      off.unmount();

      useSessionStore.setState({ sessions: new Map() });
      useSessionStore.getState().addSession(makeSession({ handsOff: true }));
      render(<Harness sessionId="s1" />);

      expect(button().querySelector('circle')).toBeNull();
      expect(button().querySelector('path[fill-rule="evenodd"]')).not.toBeNull();
    });

    it('follows the flag when the server changes it (another window, or a restore)', () => {
      useSessionStore.getState().addSession(makeSession());
      render(<Harness sessionId="s1" />);

      act(() => useSessionStore.getState().updateSession(makeSession({ handsOff: true })));
      expect(button()).toHaveAttribute('aria-pressed', 'true');

      act(() => useSessionStore.getState().updateSession(makeSession()));
      expect(button()).toHaveAttribute('aria-pressed', 'false');
    });
  });

  describe('switching it on', () => {
    beforeEach(() => {
      useSessionStore.getState().addSession(makeSession({ title: 'Backend worker', muted: true, pinned: true }));
      render(<Harness sessionId="s1" />);
    });

    it('PUTs { on: true } to the session’s hands-off route', async () => {
      fireEvent.click(button());

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/mcp/sessions/s1/hands-off');
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual({ on: true });
    });

    it('turns on only once the server has answered (no switch that lies while the request is out)', async () => {
      let release: (res: Response) => void = () => undefined;
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));

      fireEvent.click(button());

      expect(button()).toHaveAttribute('aria-busy', 'true');
      expect(button()).toHaveAttribute('aria-pressed', 'false');
      expect(stored()?.handsOff).toBeUndefined();

      await act(async () => release(reply(200, { ok: true, handsOff: true })));

      await waitFor(() => expect(button()).toHaveAttribute('aria-pressed', 'true'));
      expect(button()).not.toHaveAttribute('aria-busy');
      expect(stored()?.handsOff).toBe(true);
    });

    // A disabled button drops keyboard focus (Chromium resets it to the page and never gives it back), so a person who
    // pressed Space would be thrown out of the title's actions and could not press it again. It stays enabled.
    it('stays enabled while a change is out, so it keeps keyboard focus', async () => {
      let release: (res: Response) => void = () => undefined;
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
      button().focus();

      fireEvent.click(button());

      expect(button()).not.toBeDisabled();
      expect(button()).toHaveFocus();

      await act(async () => release(reply(200, { ok: true, handsOff: true })));

      await waitFor(() => expect(button()).toHaveAttribute('aria-pressed', 'true'));
      expect(button()).not.toBeDisabled();
      expect(button()).toHaveFocus();
    });

    it('sends nothing more while a change is in flight', async () => {
      fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));

      fireEvent.click(button());
      fireEvent.click(button());
      fireEvent.click(button());

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('takes a new click once the answer is in (the guard is let go, also after a failure)', async () => {
      fetchMock.mockResolvedValueOnce(reply(500));
      fireEvent.click(button());
      await waitFor(() => expect(toast.showToast).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(button()).not.toHaveAttribute('aria-busy'));

      fetchMock.mockResolvedValueOnce(reply(200, { ok: true, handsOff: true }));
      fireEvent.click(button());

      await waitFor(() => expect(button()).toHaveAttribute('aria-pressed', 'true'));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('looks busy while a change is out (its own class, which the kit has no look for), and not after', async () => {
      let release: (res: Response) => void = () => undefined;
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
      expect(button().className).not.toMatch(/busy/);

      fireEvent.click(button());
      expect(button().className).toMatch(/busy/);

      await act(async () => release(reply(200, { ok: true, handsOff: true })));
      await waitFor(() => expect(button().className).not.toMatch(/busy/));
    });

    it('keeps everything else on the card as it was', async () => {
      fireEvent.click(button());

      await waitFor(() => expect(stored()?.handsOff).toBe(true));
      expect(stored()).toMatchObject({ sessionId: 's1', title: 'Backend worker', muted: true, pinned: true });
    });

    it('says what it did', async () => {
      fireEvent.click(button());

      await waitFor(() => expect(toast.showToast).toHaveBeenCalledTimes(1));
      expect(toast.showToast).toHaveBeenCalledWith(expect.stringMatching(/hands.off|read|steer/i), 'info', expect.any(Number));
    });

    // The moment of the click is when a person wonders about the task a central was handing over: say what became of it.
    it('says what becomes of a task already handed over, in plain words, and stays long enough to be read', async () => {
      fireEvent.click(button());

      await waitFor(() => expect(toast.showToast).toHaveBeenCalledTimes(1));
      const [message, , duration] = toast.showToast.mock.calls[0];
      expect(message).toMatch(/typing in stops/i);
      expect(message).toMatch(/already running keeps going until it ends or you stop it/i);
      expect(message).not.toMatch(/ledger|mcp|api|hook|socket|pty/i);
      expect(duration).toBeGreaterThanOrEqual(5000);
    });
  });

  describe('switching it off', () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue(reply(200, { ok: true, handsOff: false }));
      useSessionStore.getState().addSession(makeSession({ handsOff: true, title: 'Backend worker' }));
      render(<Harness sessionId="s1" />);
    });

    it('PUTs { on: false }', async () => {
      fireEvent.click(button());

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ on: false });
    });

    it('removes the flag from the card (absent means a central may steer it), and the button turns off', async () => {
      fireEvent.click(button());

      await waitFor(() => expect(button()).toHaveAttribute('aria-pressed', 'false'));
      expect(stored()).not.toHaveProperty('handsOff');
      expect(stored()?.title).toBe('Backend worker');
    });

    it('can be switched on again', async () => {
      fireEvent.click(button());
      await waitFor(() => expect(button()).toHaveAttribute('aria-pressed', 'false'));
      fetchMock.mockResolvedValue(reply(200, { ok: true, handsOff: true }));

      fireEvent.click(button());

      await waitFor(() => expect(button()).toHaveAttribute('aria-pressed', 'true'));
      expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ on: true });
    });
  });

  describe('when the server does not take it', () => {
    beforeEach(() => {
      useSessionStore.getState().addSession(makeSession());
      render(<Harness sessionId="s1" />);
    });

    it.each([
      ['404', () => reply(404, { ok: false, error: 'Not found' })],
      ['403', () => reply(403, { ok: false })],
      ['500', () => reply(500, { ok: false })],
    ])('leaves it off after a %s, says so as an error, and can be tried again', async (_name, answer) => {
      fetchMock.mockResolvedValue(answer());

      fireEvent.click(button());

      await waitFor(() => expect(toast.showToast).toHaveBeenCalledTimes(1));
      expect(toast.showToast).toHaveBeenCalledWith(expect.stringMatching(/could not be changed/i), 'error');
      expect(button()).toHaveAttribute('aria-pressed', 'false');
      expect(button()).not.toBeDisabled();
      expect(stored()?.handsOff).toBeUndefined();
    });

    it('leaves it off after a network error', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      fireEvent.click(button());

      await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith(expect.any(String), 'error'));
      expect(button()).toHaveAttribute('aria-pressed', 'false');
      expect(button()).not.toBeDisabled();
    });

    it('leaves it on when switching off fails', async () => {
      useSessionStore.setState({ sessions: new Map() });
      useSessionStore.getState().addSession(makeSession({ handsOff: true }));
      fetchMock.mockResolvedValue(reply(500));

      fireEvent.click(button());

      await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith(expect.any(String), 'error'));
      expect(button()).toHaveAttribute('aria-pressed', 'true');
      expect(stored()?.handsOff).toBe(true);
    });
  });

  describe('the tooltip', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const hover = () => {
      fireEvent.mouseEnter(button());
      act(() => {
        vi.advanceTimersByTime(400);
      });
      return screen.getByRole('tooltip');
    };

    it('says what the switch does while it is off', () => {
      useSessionStore.getState().addSession(makeSession());
      render(<Harness sessionId="s1" />);

      const tip = hover();

      expect(within(tip).getByText('Hands off')).toBeInTheDocument();
      expect(tip.textContent).toMatch(/central/i);
      expect(tip.textContent).toMatch(/read/i);
    });

    it('says what is so while it is on, and how to undo it', () => {
      useSessionStore.getState().addSession(makeSession({ handsOff: true }));
      render(<Harness sessionId="s1" />);

      const tip = hover();

      expect(within(tip).getByText('Hands off is on')).toBeInTheDocument();
      expect(tip.textContent).toMatch(/click/i);
    });

    // What turning it on does to a task a central already handed over, said where the person looks before and after:
    // a task AASC is still typing in stops before AASC types more of it, and one the session is already running is
    // not touched — it goes on until it ends or the person stops it.
    it.each([
      ['off', {}],
      ['on', { handsOff: true }],
    ])('says what happens to a task already handed over, in plain words, while it is %s', (_state, over) => {
      useSessionStore.getState().addSession(makeSession(over));
      render(<Harness sessionId="s1" />);

      const tip = hover();

      expect(tip.textContent).toMatch(/typing in stops/i);
      expect(tip.textContent).toMatch(/already running keeps going until it ends or you stop it/i);
      expect(tip.textContent).not.toMatch(/ledger|mcp|api|hook|socket|pty/i);
    });
  });

  // A click on a title action must not take focus from the terminal (Pin does the same, SessionSwitcher): the next
  // Space or Enter the person types is meant for the terminal, and had the toggle taken focus it would press Hands off
  // again and turn it back off.
  describe('focus', () => {
    beforeEach(() => {
      useSessionStore.getState().addSession(makeSession());
    });

    it('mousedown on the toggle does not move focus', async () => {
      render(
        <>
          <textarea aria-label="terminal input" />
          <Harness sessionId="s1" />
        </>,
      );
      const terminal = screen.getByLabelText('terminal input');
      terminal.focus();

      await userEvent.pointer({ keys: '[MouseLeft>]', target: button() });

      expect(terminal).toHaveFocus();
    });

    it('cancels the mousedown (the default action is what moves the focus)', () => {
      render(<Harness sessionId="s1" />);
      const down = createEvent.mouseDown(button());

      fireEvent(button(), down);

      expect(down.defaultPrevented).toBe(true);
    });

    it('still presses on a click, whose mousedown it cancelled', async () => {
      render(<Harness sessionId="s1" />);

      await userEvent.click(button());

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    });

    it('leaves keyboard focus as it was: Tab reaches it and Space presses it, and it keeps the focus', async () => {
      const user = userEvent.setup();
      render(<Harness sessionId="s1" />);

      await user.tab();
      expect(button()).toHaveFocus();
      await user.keyboard(' ');

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(button()).toHaveAttribute('aria-pressed', 'true'));
      expect(button()).toHaveFocus();
    });
  });
});

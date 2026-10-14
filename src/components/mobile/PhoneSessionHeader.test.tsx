// PhoneSessionHeader.test.tsx — moving between sessions on a phone (AASC-18):
// the Sessions drawer instead of the strip, swipe / previous / next in the
// drawer's order, kill-all behind a confirm, and a session's touch actions.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Session } from '@/types';

vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => [] }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import PhoneSessionHeader from './PhoneSessionHeader';
import SessionSwitcher from '@/components/session/SessionSwitcher';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useLabelStore } from '@/stores/labelStore';

const s = (id: string, over: Partial<Session> = {}): Session =>
  ({
    sessionId: id,
    title: id,
    projectName: 'app',
    projectPath: `/w/${id}`,
    status: 'idle',
    sshCommand: 'claude',
    startedAt: 1,
    lastActivityAt: 1,
    events: [],
    promptHistory: [],
    ...over,
  }) as unknown as Session;

const R1: Room = { id: 'R1', name: 'Front', sessionIds: ['c', 'a'], collapsed: false, createdAt: 0, listOrder: 0 };

let fetchMock: ReturnType<typeof vi.fn>;
let onSwitch: ReturnType<typeof vi.fn<(sessionId: string) => void>>;

function sessionsMap(): Map<string, Session> {
  return new Map(['a', 'b', 'c'].map((id) => [id, s(id)]));
}

/** Rooms view: Front (a, c), then the loose b. So the order is a, c, b. */
function renderHeader(current = 'c', enabled = true) {
  const sessions = sessionsMap();
  useSessionStore.setState({ sessions, selectedSessionId: current });
  return render(
    <PhoneSessionHeader enabled={enabled} currentSession={sessions.get(current)!} sessions={sessions} onSwitch={onSwitch}>
      <div data-testid="switcher">header</div>
    </PhoneSessionHeader>,
  );
}

function swipe(el: Element, dx: number, dy = 0) {
  fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 50 }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: 200 + dx, clientY: 50 + dy }] });
}

const openDrawer = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Sessions/ }));
  return screen.getByTestId('session-drawer');
};

beforeEach(() => {
  onSwitch = vi.fn<(sessionId: string) => void>();
  useUiStore.setState({ sessionSortMode: 'room', selectedRoomIds: new Set(), activeModal: null, recentRoomCollapsed: false });
  useRoomStore.setState({ rooms: [R1] });
  useLabelStore.setState({ labels: {}, custom: [] });
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/fork')) return { ok: true, json: async () => ({ ok: true, terminalId: 'term-fork' }) } as Response;
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PhoneSessionHeader on the desktop', () => {
  it('renders the header alone: no drawer button, no swipe', () => {
    renderHeader('c', false);
    expect(screen.getByTestId('switcher')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Sessions/ })).toBeNull();
    swipe(screen.getByTestId('switcher'), -150);
    expect(onSwitch).not.toHaveBeenCalled();
  });
});

describe('PhoneSessionHeader — previous / next', () => {
  it('says where the open session is in the list', () => {
    renderHeader('c');
    expect(screen.getByRole('button', { name: /^Sessions/ })).toHaveTextContent('2 of 3');
  });

  it('a swipe left opens the next session in the drawer order, a swipe right the previous', () => {
    renderHeader('c');
    swipe(screen.getByTestId('switcher'), -150);
    expect(onSwitch).toHaveBeenLastCalledWith('b');
    swipe(screen.getByTestId('switcher'), 150);
    expect(onSwitch).toHaveBeenLastCalledWith('a');
  });

  it('a short, slow or mostly vertical move is not a swipe', () => {
    renderHeader('c');
    const el = screen.getByTestId('switcher');
    swipe(el, -30);
    swipe(el, -100, 120);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('a swipe that starts in a text field is the field\'s, not a session switch', () => {
    const sessions = sessionsMap();
    useSessionStore.setState({ sessions });
    render(
      <PhoneSessionHeader enabled currentSession={sessions.get('c')!} sessions={sessions} onSwitch={onSwitch}>
        <input aria-label="Session title" />
      </PhoneSessionHeader>,
    );
    swipe(screen.getByLabelText('Session title'), -150);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('stops at the ends, and the buttons do the same as the swipe', () => {
    renderHeader('b');
    expect(screen.getByRole('button', { name: 'Next session' })).toBeDisabled();
    swipe(screen.getByTestId('switcher'), -150);
    expect(onSwitch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Previous session/ }));
    expect(onSwitch).toHaveBeenCalledWith('c');
  });
});

describe('the session drawer', () => {
  it('lists the sessions in their rooms and opens the one tapped', () => {
    renderHeader('c');
    const drawer = openDrawer();
    expect(within(drawer).getByRole('button', { name: /^Room Front, 2 sessions/ })).toBeInTheDocument();
    const rows = within(drawer).getAllByRole('button', { name: /^#\d/ });
    expect(rows.map((r) => r.getAttribute('data-session-id'))).toEqual(['a', 'c', 'b']);
    expect(within(drawer).getByRole('button', { name: /c, open now/ })).toHaveAttribute('aria-current', 'true');
    fireEvent.click(rows[2]);
    expect(onSwitch).toHaveBeenCalledWith('b');
    expect(screen.queryByTestId('session-drawer')).toBeNull();
  });

  it('switches between the Rooms, Projects and Recent views', () => {
    renderHeader('c');
    const drawer = openDrawer();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Projects' }));
    expect(useUiStore.getState().sessionSortMode).toBe('project');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Recent' }));
    expect(useUiStore.getState().sessionSortMode).toBe('activity');
  });

  it('a swipe inside the drawer does not switch the session behind it', () => {
    renderHeader('c');
    const drawer = openDrawer();
    swipe(drawer, -150);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('kill-all asks first: nothing is killed until the confirm', async () => {
    renderHeader('c');
    const drawer = openDrawer();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Kill all 2 sessions in Front' }));
    const confirm = screen.getByRole('dialog', { name: 'Kill all sessions in "Front"?' });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: /Kill all sessions/ })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Kill all 2 sessions in Front' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: /Kill all sessions/ })).getByRole('button', { name: 'Kill 2' }));
    await waitFor(() => {
      const killed = fetchMock.mock.calls.map(([url]) => url).filter((u) => String(u).endsWith('/kill'));
      expect(killed.sort()).toEqual(['/api/sessions/a/kill', '/api/sessions/c/kill']);
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Kill all sessions/ })).toBeNull());
  });

  it('Escape closes only the sheet on top', () => {
    renderHeader('c');
    const drawer = openDrawer();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Kill all 2 sessions in Front' }));
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog', { name: /Kill all sessions/ })).toBeNull();
    expect(screen.getByTestId('session-drawer')).toBeInTheDocument();
  });
});

describe('a session\'s actions (label, remark, fork, clone)', () => {
  const openActions = (id: string) => {
    const drawer = openDrawer();
    fireEvent.click(within(drawer).getByRole('button', { name: new RegExp(`^More for ${id}:`) }));
    return screen.getByRole('dialog', { name: id });
  };

  it('sets and clears a label by touch', () => {
    renderHeader('c');
    const sheet = openActions('a');
    fireEvent.click(within(sheet).getByRole('button', { name: 'IMPORTANT' }));
    expect(useLabelStore.getState().labels.a).toBe('IMPORTANT');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove label' }));
    expect(useLabelStore.getState().labels.a).toBeUndefined();
  });

  it('adds a new label and gives it to the session', () => {
    renderHeader('c');
    const sheet = openActions('a');
    fireEvent.change(within(sheet).getByLabelText('New label name'), { target: { value: 'Release' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    expect(useLabelStore.getState().labels.a).toBe('Release');
    expect(useLabelStore.getState().custom.map((l) => l.name)).toContain('Release');
  });

  it('saves a remark', () => {
    renderHeader('c');
    const sheet = openActions('b');
    fireEvent.change(within(sheet).getByLabelText('Session remark'), { target: { value: 'waiting on review' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(useSessionStore.getState().sessions.get('b')?.remark).toBe('waiting on review');
  });

  it('fork creates without asking, opens the new session and closes the sheets', async () => {
    renderHeader('c');
    const sheet = openActions('a');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Fork' }));
    await waitFor(() => expect(useSessionStore.getState().selectedSessionId).toBe('term-fork'));
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/a/fork', { method: 'POST' });
    await waitFor(() => expect(screen.queryByTestId('session-drawer')).toBeNull());
  });
});

describe('SessionSwitcher on a phone', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not draw the session strip (the drawer lists the sessions)', () => {
    const phone = (isPhone: boolean) => vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: isPhone && query.includes('max-width: 480px'),
      addEventListener: () => {},
      removeEventListener: () => {},
    })));
    const sessions = sessionsMap();
    phone(false);
    const desktop = render(<SessionSwitcher currentSession={sessions.get('c')!} sessions={sessions} onSwitch={vi.fn()} />);
    expect(desktop.container.querySelector('[class*="sessionTabStrip"]')).not.toBeNull();
    desktop.unmount();
    phone(true);
    const onPhone = render(<SessionSwitcher currentSession={sessions.get('c')!} sessions={sessions} onSwitch={vi.fn()} />);
    expect(onPhone.container.querySelector('[class*="sessionTabStrip"]')).toBeNull();
  });
});

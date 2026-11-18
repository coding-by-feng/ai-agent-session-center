// CloseSuggestionsModal — the "Sessions to close" list. The kill path is mocked: no test here may
// reach POST /api/sessions/:id/kill (see .claude/rules/known-issues.md, "Testing Gaps").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CloseSuggestionsModal from './CloseSuggestionsModal';
import { useSessionStore } from '@/stores/sessionStore';
import { useSessionMemoryStore } from '@/stores/sessionMemoryStore';
import { useUiStore, CLOSE_SUGGESTIONS_MODAL_ID } from '@/stores/uiStore';
import type { Session } from '@/types';

const authFetch = vi.hoisted(() => vi.fn());
const killSessions = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAuth', () => ({ authFetch }));
vi.mock('@/lib/roomKill', () => ({ killSessions }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast }));

const MIN = 60_000;
const MB = 1024 * 1024;

function session(id: string, over: Partial<Session> = {}): Session {
  return { sessionId: id, title: id, projectName: 'proj', status: 'waiting', ...over } as Session;
}

function answer(suggestions: unknown[], quietMinutes = 60): Response {
  return { ok: true, status: 200, json: async () => ({ ok: true, at: 1, quietMinutes, suggestions }) } as Response;
}

const SUGGESTIONS = [
  { sessionId: 'small', reason: 'idle', quietMs: 192 * MIN },
  { sessionId: 'big', reason: 'unused', quietMs: 120 * MIN },
];

function seed(sessions: Session[]): void {
  useSessionStore.setState({ sessions: new Map(sessions.map((s) => [s.sessionId, s])) });
  useSessionMemoryStore.setState({
    sample: { at: 1, totalBytes: 900 * MB, appBytes: 100 * MB, bySession: { small: 200 * MB, big: 600 * MB }, asleep: 0 },
  });
  useUiStore.setState({ activeModal: CLOSE_SUGGESTIONS_MODAL_ID });
}

const rows = (): HTMLElement[] => within(screen.getByRole('list')).getAllByRole('listitem');

beforeEach(() => {
  authFetch.mockReset().mockResolvedValue(answer(SUGGESTIONS));
  killSessions.mockReset().mockResolvedValue({ killed: 2, failed: 0 });
  showToast.mockReset();
  seed([session('small'), session('big')]);
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ activeModal: null });
});

describe('CloseSuggestionsModal', () => {
  it('lists each suggested session with its reason and memory, largest first', async () => {
    render(<CloseSuggestionsModal />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(authFetch).toHaveBeenCalledWith('/api/session-close-suggestions?quietMinutes=60');
    expect(rows()[0]).toHaveTextContent('big');
    expect(rows()[0]).toHaveTextContent('No prompt yet · started 2 h ago');
    expect(rows()[0]).toHaveTextContent('≈ 600 MB');
    expect(rows()[1]).toHaveTextContent('small');
    expect(rows()[1]).toHaveTextContent('Last prompt 3 h 12 min ago');
    expect(screen.getByText('2 suggested · ≈ 800 MB')).toBeInTheDocument();
  });

  it('closes every row by default and reports it', async () => {
    render(<CloseSuggestionsModal />);
    fireEvent.click(await screen.findByRole('button', { name: 'CLOSE 2 SESSIONS' }));
    await waitFor(() => expect(killSessions).toHaveBeenCalledTimes(1));
    expect(killSessions.mock.calls[0][0].map((s: Session) => s.sessionId)).toEqual(['big', 'small']);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Closed 2 sessions', 'success'));
    expect(useUiStore.getState().activeModal).toBeNull();
  });

  it('closes only the rows left ticked', async () => {
    killSessions.mockResolvedValue({ killed: 1, failed: 0 });
    render(<CloseSuggestionsModal />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /big/ }));
    fireEvent.click(screen.getByRole('button', { name: 'CLOSE 1 SESSION' }));
    await waitFor(() => expect(killSessions).toHaveBeenCalledTimes(1));
    expect(killSessions.mock.calls[0][0].map((s: Session) => s.sessionId)).toEqual(['small']);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Closed 1 session', 'success'));
  });

  it('has nothing to close once every row is unticked', async () => {
    render(<CloseSuggestionsModal />);
    for (const box of await screen.findAllByRole('checkbox')) fireEvent.click(box);
    expect(screen.getByRole('button', { name: 'CLOSE' })).toBeDisabled();
  });

  it('drops a session that started working after the list was read', async () => {
    render(<CloseSuggestionsModal />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    seed([session('small'), session('big', { status: 'working' })]);
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'CLOSE 1 SESSION' }));
    await waitFor(() => expect(killSessions).toHaveBeenCalledTimes(1));
    expect(killSessions.mock.calls[0][0].map((s: Session) => s.sessionId)).toEqual(['small']);
  });

  it('reads the list again for another quiet time', async () => {
    render(<CloseSuggestionsModal />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    authFetch.mockResolvedValue(answer([], 240));
    fireEvent.change(screen.getByRole('combobox', { name: 'Quiet for' }), { target: { value: '240' } });
    await waitFor(() => expect(authFetch).toHaveBeenLastCalledWith('/api/session-close-suggestions?quietMinutes=240'));
    expect(await screen.findByText('Nothing to close: every running session is busy, protected or prompted within 4 hours.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('button', { name: /^CLOSE/ })).toBeNull();
  });

  it('says so when a session survives', async () => {
    killSessions.mockResolvedValue({ killed: 1, failed: 1 });
    render(<CloseSuggestionsModal />);
    fireEvent.click(await screen.findByRole('button', { name: 'CLOSE 2 SESSIONS' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Closed 1 of 2 sessions: 1 still running', 'error'));
  });

  it('asks again at the click and keeps a session the server no longer suggests', async () => {
    killSessions.mockResolvedValue({ killed: 1, failed: 0 });
    render(<CloseSuggestionsModal />);
    const button = await screen.findByRole('button', { name: 'CLOSE 2 SESSIONS' });
    // Since the list was read, someone typed in `big`: its status is unchanged, only the server can tell.
    authFetch.mockResolvedValue(answer([SUGGESTIONS[0]]));
    fireEvent.click(button);
    await waitFor(() => expect(killSessions).toHaveBeenCalledTimes(1));
    expect(authFetch).toHaveBeenCalledTimes(2);
    expect(killSessions.mock.calls[0][0].map((s: Session) => s.sessionId)).toEqual(['small']);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Closed 1 session · kept 1 now in use', 'success'));
  });

  it('closes nothing and stays open when every ticked session is in use again', async () => {
    render(<CloseSuggestionsModal />);
    const button = await screen.findByRole('button', { name: 'CLOSE 2 SESSIONS' });
    authFetch.mockResolvedValue(answer([]));
    fireEvent.click(button);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Nothing closed: 2 sessions now in use', 'info'));
    expect(killSessions).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeModal).toBe(CLOSE_SUGGESTIONS_MODAL_ID);
    expect(await screen.findByText(/Nothing to close/)).toBeInTheDocument();
  });

  it('closes nothing when it cannot ask again', async () => {
    render(<CloseSuggestionsModal />);
    const button = await screen.findByRole('button', { name: 'CLOSE 2 SESSIONS' });
    authFetch.mockRejectedValue(new Error('offline'));
    fireEvent.click(button);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not check the sessions again, so nothing was closed', 'error'));
    expect(killSessions).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeModal).toBe(CLOSE_SUGGESTIONS_MODAL_ID);
  });

  it('cannot be dismissed while it is closing sessions', async () => {
    let finish: (value: { killed: number; failed: number }) => void = () => {};
    killSessions.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<CloseSuggestionsModal />);
    fireEvent.click(await screen.findByRole('button', { name: 'CLOSE 2 SESSIONS' }));
    await screen.findByRole('button', { name: 'CLOSING...' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useUiStore.getState().activeModal).toBe(CLOSE_SUGGESTIONS_MODAL_ID);
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    finish({ killed: 2, failed: 0 });
    await waitFor(() => expect(useUiStore.getState().activeModal).toBeNull());
  });

  it('says so when the list cannot be read, and closes nothing', async () => {
    authFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ ok: false }) } as Response);
    render(<CloseSuggestionsModal />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the sessions to close.');
    // Nothing to act on: no dead Close button, one way out.
    expect(screen.queryByRole('button', { name: /^CLOSE/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'DONE' })).toBeEnabled();
    expect(killSessions).not.toHaveBeenCalled();
  });
});

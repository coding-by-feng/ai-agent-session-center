import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/types';

const restart = vi.fn();
vi.mock('@/lib/restartSession', () => ({ requestSessionRestart: (id: string) => restart(id) }));
const toast = vi.fn();
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: (...a: unknown[]) => toast(...a) }));

import { useRestartProgressStore, RESTART_DONE_SHOWN_MS } from './restartProgressStore';
import { useSessionStore } from './sessionStore';
import { RESTART_GIVE_UP_MS } from '@/lib/chat/restartProgress';

function card(over: Partial<Session> = {}): Session {
  return { sessionId: 's1', title: 'KTS', status: 'idle', cliSource: 'claude', terminalId: 'term-old', ...over } as unknown as Session;
}
const put = (...sessions: Session[]) => useSessionStore.setState({ sessions: new Map(sessions.map((s) => [s.sessionId, s])) });
const track = (id = 's1') => useRestartProgressStore.getState().tracks.get(id);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  restart.mockReset();
  toast.mockReset();
  useRestartProgressStore.setState({ tracks: new Map(), shown: new Map() });
  put(card());
});
afterEach(() => {
  useRestartProgressStore.getState().reset();
  vi.useRealTimers();
});

describe('restartProgressStore', () => {
  it('walks stopping → starting → done as the Mac reports it', async () => {
    useRestartProgressStore.getState().watch('s1'); // a banner is on screen
    let answer!: (v: unknown) => void;
    restart.mockReturnValue(new Promise((r) => { answer = r; }));
    useRestartProgressStore.getState().start(card());
    expect(track()?.phase).toBe('stopping');

    answer({ ok: true, terminalId: 'term-new' });
    await flush();
    expect(track()).toMatchObject({ phase: 'starting', terminalId: 'term-new', cli: 'Claude' });

    put(card({ status: 'connecting', terminalId: 'term-new' }));
    expect(track()?.phase).toBe('starting');
    put(card({ status: 'idle', terminalId: 'term-new' }));
    expect(track()?.phase).toBe('done');
  });

  it('fails with the Mac’s own words when the request is refused', async () => {
    useRestartProgressStore.getState().watch('s1'); // a banner is on screen
    restart.mockResolvedValue({ ok: false, error: 'This session is restarting' });
    useRestartProgressStore.getState().start(card());
    await flush();
    expect(track()).toMatchObject({ phase: 'failed', error: 'This session is restarting' });
  });

  it('counts Codex as done once the Mac answers (it reports in only on its next message)', async () => {
    useRestartProgressStore.getState().watch('s1'); // a banner is on screen
    restart.mockResolvedValue({ ok: true, terminalId: 'term-new' });
    useRestartProgressStore.getState().start(card({ cliSource: 'codex' }));
    await flush();
    expect(track()).toMatchObject({ phase: 'done', cli: 'Codex' });
    expect(track()?.error).toMatch(/next message/);
  });

  it('follows a re-keyed card to its new id', async () => {
    useRestartProgressStore.getState().watch('s2'); // a banner is on screen
    restart.mockResolvedValue({ ok: true, terminalId: 'term-new' });
    useRestartProgressStore.getState().start(card());
    await flush();
    put(card({ sessionId: 's2', replacesId: 's1', status: 'idle', terminalId: 'term-new' } as Partial<Session>));
    expect(track('s1')).toBeUndefined();
    expect(track('s2')?.phase).toBe('done');
  });

  it('gives up when nothing comes, checked by its own timer', async () => {
    useRestartProgressStore.getState().watch('s1'); // a banner is on screen
    vi.useFakeTimers();
    restart.mockResolvedValue({ ok: true, terminalId: 'term-new' });
    useRestartProgressStore.getState().start(card());
    await vi.advanceTimersByTimeAsync(0);
    put(card({ status: 'connecting', terminalId: 'term-new' }));
    await vi.advanceTimersByTimeAsync(RESTART_GIVE_UP_MS);
    expect(track()?.phase).toBe('failed');
  });

  it('toasts the end when no banner shows it, and forgets a done one', async () => {
    restart.mockResolvedValue({ ok: true, terminalId: 'term-new' });
    useRestartProgressStore.getState().start(card());
    await flush();
    put(card({ status: 'idle', terminalId: 'term-new' }));
    expect(toast).toHaveBeenNthCalledWith(1, 'Restarting KTS…', 'info');
    expect(toast).toHaveBeenCalledWith('KTS restarted', 'success');
    expect(track()).toBeUndefined();
  });

  it('lets the banner say it instead while one is on screen; a done one closes after a while', async () => {
    vi.useFakeTimers();
    restart.mockResolvedValue({ ok: true, terminalId: 'term-new' });
    const release = useRestartProgressStore.getState().watch('s1');
    useRestartProgressStore.getState().start(card());
    await vi.advanceTimersByTimeAsync(0);
    put(card({ status: 'idle', terminalId: 'term-new' }));
    expect(toast).not.toHaveBeenCalled();
    expect(track()?.phase).toBe('done');
    await vi.advanceTimersByTimeAsync(RESTART_DONE_SHOWN_MS);
    expect(track()).toBeUndefined();
    release();
  });

  it('keeps a failed one until dismissed', async () => {
    restart.mockResolvedValue({ ok: false, error: 'nope' });
    const release = useRestartProgressStore.getState().watch('s1');
    useRestartProgressStore.getState().start(card());
    await flush();
    expect(track()?.phase).toBe('failed');
    useRestartProgressStore.getState().dismiss('s1');
    expect(track()).toBeUndefined();
    release();
  });
});

/**
 * Render-check for the compose-draft session-isolation fix.
 *
 * The store-level tests (queueStore.test.ts) already prove `getComposeDraft`/
 * `setComposeDraft` are correctly keyed per session. This test exists for a
 * different reason: that being correct doesn't prove `QueueTab` is WIRED to
 * read it live. The actual reported bug was a composition failure, not a
 * store bug — the store didn't exist yet, so there was nothing to be wrong
 * with; the bug was `useState('')` never being reset because neither
 * `<QueueTab>` render call site in DetailPanel.tsx passes `key={sessionId}`.
 *
 * `render()` + `rerender()` (not two separate `render()` calls) is the whole
 * point: RTL's `rerender` updates props on the SAME component instance
 * without unmounting, exactly reproducing what DetailPanel actually does
 * today when the visible session changes. A test using two `render()` calls,
 * or a `key`-forced remount, could not have caught this bug — it would pass
 * whether or not the fix was real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import QueueTab from './QueueTab';
import ToastContainer from '@/components/ui/ToastContainer';
import { useQueueStore } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';

// Sub-components unrelated to the compose box — mocked to keep this render
// focused and avoid needing to wire up every unrelated feature (edit modal,
// move picker, history sheet, exclude-windows modal), matching the isolation
// approach DetailPanel.test.tsx already uses for the same reason.
vi.mock('./QueueItemEditModal', () => ({ default: () => null }));
vi.mock('./QueueMovePicker', () => ({
  default: () => null,
  MOVE_TRIGGER_ATTR: 'data-move-trigger',
}));
vi.mock('./QueueHistorySheet', () => ({ default: () => null }));
vi.mock('./LoopExcludeWindowsModal', () => ({ default: () => null }));

describe('QueueTab — compose draft session isolation', () => {
  beforeEach(() => {
    useQueueStore.setState({ queues: new Map(), automation: new Map(), composeDrafts: new Map() });
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
  });

  it('does NOT show session A\'s draft when the sessionId prop changes without unmounting', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <QueueTab sessionId="session-a" sessionStatus="idle" terminalId={null} />,
    );

    const boxA = screen.getByPlaceholderText(/Add a prompt to the queue/i);
    await user.type(boxA, 'add: Refero (https://refero.design)');
    expect(boxA).toHaveValue('add: Refero (https://refero.design)');

    // Same component instance, new sessionId — exactly what DetailPanel does
    // today (no `key` prop on either <QueueTab> render call site).
    rerender(<QueueTab sessionId="session-b" sessionStatus="idle" terminalId={null} />);

    const boxB = screen.getByPlaceholderText(/Add a prompt to the queue/i);
    // THE reported bug: this used to still read session A's unfinished text.
    expect(boxB).toHaveValue('');
  });

  it('switching back to session A restores what was mid-typing there', async () => {
    // Stronger than "doesn't leak": a store-backed draft should also survive
    // navigating away and back, which a key-forced remount could not do.
    const user = userEvent.setup();
    const { rerender } = render(
      <QueueTab sessionId="session-a" sessionStatus="idle" terminalId={null} />,
    );

    await user.type(screen.getByPlaceholderText(/Add a prompt to the queue/i), 'draft for A');

    rerender(<QueueTab sessionId="session-b" sessionStatus="idle" terminalId={null} />);
    expect(screen.getByPlaceholderText(/Add a prompt to the queue/i)).toHaveValue('');

    rerender(<QueueTab sessionId="session-a" sessionStatus="idle" terminalId={null} />);
    expect(screen.getByPlaceholderText(/Add a prompt to the queue/i)).toHaveValue('draft for A');
  });

  it('two simultaneous QueueTab mounts for the SAME session show the same live draft', async () => {
    // The actual production topology: DetailPanel renders QueueTab twice for
    // one session (the always-on strip + the dedicated Queue tab). Both must
    // reflect the same in-progress draft, not two independently-diverging ones.
    const user = userEvent.setup();
    render(
      <>
        <QueueTab sessionId="session-a" sessionStatus="idle" terminalId={null} />
        <QueueTab sessionId="session-a" sessionStatus="idle" terminalId={null} fullHeight />
      </>,
    );

    const boxes = screen.getAllByPlaceholderText(/Add a prompt to the queue/i);
    expect(boxes).toHaveLength(2);
    await user.type(boxes[0], 'typed in the strip');

    const boxesAfter = screen.getAllByPlaceholderText(/Add a prompt to the queue/i);
    expect(boxesAfter[0]).toHaveValue('typed in the strip');
    expect(boxesAfter[1]).toHaveValue('typed in the strip');
  });
});

/**
 * The queue's notice while it is deliberately holding: after the user stopped
 * the last turn (Esc — Claude Code fires a real Stop, so without the hold the
 * queue would send its next prompt into the turn you just stopped), or while
 * subagents are still running.
 */
describe('QueueTab — held queue notice', () => {
  const session = (over: Record<string, unknown>) => ({
    sessionId: 's1',
    title: 'SMS Fixing',
    status: 'waiting',
    terminalId: 'term-1',
    lastActivityAt: Date.now(),
    subagentCount: 0,
    userCancelledAt: null,
    ...over,
  });
  const oneItem = [{ id: 1, sessionId: 's1', text: 'next prompt', position: 0, createdAt: 0, type: 'once' }];

  beforeEach(() => {
    useQueueStore.setState({ queues: new Map([['s1', oneItem as never]]), automation: new Map(), composeDrafts: new Map() });
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    vi.unstubAllGlobals();
  });

  it('after a user cancel: says the queue is paused, and Resume asks the server to continue', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, resumed: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    useSessionStore.setState({ sessions: new Map([['s1', session({ userCancelledAt: Date.now() }) as never]]) });
    render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" />);

    expect(screen.getByRole('status')).toHaveTextContent(/paused.*you stopped the last turn/i);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resume' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/queue/resume', expect.objectContaining({ method: 'POST' }));
  });

  it('says so when there was nothing left to resume (the server answered resumed: false)', async () => {
    // e.g. another device resumed first, or your own prompt already cleared it.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, resumed: false }), { status: 200 })));
    useSessionStore.setState({ sessions: new Map([['s1', session({ userCancelledAt: Date.now() }) as never]]) });
    render(<><ToastContainer /><QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" /></>);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText(/already running/i)).toBeInTheDocument();
    expect(screen.queryByText('Queue resumed')).toBeNull();
  });

  it('while subagents run: says what it is waiting for, with no button to press', () => {
    useSessionStore.setState({ sessions: new Map([['s1', session({ subagentCount: 2 }) as never]]) });
    render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" />);
    expect(screen.getByRole('status')).toHaveTextContent(/waiting for 2 subagents/i);
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('with the queue collapsed, its header still says it is paused (and expanding shows the notice)', async () => {
    localStorage.setItem('queue-panel-collapsed', '1');
    useSessionStore.setState({ sessions: new Map([['s1', session({ userCancelledAt: Date.now() }) as never]]) });
    render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" />);
    const toggle = screen.getByRole('button', { name: /QUEUE/ });
    expect(toggle).toHaveTextContent(/paused/i);
    await userEvent.setup().click(toggle);
    expect(screen.getByRole('status')).toHaveTextContent(/paused/i);
    // Expanded, the notice says it — the header chip would only repeat it.
    expect(screen.getByRole('button', { name: /QUEUE/ })).not.toHaveTextContent(/paused/i);
  });

  it('shows nothing for a normal session, or when the queue is empty', () => {
    useSessionStore.setState({ sessions: new Map([['s1', session({}) as never]]) });
    const { unmount } = render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" />);
    expect(screen.queryByRole('status')).toBeNull();
    unmount();

    useQueueStore.setState({ queues: new Map() });
    useSessionStore.setState({ sessions: new Map([['s1', session({ userCancelledAt: Date.now() }) as never]]) });
    render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

/**
 * The header count: how many rows are active (enabled — the scheduler may
 * send them) and how many are inactive (switched off with their own toggle,
 * shown on the row as "— paused —").
 */
describe('QueueTab — header count', () => {
  const row = (id: number, over: Record<string, unknown> = {}) =>
    ({ id, sessionId: 's1', text: `prompt ${id}`, position: id, createdAt: 0, type: 'once', ...over });
  const header = () => screen.getByRole('button', { name: /QUEUE/ });

  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    try { localStorage.removeItem('queue-panel-collapsed'); } catch { /* ignore */ }
  });

  it('splits the total into active and inactive rows', () => {
    const rows = [row(1), row(2, { disabled: true }), row(3), row(4, { disabled: true }), row(5, { execState: 'main' })];
    useQueueStore.setState({ queues: new Map([['s1', rows as never]]), automation: new Map(), composeDrafts: new Map() });
    render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" />);
    expect(header()).toHaveTextContent('QUEUE (3 active · 2 inactive)');
  });

  it('still says "0 inactive" when every row is on — that is the answer, not noise', () => {
    useQueueStore.setState({ queues: new Map([['s1', [row(1), row(2)] as never]]), automation: new Map(), composeDrafts: new Map() });
    render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" />);
    expect(header()).toHaveTextContent('QUEUE (2 active · 0 inactive)');
  });

  it('an empty queue stays "(0)"', () => {
    useQueueStore.setState({ queues: new Map(), automation: new Map(), composeDrafts: new Map() });
    render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" />);
    expect(header()).toHaveTextContent(/^.?QUEUE \(0\)$/);
  });

  it('counts live: switching a row off moves it from active to inactive', async () => {
    useQueueStore.setState({ queues: new Map([['s1', [row(1), row(2)] as never]]), automation: new Map(), composeDrafts: new Map() });
    render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" />);
    useQueueStore.getState().updateItem('s1', 1, { disabled: true });
    expect(await screen.findByRole('button', { name: /QUEUE \(1 active · 1 inactive\)/ })).toBeInTheDocument();
  });

  it('never says "paused" in the count — that word belongs to the held-queue chip', () => {
    useQueueStore.setState({ queues: new Map([['s1', [row(1, { disabled: true })] as never]]), automation: new Map(), composeDrafts: new Map() });
    render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" />);
    expect(header()).not.toHaveTextContent(/paused/i);
  });
});

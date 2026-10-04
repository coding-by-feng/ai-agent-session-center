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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import QueueTab from './QueueTab';
import ToastContainer from '@/components/ui/ToastContainer';
import { useQueueStore } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { installClipHarness } from '@/__tests__/clipHarness';
import { openQueuePopout } from '@/lib/queuePopout';

// The float button's only job is to call this; what it does (IPC / window.open) is
// covered by queuePopout.test.ts. The title helper stays real.
vi.mock('@/lib/queuePopout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queuePopout')>()),
  openQueuePopout: vi.fn(),
}));

// A phone is a viewport, not a capability: tests flip this to see the phone layout.
const platform = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));

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

/**
 * The float control: the QUEUE panel's way out into its own window. The window's
 * own copy renders QueueTab with `floating`, which has to differ from the docked
 * one in three ways: no float button (it already is one), always expanded, and a
 * header that cannot rewrite the docked strip's collapse flag.
 */
describe('QueueTab — float (pop out to its own window)', () => {
  const FLOAT = { name: /Detach Queue into its own window/ };
  const session = { sessionId: 's1', title: 'KTS Agent', projectName: 'kts', status: 'waiting', terminalId: 'term-1' };
  const openMock = vi.mocked(openQueuePopout);
  /** The panel's root element — the one that carries the `collapsed` class. Found through the
   *  compose box, because the float window's header is not a button. */
  const panelRoot = () =>
    screen.getByPlaceholderText(/Add a prompt to the queue/i).closest('[class*="queuePanel"]') as HTMLElement;
  const docked = () => (
    <>
      <QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" />
      <ToastContainer />
    </>
  );

  beforeEach(() => {
    platform.isMobile = false;
    openMock.mockReset();
    openMock.mockResolvedValue('native');
    useQueueStore.setState({ queues: new Map(), automation: new Map(), composeDrafts: new Map() });
    useSessionStore.setState({ sessions: new Map([['s1', session as never]]), selectedSessionId: null });
    try { localStorage.removeItem('queue-panel-collapsed'); } catch { /* ignore */ }
  });

  it('offers a float button in the header', () => {
    render(docked());
    expect(screen.getByRole('button', FLOAT)).toBeInTheDocument();
  });

  it('does not offer it on a phone: a second window is not a phone workflow', () => {
    platform.isMobile = true;
    render(docked());
    expect(screen.queryByRole('button', FLOAT)).toBeNull();
  });

  it("floats this session's queue, titled after the session", async () => {
    render(docked());
    await userEvent.setup().click(screen.getByRole('button', FLOAT));
    expect(openMock).toHaveBeenCalledWith({ sessionId: 's1', label: 'Queue — KTS Agent' });
  });

  it('leaves the docked panel exactly as it was — floating is not collapsing', async () => {
    localStorage.setItem('queue-panel-collapsed', '0');
    render(docked());
    await userEvent.setup().click(screen.getByRole('button', FLOAT));
    expect(panelRoot().className).not.toMatch(/collapsed/);
    expect(localStorage.getItem('queue-panel-collapsed')).toBe('0');
  });

  it('says so when the browser blocked the popup', async () => {
    openMock.mockResolvedValue('blocked');
    render(docked());
    await userEvent.setup().click(screen.getByRole('button', FLOAT));
    expect(await screen.findByText(/Pop-ups are blocked/i)).toBeInTheDocument();
  });

  it('says so when this app build cannot float the queue', async () => {
    openMock.mockResolvedValue('unsupported');
    render(docked());
    await userEvent.setup().click(screen.getByRole('button', FLOAT));
    expect(await screen.findByText(/isn't available in this app build/i)).toBeInTheDocument();
  });

  it('stays quiet when it worked', async () => {
    render(docked());
    await userEvent.setup().click(screen.getByRole('button', FLOAT));
    await Promise.resolve();
    expect(screen.queryByText(/Pop-ups are blocked|isn't available in this app build/i)).toBeNull();
  });

  describe("as the float window's own copy (floating)", () => {
    const floating = () => (
      <QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" fullHeight floating />
    );

    it('has no float button: it already is one', () => {
      render(floating());
      expect(screen.queryByRole('button', FLOAT)).toBeNull();
    });

    it('opens expanded even when the docked strip is stored as collapsed', () => {
      localStorage.setItem('queue-panel-collapsed', '1');
      render(floating());
      expect(panelRoot().className).not.toMatch(/collapsed/);
    });

    it('opens expanded on a fresh profile, where the docked default is collapsed', () => {
      render(floating());
      expect(panelRoot().className).not.toMatch(/collapsed/);
    });

    it("has a static header, not a disabled button — and it cannot rewrite the docked strip's collapse flag", async () => {
      localStorage.setItem('queue-panel-collapsed', '1');
      render(floating());
      // A disabled button would be announced as "dimmed" for a label that has nothing to act on.
      expect(screen.queryByRole('button', { name: /QUEUE/ })).toBeNull();
      const label = screen.getByText(/QUEUE/);
      await userEvent.setup().click(label);
      expect(localStorage.getItem('queue-panel-collapsed')).toBe('1');
      expect(panelRoot().className).not.toMatch(/collapsed/);
    });
  });
});

/**
 * A long prompt is cut off in the queue (one line in the list, a few lines in a
 * card), and reading all of it used to mean opening EDIT. Each item gets an
 * unfold/fold toggle; this is the wiring between QueueTab and QueueItemText —
 * the measuring and the toggle itself are covered in QueueItemText.test.tsx.
 */
describe('QueueTab — expanding a long prompt', () => {
  const LONG_A = 'Okay, so as we can see that um, we have a testing real Android form named Kason test.';
  const LONG_B = 'add icon button to filter session by AI type like claude code and codex please';
  const SHORT = '/update-feature-docs';
  const SHOW = /show full prompt/i;
  const HIDE = /collapse prompt/i;

  const items = [
    { id: 'a', sessionId: 's1', text: LONG_A, position: 0, createdAt: 0, type: 'once' },
    { id: 'b', sessionId: 's1', text: LONG_B, position: 1, createdAt: 0, type: 'once' },
    { id: 'c', sessionId: 's1', text: SHORT, position: 2, createdAt: 0, type: 'once' },
  ];

  let harness: ReturnType<typeof installClipHarness>;
  beforeEach(() => {
    harness = installClipHarness(200);
    localStorage.removeItem('queue-panel-collapsed');
    useQueueStore.setState({ queues: new Map([['s1', items as never]]), automation: new Map(), composeDrafts: new Map() });
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
  });
  afterEach(() => {
    // Unmount BEFORE touching the store: a store update under a mounted QueueTab re-renders it outside act.
    cleanup();
    harness.restore();
    useUiStore.setState({ queueViewMode: 'card' });
  });

  for (const layout of ['list', 'card'] as const) {
    describe(`${layout} layout`, () => {
      beforeEach(() => { useUiStore.setState({ queueViewMode: layout }); });

      it('offers the toggle on the prompts that are cut off, and not on the one that fits', async () => {
        render(<QueueTab sessionId="s1" sessionStatus="idle" terminalId={null} />);
        expect(await screen.findAllByRole('button', { name: SHOW })).toHaveLength(2);
        expect(screen.getByText(SHORT)).toBeInTheDocument();
      });

      it('expands only the prompt whose toggle was clicked, and folds it again', async () => {
        const user = userEvent.setup();
        render(<QueueTab sessionId="s1" sessionStatus="idle" terminalId={null} />);
        const [first] = await screen.findAllByRole('button', { name: SHOW });

        await user.click(first);
        expect(screen.getByText(LONG_A)).toHaveAttribute('data-expanded', 'true');
        expect(screen.getByText(LONG_B)).toHaveAttribute('data-expanded', 'false');
        expect(screen.getAllByRole('button', { name: SHOW })).toHaveLength(1);

        await user.click(screen.getByRole('button', { name: HIDE }));
        expect(screen.getByText(LONG_A)).toHaveAttribute('data-expanded', 'false');
        expect(screen.getAllByRole('button', { name: SHOW })).toHaveLength(2);
      });

      it('marks the row of an expanded prompt (list: its pieces stay level with the first line)', async () => {
        const user = userEvent.setup();
        render(<QueueTab sessionId="s1" sessionStatus="idle" terminalId={null} />);
        const rowOf = (text: string) => screen.getByText(text).closest('[class*="queueItem"], [class*="queueCard"]') as HTMLElement;
        await user.click((await screen.findAllByRole('button', { name: SHOW }))[0]);
        if (layout === 'list') {
          expect(rowOf(LONG_A).className).toMatch(/queueItemExpanded/);
          expect(rowOf(LONG_B).className).not.toMatch(/queueItemExpanded/);
        } else {
          // Cards stack their pieces already; they take no row class.
          expect(rowOf(LONG_A).className).not.toMatch(/queueItemExpanded/);
        }
      });

      it('does not send, move or delete anything: the toggle only changes what is shown', async () => {
        const user = userEvent.setup();
        render(<QueueTab sessionId="s1" sessionStatus="idle" terminalId={null} />);
        await user.click((await screen.findAllByRole('button', { name: SHOW }))[0]);
        expect(useQueueStore.getState().queues.get('s1')).toHaveLength(3);
        expect(useQueueStore.getState().queues.get('s1')?.map((i) => i.id)).toEqual(['a', 'b', 'c']);
      });

      it('keeps a prompt expanded across a switch to another session and back', async () => {
        const user = userEvent.setup();
        const { rerender } = render(<QueueTab sessionId="s1" sessionStatus="idle" terminalId={null} />);
        await user.click((await screen.findAllByRole('button', { name: SHOW }))[0]);
        expect(screen.getByText(LONG_A)).toHaveAttribute('data-expanded', 'true');

        rerender(<QueueTab sessionId="s2" sessionStatus="idle" terminalId={null} />);
        expect(screen.queryByText(LONG_A)).toBeNull();
        rerender(<QueueTab sessionId="s1" sessionStatus="idle" terminalId={null} />);
        expect(screen.getByText(LONG_A)).toHaveAttribute('data-expanded', 'true');
      });

      it('is view state of one panel: the same queue shown twice expands independently', async () => {
        const user = userEvent.setup();
        render(
          <>
            <QueueTab sessionId="s1" sessionStatus="idle" terminalId={null} />
            <QueueTab sessionId="s1" sessionStatus="idle" terminalId={null} fullHeight />
          </>,
        );
        const toggles = await screen.findAllByRole('button', { name: SHOW });
        expect(toggles).toHaveLength(4);
        await user.click(toggles[0]);
        const [inStrip, inTab] = screen.getAllByText(LONG_A);
        expect(inStrip).toHaveAttribute('data-expanded', 'true');
        expect(inTab).toHaveAttribute('data-expanded', 'false');
      });
    });
  }
});

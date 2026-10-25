import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import WorkerBadge from './WorkerBadge';
import { useMcpStore } from '@/stores/mcpStore';
import { useRoomStore } from '@/stores/roomStore';
import type { CentralSummary, McpTaskState, McpTaskView } from '@/types';

const central = (over: Partial<CentralSummary> = {}): CentralSummary => ({
  centralId: 'c1',
  kind: 'global',
  scopeRef: null,
  cli: 'claude',
  sessionId: 'central-card',
  toolsets: ['sessions'],
  createdAt: 1,
  workerCount: 0,
  ...over,
});

const task = (over: Partial<McpTaskView> = {}): McpTaskView => ({
  taskId: 'T12',
  centralId: 'c1',
  sessionId: 'w1',
  state: 'running',
  title: 'fix the flaky queue test',
  createdAt: 1_000,
  sentAt: 1_100,
  updatedAt: 2_000,
  error: null,
  answerChars: null,
  ...over,
});

const room = (id: string, name: string) => ({ id, name, sessionIds: [], collapsed: false, createdAt: 1, roomIndex: 0 });

/** Puts the centrals and tasks in the store, as the socket and the reads would. */
function seed(tasks: McpTaskView[], centrals: CentralSummary[] = [central()]) {
  useMcpStore.setState({
    centrals: new Map(centrals.map((c) => [c.centralId, c])),
    tasks: new Map(tasks.map((t) => [t.taskId, t])),
  });
}

const text = (container: HTMLElement) => container.textContent;

describe('WorkerBadge', () => {
  beforeEach(() => {
    useRoomStore.setState({ rooms: [room('room-1', 'Backend')] });
    useMcpStore.setState({ centrals: new Map(), tasks: new Map(), available: null });
  });

  afterEach(() => {
    act(() => {
      useRoomStore.setState({ rooms: [] });
      useMcpStore.setState({ centrals: new Map(), tasks: new Map(), available: null });
    });
  });

  describe('when it shows', () => {
    it('shows nothing for a session that has no task', () => {
      seed([]);

      const { container } = render(<WorkerBadge sessionId="w1" />);

      expect(container).toBeEmptyDOMElement();
    });

    it('shows nothing for another session’s task', () => {
      seed([task({ sessionId: 'w2' })]);

      const { container } = render(<WorkerBadge sessionId="w1" />);

      expect(container).toBeEmptyDOMElement();
    });

    it.each(['done', 'failed', 'cancelled'] as const)('shows nothing once the task is %s (the work is over)', (state) => {
      seed([task({ state })]);

      const { container } = render(<WorkerBadge sessionId="w1" />);

      expect(container).toBeEmptyDOMElement();
    });

    // A 404 for the centrals says central sessions are off here (the feature was switched off and the server
    // restarted, or this device may not see them). Whatever tasks the window still holds belong to a ledger that is
    // gone, so none of them may go on saying a worker is running.
    it('shows nothing once central sessions are known to be off here, whatever tasks are still held', () => {
      seed([task()]);
      useMcpStore.setState({ available: false });

      const { container } = render(<WorkerBadge sessionId="w1" />);

      expect(container).toBeEmptyDOMElement();
    });

    it('goes when the window learns central sessions are off, and comes back when they are on again', () => {
      seed([task()]);
      useMcpStore.setState({ available: true });
      const { container } = render(<WorkerBadge sessionId="w1" />);
      expect(text(container)).toBe('← ★ global · T12 · running');

      act(() => useMcpStore.setState({ available: false }));
      expect(container).toBeEmptyDOMElement();

      act(() => useMcpStore.setState({ available: true }));
      expect(text(container)).toBe('← ★ global · T12 · running');
    });

    it.each([null, true])('shows the task while availability is %s (not asked yet, or yes): the feed that brought it is proof enough', (available) => {
      seed([task()]);
      useMcpStore.setState({ available });

      const { container } = render(<WorkerBadge sessionId="w1" />);

      expect(text(container)).toBe('← ★ global · T12 · running');
    });

    it('appears when the task starts, and goes when it ends', () => {
      seed([]);
      const { container } = render(<WorkerBadge sessionId="w1" />);
      expect(container).toBeEmptyDOMElement();

      act(() => useMcpStore.getState().applyTaskUpdate(task({ state: 'sent', updatedAt: 1_500 })));
      expect(text(container)).toBe('← ★ global · T12 · sent');

      act(() => useMcpStore.getState().applyTaskUpdate(task({ state: 'done', updatedAt: 3_000 })));
      expect(container).toBeEmptyDOMElement();
    });

    it('follows the worker through a re-key (the task’s change carries the new session id)', () => {
      seed([task({ sessionId: 'term-1' })]);
      const old = render(<WorkerBadge sessionId="term-1" />);
      const fresh = render(<WorkerBadge sessionId="claude-uuid" />);
      expect(text(old.container)).toContain('T12');
      expect(fresh.container).toBeEmptyDOMElement();

      act(() => useMcpStore.getState().applyTaskUpdate(task({ sessionId: 'claude-uuid', updatedAt: 2_500 })));

      expect(old.container).toBeEmptyDOMElement();
      expect(text(fresh.container)).toBe('← ★ global · T12 · running');
    });
  });

  describe('what it says', () => {
    it('reads ← ★ global · T12 · running for a global central’s running task', () => {
      seed([task()]);

      const { container } = render(<WorkerBadge sessionId="w1" />);

      expect(text(container)).toBe('← ★ global · T12 · running');
    });

    it.each(['queued', 'sent', 'running', 'blocked', 'stalled'] as const)('says the state of a %s task', (state: McpTaskState) => {
      seed([task({ state })]);

      const { container } = render(<WorkerBadge sessionId="w1" />);

      expect(text(container)).toBe(`← ★ global · T12 · ${state}`);
    });

    it('names the room of a room central, from the room store, and follows its rename', () => {
      seed([task()], [central({ kind: 'room', scopeRef: 'room-1' })]);
      const { container } = render(<WorkerBadge sessionId="w1" />);
      expect(text(container)).toBe('← ★ room Backend · T12 · running');

      act(() => useRoomStore.setState({ rooms: [room('room-1', 'Platform')] }));

      expect(text(container)).toBe('← ★ room Platform · T12 · running');
    });

    it('names the folder of a project central', () => {
      seed([task()], [central({ kind: 'project', scopeRef: '/Users/me/agent-manager' })]);

      const { container } = render(<WorkerBadge sessionId="w1" />);

      expect(text(container)).toBe('← ★ project agent-manager · T12 · running');
    });

    it('says ★ central when the central is not in the list (not read yet, or it has gone)', () => {
      seed([task()], []);

      const { container } = render(<WorkerBadge sessionId="w1" />);

      expect(text(container)).toBe('← ★ central · T12 · running');
    });

    it('is named for a screen reader in words, not as arrows and stars', () => {
      seed([task({ state: 'blocked' })], [central({ kind: 'room', scopeRef: 'room-1' })]);

      render(<WorkerBadge sessionId="w1" />);

      expect(screen.getByLabelText('Task T12 from the room Backend central: blocked')).toBeInTheDocument();
    });

    it('keeps the task id and the state apart from the scope, so a long scope is cut before they are', () => {
      seed([task()], [central({ kind: 'project', scopeRef: '/Users/me/a-very-long-project-folder-name' })]);

      const { container } = render(<WorkerBadge sessionId="w1" />);

      // Two parts, in the written order: the lead (the scope and the ` · ` that goes with it) and the task.
      const parts = Array.from(container.querySelectorAll('[class*="badge"] > span')) as HTMLElement[];
      expect(parts.map((el) => el.textContent)).toEqual(['← ★ project a-very-long-project-folder-name · ', 'T12 · running']);
      // The CSS gives way on the first (down to a floor, then not at all) and holds the second: each has its own class.
      expect(parts[0].className).toContain('lead');
      expect(parts[1].className).toContain('rest');
    });

    it('keeps the separator in the lead, so a badge that drops its scope never starts with a dot', () => {
      seed([task()], [central({ kind: 'room', scopeRef: 'room-1' })]);

      const { container } = render(<WorkerBadge sessionId="w1" />);

      const lead = container.querySelector('[class*="badge"] > [class*="lead"]') as HTMLElement;
      expect(Array.from(lead.children).map((el) => [el.className.includes('scope'), el.textContent])).toEqual([
        [true, '← ★ room Backend'],
        [false, ' · '],
      ]);
    });
  });

  describe('the tone', () => {
    const toneOf = (container: HTMLElement) => (container.querySelector('[class*="badge"]') as HTMLElement).className;

    it('is quiet while the prompt is on its way', () => {
      for (const state of ['queued', 'sent'] as const) {
        seed([task({ state })]);
        const { container, unmount } = render(<WorkerBadge sessionId="w1" />);
        expect(toneOf(container)).toMatch(/pending/);
        unmount();
      }
    });

    it('is the central’s colour while the session works', () => {
      seed([task({ state: 'running' })]);

      const { container } = render(<WorkerBadge sessionId="w1" />);

      expect(toneOf(container)).toMatch(/running/);
    });

    it('is a warning when it waits on a dialog or a fault', () => {
      for (const state of ['blocked', 'stalled'] as const) {
        seed([task({ state })]);
        const { container, unmount } = render(<WorkerBadge sessionId="w1" />);
        expect(toneOf(container)).toMatch(/attention/);
        unmount();
      }
    });

    it('changes when the state does', () => {
      seed([task({ state: 'running' })]);
      const { container } = render(<WorkerBadge sessionId="w1" />);

      act(() => useMcpStore.getState().applyTaskUpdate(task({ state: 'blocked', updatedAt: 2_500 })));

      expect(toneOf(container)).toMatch(/attention/);
    });
  });

  describe('compact', () => {
    it('shows the task id alone, for a card with no room for words', () => {
      seed([task({ taskId: 'T3' })]);

      const { container } = render(<WorkerBadge sessionId="w1" compact />);

      expect(text(container)).toBe('T3');
    });

    it('keeps the whole badge in its name, since the words are gone', () => {
      seed([task({ taskId: 'T3', state: 'blocked' })]);

      render(<WorkerBadge sessionId="w1" compact />);

      expect(screen.getByLabelText('Task T3 from the global central: blocked')).toHaveTextContent('T3');
    });

    it('keeps its tone, so a blocked worker stands out on a compact card too', () => {
      seed([task({ state: 'stalled' })]);

      render(<WorkerBadge sessionId="w1" compact />);

      expect(screen.getByRole('img').className).toMatch(/attention/);
    });
  });

  describe('a mark, not a control', () => {
    it('is not a button and cannot be tabbed to (it sits inside a card that is one)', () => {
      seed([task()]);

      const { container } = render(<WorkerBadge sessionId="w1" />);

      expect(screen.queryByRole('button')).toBeNull();
      expect(container.querySelectorAll('[tabindex], button, a, input')).toHaveLength(0);
    });

    it('passes a class to its root, for the card or header it sits in', () => {
      seed([task()]);

      const { container } = render(<WorkerBadge sessionId="w1" className="placed-here" />);

      expect(container.firstElementChild).toHaveClass('placed-here');
    });
  });

  describe('the tooltip', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const hover = (el: HTMLElement) => {
      fireEvent.mouseEnter(el);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      return screen.getByRole('tooltip');
    };

    it('names the task and its state, who sent it, what it asked and what the state means', () => {
      seed([task({ state: 'blocked' })]);
      render(<WorkerBadge sessionId="w1" />);

      const tip = hover(screen.getByLabelText(/Task T12/));

      expect(within(tip).getByText('Task T12 · blocked')).toBeInTheDocument();
      expect(tip.textContent).toContain('From the global central.');
      expect(tip.textContent).toContain('“fix the flaky queue test”');
      expect(tip.textContent).toMatch(/dialog/i);
    });

    it('gives the whole folder of a project central, which the badge shortened to its name', () => {
      seed([task()], [central({ kind: 'project', scopeRef: '/Users/me/agent-manager' })]);
      render(<WorkerBadge sessionId="w1" />);

      expect(hover(screen.getByLabelText(/Task T12/)).textContent).toContain('/Users/me/agent-manager');
    });

    it('is the tooltip kit’s, drawn outside the card (portaled to the body)', () => {
      seed([task()]);
      const { container } = render(<WorkerBadge sessionId="w1" />);

      const tip = hover(screen.getByLabelText(/Task T12/));

      expect(container.contains(tip)).toBe(false);
      expect(document.body.contains(tip)).toBe(true);
    });

    it('is on the compact badge too', () => {
      seed([task()]);
      render(<WorkerBadge sessionId="w1" compact />);

      expect(within(hover(screen.getByRole('img'))).getByText('Task T12 · running')).toBeInTheDocument();
    });
  });
});

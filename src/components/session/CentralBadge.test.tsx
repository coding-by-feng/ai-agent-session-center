import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import CentralBadge from './CentralBadge';
import { useMcpStore } from '@/stores/mcpStore';
import { useRoomStore } from '@/stores/roomStore';
import type { CentralSummary, SessionCentralMarker } from '@/types';

const marker = (over: Partial<SessionCentralMarker> = {}): SessionCentralMarker => ({
  centralId: 'c1',
  kind: 'global',
  scopeRef: null,
  ...over,
});

const room = (id: string, name: string) => ({ id, name, sessionIds: [], collapsed: false, createdAt: 1, roomIndex: 0 });

describe('CentralBadge', () => {
  beforeEach(() => {
    useRoomStore.setState({ rooms: [room('room-1', 'Backend')] });
  });

  afterEach(() => {
    act(() => useRoomStore.setState({ rooms: [] }));
  });

  describe('what it says', () => {
    it('reads ★ global for a global central', () => {
      render(<CentralBadge central={marker()} />);
      expect(screen.getByText('★ global')).toBeInTheDocument();
    });

    it('reads ★ room <name> for a room central, with the name from the room store', () => {
      render(<CentralBadge central={marker({ kind: 'room', scopeRef: 'room-1' })} />);
      expect(screen.getByText('★ room Backend')).toBeInTheDocument();
    });

    it('reads plain ★ room when the room is not in the store (gone, or not loaded yet)', () => {
      render(<CentralBadge central={marker({ kind: 'room', scopeRef: 'room-gone' })} />);
      expect(screen.getByText('★ room')).toBeInTheDocument();
    });

    it('follows a rename of the room', () => {
      render(<CentralBadge central={marker({ kind: 'room', scopeRef: 'room-1' })} />);

      act(() => useRoomStore.setState({ rooms: [room('room-1', 'Platform')] }));

      expect(screen.getByText('★ room Platform')).toBeInTheDocument();
      expect(screen.queryByText('★ room Backend')).toBeNull();
    });

    it('reads ★ project <folder name> for a project central', () => {
      render(<CentralBadge central={marker({ kind: 'project', scopeRef: '/Users/me/agent-manager' })} />);
      expect(screen.getByText('★ project agent-manager')).toBeInTheDocument();
    });

    it('takes the last folder whatever the trailing slash', () => {
      render(<CentralBadge central={marker({ kind: 'project', scopeRef: '/Users/me/agent-manager/' })} />);
      expect(screen.getByText('★ project agent-manager')).toBeInTheDocument();
    });

    it('reads plain ★ project when the folder is missing', () => {
      render(<CentralBadge central={marker({ kind: 'project', scopeRef: null })} />);
      expect(screen.getByText('★ project')).toBeInTheDocument();
    });

    it('does not take a room named like a folder for a project central', () => {
      render(<CentralBadge central={marker({ kind: 'project', scopeRef: 'room-1' })} />);
      expect(screen.getByText('★ project room-1')).toBeInTheDocument();
    });
  });

  describe('its own workers (P4)', () => {
    const listed = (workerCount: number): void => {
      const summary: CentralSummary = {
        centralId: 'c1',
        kind: 'global',
        scopeRef: null,
        cli: 'claude',
        sessionId: null,
        toolsets: [],
        createdAt: 1,
        workerCount,
      };
      act(() => useMcpStore.setState({ centrals: new Map([['c1', summary]]) }));
    };
    afterEach(() => {
      act(() => useMcpStore.setState({ centrals: new Map() }));
    });

    it('the badge renders the count of the workers it runs', () => {
      listed(3);
      render(<CentralBadge central={marker()} />);
      expect(screen.getByText('★ global · 3 workers')).toBeInTheDocument();

      listed(1);
      expect(screen.getByText('★ global · 1 worker')).toBeInTheDocument();
    });

    it('says nothing of workers when it runs none, or is not in the list', () => {
      listed(0);
      const { unmount } = render(<CentralBadge central={marker()} />);
      expect(screen.getByText('★ global')).toBeInTheDocument();
      unmount();

      act(() => useMcpStore.setState({ centrals: new Map() }));
      render(<CentralBadge central={marker()} />);
      expect(screen.getByText('★ global')).toBeInTheDocument();
    });

    it('puts the count in the compact name too', () => {
      listed(2);
      render(<CentralBadge central={marker()} compact />);
      expect(screen.getByLabelText('Central session: global, 2 workers')).toBeInTheDocument();
    });
  });

  describe('compact', () => {
    it('shows the star alone, for a card with no room for words', () => {
      render(<CentralBadge central={marker({ kind: 'room', scopeRef: 'room-1' })} compact />);

      expect(screen.getByText('★')).toBeInTheDocument();
      expect(screen.queryByText(/room/)).toBeNull();
    });

    it('keeps the full scope in a screen-reader name, since the words are gone', () => {
      render(<CentralBadge central={marker({ kind: 'project', scopeRef: '/Users/me/app' })} compact />);

      expect(screen.getByLabelText('Central session: project app')).toBeInTheDocument();
    });
  });

  describe('a mark, not a control', () => {
    it('is not a button and cannot be tabbed to (it may sit inside a card that is one)', () => {
      const { container } = render(<CentralBadge central={marker()} />);

      expect(screen.queryByRole('button')).toBeNull();
      expect(container.querySelectorAll('[tabindex], button, a, input')).toHaveLength(0);
    });

    it('passes a class to its root, for the card or header it sits in', () => {
      const { container } = render(<CentralBadge central={marker()} className="placed-here" />);
      expect(container.firstElementChild).toHaveClass('placed-here');
    });
  });

  describe('bare (a card\'s star)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('is the star alone, named with the scope and the workers', () => {
      render(<CentralBadge central={marker({ kind: 'room', scopeRef: 'room-1' })} bare />);

      expect(screen.getByLabelText('Central session: room Backend')).toHaveTextContent(/^★$/);
    });

    it('opens no tooltip of its own: the card it sits in carries the scope', () => {
      render(<CentralBadge central={marker()} bare />);
      fireEvent.mouseEnter(screen.getByLabelText('Central session: global'));
      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('takes the class it is given, on the star itself', () => {
      render(<CentralBadge central={marker()} bare className="in-title" />);

      expect(screen.getByLabelText('Central session: global')).toHaveClass('in-title');
    });
  });

  describe('the tooltip', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const hover = (text: string) => {
      fireEvent.mouseEnter(screen.getByText(text));
      act(() => {
        vi.advanceTimersByTime(400);
      });
      return screen.getByRole('tooltip');
    };

    it('says the global scope in full', () => {
      render(<CentralBadge central={marker()} />);
      const tip = hover('★ global');

      expect(within(tip).getByText('Central session')).toBeInTheDocument();
      expect(tip.textContent).toContain('every session');
    });

    it('names the room', () => {
      render(<CentralBadge central={marker({ kind: 'room', scopeRef: 'room-1' })} />);

      expect(hover('★ room Backend').textContent).toContain('"Backend"');
    });

    it('gives the whole folder, which the badge shortened to its name', () => {
      render(<CentralBadge central={marker({ kind: 'project', scopeRef: '/Users/me/agent-manager' })} />);

      expect(hover('★ project agent-manager').textContent).toContain('/Users/me/agent-manager');
    });

    it('is the tooltip kit\'s, drawn outside the card (portaled to the body)', () => {
      const { container } = render(<CentralBadge central={marker()} />);
      const tip = hover('★ global');

      expect(container.contains(tip)).toBe(false);
      expect(document.body.contains(tip)).toBe(true);
    });
  });
});

// SessionPromptPeek.test.tsx — the card's hover says what a central session reaches (server/mcp), since the
// card's ★ is the star alone.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import SessionPromptPeek from './SessionPromptPeek';
import { useMcpStore } from '@/stores/mcpStore';
import { useRoomStore } from '@/stores/roomStore';
import type { Session } from '@/types';

const session = (over: Partial<Session> = {}): Session =>
  ({ sessionId: 's1', title: 'Boss', projectName: 'kason-tools', status: 'idle', promptHistory: [], ...over }) as Session;

describe('SessionPromptPeek — central sessions', () => {
  beforeEach(() => {
    useRoomStore.setState({ rooms: [{ id: 'r1', name: 'Kason Tools', sessionIds: [], collapsed: false, createdAt: 1, roomIndex: 0 }] });
  });
  afterEach(() => {
    act(() => {
      useRoomStore.setState({ rooms: [] });
      useMcpStore.setState({ centrals: new Map() } as never);
    });
  });

  it('names a room central\'s room', () => {
    render(<SessionPromptPeek session={session({ central: { centralId: 'c1', kind: 'room', scopeRef: 'r1' } })} />);

    expect(screen.getByText('★ Room central for "Kason Tools": can reach the sessions in that room.')).toBeInTheDocument();
  });

  it('adds the workers it runs', () => {
    useMcpStore.setState({ centrals: new Map([['c1', { centralId: 'c1', workerCount: 2 }]]) } as never);
    render(<SessionPromptPeek session={session({ central: { centralId: 'c1', kind: 'global', scopeRef: null } })} />);

    expect(screen.getByText('★ Global central: can reach every session. · 2 workers')).toBeInTheDocument();
  });

  it('says nothing of centrals for a plain session', () => {
    render(<SessionPromptPeek session={session()} />);

    expect(screen.queryByText(/★/)).toBeNull();
  });
});

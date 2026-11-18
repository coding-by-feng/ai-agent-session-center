// SessionPromptPeek.test.tsx — the card's hover says what a central session reaches (server/mcp), since the
// card's ★ is the star alone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: toast }));

import SessionPromptPeek from './SessionPromptPeek';
import { useMcpStore } from '@/stores/mcpStore';
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
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

  it('says Compacting while the session compacts, with no quiet time beside it', () => {
    render(<SessionPromptPeek session={session({
      status: 'idle',
      compacting: { since: Date.now(), trigger: 'auto' },
      events: [{ type: 'Stop', timestamp: Date.now() - 5 * 60_000, detail: '' }],
    } as never)} />);
    expect(screen.getByText(/Compacting/)).toBeInTheDocument();
    expect(screen.queryByText(/quiet/)).toBeNull();
    expect(screen.queryByText(/Idle/)).toBeNull();
  });

  it('says nothing of centrals for a plain session', () => {
    render(<SessionPromptPeek session={session()} />);

    expect(screen.queryByText(/★/)).toBeNull();
  });
});

describe('SessionPromptPeek — prompts', () => {
  it('shows each prompt whole, line breaks kept, not two clamped lines (Oct 29 2026)', () => {
    const text = `${'you know actually we need AASC Desktop version to serve as a BE service '.repeat(4)}\n\nand we can connect it from remote local`;
    render(<SessionPromptPeek session={session({ promptHistory: [{ text, timestamp: Date.now() - 11 * 60_000 }] } as never)} />);

    const [item] = within(screen.getByRole('list', { name: 'Recent prompts' })).getAllByRole('listitem');
    expect(item.textContent).toBe(`11m${text}`);
  });
});

// Nov 18 2026: a button in the peek asks for a few lines on what the session has done.
describe('SessionPromptPeek — Summary', () => {
  const NOW = Date.now();
  const typed = { promptHistory: [{ text: 'build the skill', timestamp: NOW - 60 * 60_000 }] };
  const live = (over: Partial<Session> = {}) => {
    const s = session({ ...typed, ...over } as never);
    act(() => { useSessionStore.setState({ sessions: new Map([[s.sessionId, s]]) }); });
    return s;
  };
  beforeEach(() => {
    toast.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true,"state":"running"}', { status: 202 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => { useSessionStore.setState({ sessions: new Map() }); });
  });

  it('offers Summary, and a click asks the Mac for this session', async () => {
    render(<SessionPromptPeek session={live()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Summarize what this session has done' }));
    expect(fetch).toHaveBeenCalledWith('/api/sessions/s1/recap', { method: 'POST' });
    await waitFor(() => expect(screen.getByRole('button', { name: /Summarizing/ })).toBeDisabled());
  });

  it('offers nothing before a prompt was typed', () => {
    render(<SessionPromptPeek session={live({ promptHistory: [] })} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the summary the session carries, with its age, and no button while it is current', () => {
    render(<SessionPromptPeek session={live({ recap: { state: 'done', text: '• Built the skill\n• Deployed', at: NOW - 2 * 60_000, promptAt: NOW - 60 * 60_000 } })} />);
    const block = screen.getByRole('region', { name: 'Summary' });
    expect(block.textContent).toContain('2m ago');
    expect(block.textContent).toContain('• Built the skill');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers Update once a newer prompt was typed', () => {
    render(<SessionPromptPeek session={live({
      promptHistory: [...typed.promptHistory, { text: 'deploy', timestamp: NOW - 60_000 }],
      recap: { state: 'done', text: '• Built the skill', at: NOW - 30 * 60_000, promptAt: NOW - 60 * 60_000 },
    } as never)} />);
    expect(screen.getByRole('button', { name: 'Update the summary' })).toBeEnabled();
    expect(screen.getByRole('region', { name: 'Summary' }).textContent).toContain('before your last prompt');
  });

  it('shows the run in progress from the session itself, so it survives the peek closing', () => {
    render(<SessionPromptPeek session={live({ recap: { state: 'running', at: NOW, promptAt: NOW - 60 * 60_000 } })} />);
    expect(screen.getByRole('button', { name: /Summarizing/ })).toBeDisabled();
  });

  it('follows the live session: the answer appears when the update arrives', () => {
    const s = live({ recap: { state: 'running', at: NOW, promptAt: NOW - 60 * 60_000 } });
    render(<SessionPromptPeek session={s} />);
    act(() => {
      useSessionStore.setState({ sessions: new Map([[s.sessionId, { ...s, recap: { state: 'done', text: '• All done', at: NOW, promptAt: NOW - 60 * 60_000 } } as Session]]) });
    });
    expect(screen.getByRole('region', { name: 'Summary' }).textContent).toContain('• All done');
  });

  it('says why a try failed, keeps the last summary, and offers Try again', () => {
    render(<SessionPromptPeek session={live({ recap: { state: 'error', text: '• Old one', error: 'the summarizer took too long', at: NOW, promptAt: NOW - 60 * 60_000 } })} />);
    const block = screen.getByRole('region', { name: 'Summary' });
    expect(block.textContent).toContain('• Old one');
    expect(block.textContent).toContain('Couldn’t summarize: the summarizer took too long.');
    expect(screen.getByRole('button', { name: 'Try the summary again' })).toBeEnabled();
  });

  it('says so when the Mac refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, error: 'Two summaries are already being made. Try again in a moment.' }), { status: 429 })));
    render(<SessionPromptPeek session={live()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Summarize what this session has done' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Two summaries are already being made. Try again in a moment.', 'error'));
    expect(screen.getByRole('button', { name: 'Summarize what this session has done' })).toBeEnabled();
  });
});

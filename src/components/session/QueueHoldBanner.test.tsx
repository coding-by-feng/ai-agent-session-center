// Ruling P4-57: the held-queue notice is its own component. "It is ready — send anyway" is offered only in the
// window that fires the queue; every other window says where to release it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import QueueHoldBanner from './QueueHoldBanner';
import { isStartReleased, setReleaseWindow, useStartReleaseStore } from '@/stores/startReleaseStore';

const card = { sessionId: 's1', terminalId: 'term-1' };
const SEND_ANYWAY = 'It is ready — send anyway';

beforeEach(() => {
  useStartReleaseStore.setState({ released: new Set(), releaseWindow: false });
  vi.unstubAllGlobals();
});

describe('QueueHoldBanner', () => {
  it('not-started, outside the release window: no button, and says where to release it', () => {
    render(<QueueHoldBanner hold="not-started" sessionId="s1" card={card} />);
    expect(screen.getByRole('status')).toHaveTextContent(/waiting for the session to report that it started/i);
    expect(screen.getByRole('status')).toHaveTextContent('Release it in the main AASC window.');
    expect(screen.queryByRole('button', { name: SEND_ANYWAY })).toBeNull();
  });

  it('not-started, in the release window: the button releases this card, and the hint is gone', async () => {
    setReleaseWindow(true);
    render(<QueueHoldBanner hold="not-started" sessionId="s1" card={card} />);
    expect(screen.getByRole('status')).not.toHaveTextContent('Release it in the main AASC window.');
    await userEvent.setup().click(screen.getByRole('button', { name: SEND_ANYWAY }));
    expect(isStartReleased(card)).toBe(true);
  });

  it('the window opening while the banner shows swaps the hint for the button', () => {
    const { rerender } = render(<QueueHoldBanner hold="not-started" sessionId="s1" card={card} />);
    expect(screen.queryByRole('button', { name: SEND_ANYWAY })).toBeNull();
    setReleaseWindow(true);
    rerender(<QueueHoldBanner hold="not-started" sessionId="s1" card={card} />);
    expect(screen.getByRole('button', { name: SEND_ANYWAY })).toBeInTheDocument();
  });

  it('no other hold offers the release or the hint, even in the release window', () => {
    setReleaseWindow(true);
    render(<QueueHoldBanner hold="cancelled" sessionId="s1" card={card} />);
    expect(screen.queryByRole('button', { name: SEND_ANYWAY })).toBeNull();
    expect(screen.getByRole('status')).not.toHaveTextContent('Release it in the main AASC window.');
  });

  it('cancelled: Resume asks the server to continue', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, resumed: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<QueueHoldBanner hold="cancelled" sessionId="s1" card={card} />);
    expect(screen.getByRole('status')).toHaveTextContent(/paused.*you stopped the last turn/i);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resume' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/queue/resume', expect.objectContaining({ method: 'POST' }));
  });

  it('subagents and background shells: say what it waits for, with the right plural, and no button', () => {
    const { rerender } = render(<QueueHoldBanner hold="subagents" sessionId="s1" card={card} runningSubagents={2} />);
    expect(screen.getByRole('status')).toHaveTextContent(/waiting for 2 subagents/i);
    rerender(<QueueHoldBanner hold="background" sessionId="s1" card={card} runningBackground={1} />);
    expect(screen.getByRole('status')).toHaveTextContent(/waiting for 1 background shell to finish/i);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

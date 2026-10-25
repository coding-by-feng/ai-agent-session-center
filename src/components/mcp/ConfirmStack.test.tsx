import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ConfirmStack from './ConfirmStack';
import { useMcpConfirmStore, type ConfirmAnswer, type ConfirmDecision } from '@/stores/mcpConfirmStore';
import { useMcpStore } from '@/stores/mcpStore';
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import type { McpConfirmView } from '@/types/mcpConfirm';
import type { CentralSummary, Session } from '@/types';

const NOW = 1_700_000_000_000;
/** How long Allow stays disabled after a card first shows. */
const ALLOW_DELAY_MS = 600;

function view(over: Partial<McpConfirmView> = {}): McpConfirmView {
  return {
    cardId: 'card-1',
    centralId: 'central-1',
    tool: 'session_kill',
    risk: 'ask',
    summary: 'Close the session "api"',
    detail: null,
    targetSessionId: null,
    createdAt: NOW,
    expiresAt: NOW + 125_000,
    ...over,
  };
}

function central(over: Partial<CentralSummary> = {}): CentralSummary {
  return {
    centralId: 'central-1',
    kind: 'global',
    scopeRef: null,
    cli: 'claude',
    sessionId: null,
    toolsets: [],
    createdAt: NOW,
    workerCount: 0,
    ...over,
  };
}

function show(...views: McpConfirmView[]): void {
  act(() => useMcpConfirmStore.setState({ confirms: views }));
}

describe('ConfirmStack', () => {
  let answer: Mock<(cardId: string, decision: ConfirmDecision) => Promise<ConfirmAnswer>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    answer = vi.fn<(cardId: string, decision: ConfirmDecision) => Promise<ConfirmAnswer>>().mockResolvedValue('ok');
    useMcpConfirmStore.setState({ confirms: [], answer });
    useMcpStore.setState({ centrals: new Map([['central-1', central()]]) });
    useRoomStore.setState({ rooms: [] });
    useSessionStore.setState({ sessions: new Map() });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders nothing with no confirms', () => {
    render(<ConfirmStack />);
    expect(document.body.querySelector('button')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('renders summary, label and target title', () => {
    useSessionStore.setState({
      sessions: new Map([['s-1234567890', { id: 's-1234567890', title: 'Backend api' } as unknown as Session]]),
    });
    render(<ConfirmStack />);
    show(view({ targetSessionId: 's-1234567890' }));
    expect(screen.getByText('Close the session "api"')).toBeInTheDocument();
    expect(screen.getByText(/★ global/)).toBeInTheDocument();
    expect(screen.getByText(/wants to/)).toBeInTheDocument();
    expect(screen.getByText(/Backend api/)).toBeInTheDocument();
    expect(screen.getByText(/s-123456/)).toBeInTheDocument();
  });

  it('labels a room central by the room name and a project central by its folder', () => {
    useMcpStore.setState({
      centrals: new Map([
        ['c-room', central({ centralId: 'c-room', kind: 'room', scopeRef: 'room-1' })],
        ['c-proj', central({ centralId: 'c-proj', kind: 'project', scopeRef: '/Users/me/dev/agent-manager' })],
      ]),
    });
    useRoomStore.setState({ rooms: [{ id: 'room-1', name: 'Backend' } as never] });
    render(<ConfirmStack />);
    show(view({ cardId: 'a', centralId: 'c-room' }), view({ cardId: 'b', centralId: 'c-proj' }));
    expect(screen.getByText(/★ room Backend/)).toBeInTheDocument();
    expect(screen.getByText(/★ project agent-manager/)).toBeInTheDocument();
  });

  it('says "A central" when the central has left the list', () => {
    render(<ConfirmStack />);
    show(view({ centralId: 'gone' }));
    expect(screen.getByText(/A central wants to/)).toBeInTheDocument();
  });

  it('shows the short id alone when the target card is not known', () => {
    render(<ConfirmStack />);
    show(view({ targetSessionId: 'abcdef123456' }));
    expect(screen.getByText(/abcdef12/)).toBeInTheDocument();
  });

  it('detail renders as text, never HTML', () => {
    const evil = '<img src=x onerror="window.__pwned = 1"><b>bold</b>';
    render(<ConfirmStack />);
    show(view({ detail: evil }));
    expect(document.body.querySelector('img')).toBeNull();
    expect(document.body.querySelector('b')).toBeNull();
    const pre = document.body.querySelector('pre');
    expect(pre?.textContent).toBe(evil);
    expect(screen.getByText('Written by the central')).toBeInTheDocument();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('has no detail block when the central wrote none', () => {
    render(<ConfirmStack />);
    show(view({ detail: null }));
    expect(document.body.querySelector('pre')).toBeNull();
    expect(screen.queryByText('Written by the central')).toBeNull();
  });

  it("Allow once calls answer(cardId,'allow')", () => {
    render(<ConfirmStack />);
    show(view());
    act(() => vi.advanceTimersByTime(ALLOW_DELAY_MS));
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(answer).toHaveBeenCalledWith('card-1', 'allow');
  });

  it("Deny calls answer(cardId,'deny')", () => {
    render(<ConfirmStack />);
    show(view());
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(answer).toHaveBeenCalledWith('card-1', 'deny');
  });

  it('buttons disable while answering', async () => {
    let finish: (v: ConfirmAnswer) => void = () => undefined;
    answer.mockReturnValue(new Promise<ConfirmAnswer>((r) => (finish = r)));
    render(<ConfirmStack />);
    show(view());
    act(() => vi.advanceTimersByTime(ALLOW_DELAY_MS));
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
    // A second click while the first is out sends nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(answer).toHaveBeenCalledTimes(1);
    await act(async () => finish('ok'));
  });

  it('a failed answer says so and enables the buttons again', async () => {
    answer.mockResolvedValue('failed');
    render(<ConfirmStack />);
    show(view());
    act(() => vi.advanceTimersByTime(ALLOW_DELAY_MS));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Allow once' })));
    expect(screen.getByText(/could not be delivered/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  });

  it('nothing has focus after a card appears, and Escape answers nothing', () => {
    render(<ConfirmStack />);
    show(view());
    expect(document.body).toHaveFocus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Deny' }), { key: 'Escape' });
    expect(answer).not.toHaveBeenCalled();
    expect(screen.getByText('Close the session "api"')).toBeInTheDocument();
  });

  it('shows +N more past 3', () => {
    render(<ConfirmStack />);
    show(...['a', 'b', 'c', 'd', 'e'].map((id, i) => view({ cardId: id, summary: `Ask ${id}`, createdAt: NOW + i })));
    expect(screen.getAllByRole('button', { name: 'Allow once' })).toHaveLength(3);
    expect(screen.getByText('Ask a')).toBeInTheDocument();
    expect(screen.queryByText('Ask d')).toBeNull();
    expect(screen.getByText('+2 more waiting')).toBeInTheDocument();
  });

  it('counts down and hides at expiry', () => {
    render(<ConfirmStack />);
    show(view({ expiresAt: NOW + 125_000 }));
    expect(screen.getByText('expires in 2:05')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(65_000));
    expect(screen.getByText('expires in 1:00')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText('Close the session "api"')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
    expect(useMcpConfirmStore.getState().confirms).toEqual([]);
  });

  it('announces arrivals in a polite live region', () => {
    render(<ConfirmStack />);
    show(view());
    const live = document.body.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(within(live as HTMLElement).getByText(/1 confirmation waiting/)).toBeInTheDocument();
  });

  it('is portaled to document.body, outside the render container', () => {
    const { container } = render(<ConfirmStack />);
    show(view());
    const stack = screen.getByRole('region', { name: 'Central confirmations' });
    expect(container.contains(stack)).toBe(false);
    expect(stack.parentElement).toBe(document.body);
  });

  it('keeps card 1 where it is (DOM order and style) when card 2 arrives', () => {
    render(<ConfirmStack />);
    show(view({ cardId: 'a', summary: 'Ask a' }));
    const first = screen.getByRole('article', { name: /Ask a/ });
    const before = { style: first.getAttribute('style'), index: Array.from(first.parentElement!.children).indexOf(first) };
    show(view({ cardId: 'a', summary: 'Ask a' }), view({ cardId: 'b', summary: 'Ask b' }));
    const again = screen.getByRole('article', { name: /Ask a/ });
    expect(again).toBe(first);
    expect(again.getAttribute('style')).toBe(before.style);
    expect(Array.from(again.parentElement!.children).indexOf(again)).toBe(before.index);
    // The newer card comes after it in the DOM; the column is reversed, so it grows upward from the corner.
    const articles = screen.getAllByRole('article');
    expect(articles.map((a) => a.getAttribute('aria-label'))).toEqual([
      expect.stringContaining('Ask a'),
      expect.stringContaining('Ask b'),
    ]);
    const stack = screen.getByRole('region', { name: 'Central confirmations' });
    expect(stack.className).toMatch(/stack/);
  });

  it('disables Allow for 600 ms after a card first shows; Deny stays live', () => {
    render(<ConfirmStack />);
    show(view());
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(answer).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(ALLOW_DELAY_MS - 1));
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeEnabled();
  });

  it('Deny answers at once, inside the Allow delay', () => {
    render(<ConfirmStack />);
    show(view());
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(answer).toHaveBeenCalledWith('card-1', 'deny');
  });

  it('a card that arrives later gets its own delay; an older card stays armed', () => {
    render(<ConfirmStack />);
    show(view({ cardId: 'a', summary: 'Ask a' }));
    act(() => vi.advanceTimersByTime(ALLOW_DELAY_MS));
    show(view({ cardId: 'a', summary: 'Ask a' }), view({ cardId: 'b', summary: 'Ask b' }));
    const allowOf = (name: RegExp) =>
      within(screen.getByRole('article', { name })).getByRole('button', { name: 'Allow once' });
    expect(allowOf(/Ask a/)).toBeEnabled();
    expect(allowOf(/Ask b/)).toBeDisabled();
    act(() => vi.advanceTimersByTime(ALLOW_DELAY_MS));
    expect(allowOf(/Ask b/)).toBeEnabled();
  });
});

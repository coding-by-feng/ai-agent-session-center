import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import PhoneConfirmCard, { PhoneConfirmList } from './PhoneConfirmCard';
import { usePhoneConfirmStore } from '@/stores/phoneConfirmStore';
import type { ConfirmAnswer, ConfirmDecision } from '@/stores/mcpConfirmStore';
import { useSessionStore } from '@/stores/sessionStore';
import type { McpConfirmView } from '@/types/mcpConfirm';
import type { Session } from '@/types';

const NOW = 1_700_000_000_000;
/** How long Allow stays disabled after a card first shows (P3-28). */
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

const allow = () => screen.getByRole('button', { name: /^Allow once/ });
const deny = () => screen.getByRole('button', { name: 'Deny' });
const isDisabled = (el: HTMLElement) => el.getAttribute('aria-disabled') === 'true';

describe('PhoneConfirmCard', () => {
  let answer: Mock<(cardId: string, decision: ConfirmDecision) => Promise<ConfirmAnswer>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    answer = vi.fn<(cardId: string, decision: ConfirmDecision) => Promise<ConfirmAnswer>>().mockResolvedValue('ok');
    usePhoneConfirmStore.setState({ confirms: [], answer });
    useSessionStore.setState({ sessions: new Map() });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('says who asks, what, and when it expires', () => {
    render(<PhoneConfirmList confirms={[view()]} />);
    expect(screen.getByText(/A central asks/)).toBeInTheDocument();
    expect(screen.getByText('Close the session "api"')).toBeInTheDocument();
    expect(screen.getByText('expires in 2:05')).toBeInTheDocument();
  });

  it('names the target by its title when the phone has the session', () => {
    useSessionStore.setState({
      sessions: new Map([['s-1', { sessionId: 's-1', title: 'agent-manager-2', projectName: 'proj' } as unknown as Session]]),
    });
    render(<PhoneConfirmList confirms={[view({ targetSessionId: 's-1' })]} />);
    expect(screen.getByText(/agent-manager-2/)).toBeInTheDocument();
  });

  it('detail renders as text, never HTML, under its label', () => {
    const detail = '<img src=x onerror=alert(1)> and <b>bold</b>';
    const { container } = render(<PhoneConfirmList confirms={[view({ detail })]} />);
    expect(screen.getByText('Written by the central')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByLabelText('Text written by the central')).toHaveTextContent(detail);
  });

  it('shows no detail block without detail', () => {
    render(<PhoneConfirmList confirms={[view({ detail: '' })]} />);
    expect(screen.queryByText('Written by the central')).toBeNull();
  });

  it('Allow is disabled for 600 ms; Deny is live at once', () => {
    render(<PhoneConfirmList confirms={[view()]} />);
    expect(isDisabled(allow())).toBe(true);
    expect(isDisabled(deny())).toBe(false);
    fireEvent.click(allow());
    expect(answer).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(ALLOW_DELAY_MS - 1); });
    expect(isDisabled(allow())).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(isDisabled(allow())).toBe(false);
  });

  it('Allow and Deny answer the card by its id', async () => {
    render(<PhoneConfirmList confirms={[view({ cardId: 'c-9' })]} />);
    act(() => { vi.advanceTimersByTime(ALLOW_DELAY_MS); });
    await act(async () => { fireEvent.click(allow()); });
    expect(answer).toHaveBeenCalledWith('c-9', 'allow');
    cleanup();
    render(<PhoneConfirmList confirms={[view({ cardId: 'c-9' })]} />);
    await act(async () => { fireEvent.click(deny()); });
    expect(answer).toHaveBeenLastCalledWith('c-9', 'deny');
  });

  it('a failed answer says so and puts the buttons back', async () => {
    answer.mockResolvedValue('failed');
    render(<PhoneConfirmList confirms={[view()]} />);
    act(() => { vi.advanceTimersByTime(ALLOW_DELAY_MS); });
    await act(async () => { fireEvent.click(deny()); });
    expect(screen.getByRole('alert')).toHaveTextContent('could not be delivered');
    expect(isDisabled(deny())).toBe(false);
    expect(isDisabled(allow())).toBe(false);
  });

  it('nothing has focus after a card appears', () => {
    render(<PhoneConfirmList confirms={[view({ detail: 'text' })]} />);
    act(() => { vi.advanceTimersByTime(ALLOW_DELAY_MS); });
    expect(document.activeElement).toBe(document.body);
  });

  it('counts down and hides at expiry', () => {
    const onExpired = vi.fn();
    render(<PhoneConfirmList confirms={[view({ expiresAt: NOW + 3_000 })]} onExpired={onExpired} />);
    expect(screen.getByText('expires in 0:03')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByText('expires in 0:01')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.queryByTestId('phone-confirm-card')).toBeNull();
    expect(onExpired).toHaveBeenCalled();
  });

  it('a phone whose clock is off from the Mac’s counts the card’s own time down, and hides it then (D-9)', () => {
    const onExpired = vi.fn();
    // The phone is 10 minutes behind the Mac; the card (Mac clock) has 2:05 to live.
    vi.setSystemTime(NOW - 600_000);
    usePhoneConfirmStore.getState().apply(view());
    const held = usePhoneConfirmStore.getState().confirms;
    render(<PhoneConfirmList confirms={held} onExpired={onExpired} />);
    expect(screen.getByText('expires in 2:05')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(125_000); });
    expect(screen.queryByTestId('phone-confirm-card')).toBeNull();
    expect(onExpired).toHaveBeenCalled();
  });

  it('a newer card goes after the older one, so the older buttons stay put', () => {
    render(<PhoneConfirmList confirms={[view({ cardId: 'a', summary: 'first' }), view({ cardId: 'b', summary: 'second' })]} />);
    const cards = screen.getAllByTestId('phone-confirm-card');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
      'A central asks: first',
      'A central asks: second',
    ]);
  });

  it('a card exports as a single article', () => {
    render(<PhoneConfirmCard confirm={view()} now={NOW} />);
    expect(screen.getByRole('article')).toBeInTheDocument();
  });

  it('draws nothing for an empty list', () => {
    const { container } = render(<PhoneConfirmList confirms={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

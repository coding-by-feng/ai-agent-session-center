/**
 * The prompt queue on a phone (AASC-18).
 *
 * `useIsMobile()` is pinned per test. What is pinned here is the phone's
 * contract, not its pixels: the QUEUE tab never folds, every row carries its
 * controls (no hover reveal), DEL asks first, MOVE is a sheet, a press and hold
 * reorders — with real touch pointer moves — and a quick swipe does not.
 * The pixels are checked in the phone harness (scratch/phone-harness).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import QueueTab from './QueueTab';
import { HOLD_MS } from '@/hooks/useQueueDragReorder';
import { useQueueStore, type QueueItem } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { Session } from '@/types';

vi.mock('@/lib/terminalSend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/terminalSend')>()),
  sendPromptToTerminal: vi.fn(async () => true),
}));

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));

// The editor and the history sheet have their own suites.
vi.mock('./QueueItemEditModal', () => ({ default: () => null }));
vi.mock('./QueueHistorySheet', () => ({ default: () => null }));
vi.mock('./LoopExcludeWindowsModal', () => ({ default: () => null }));

const item = (id: number, text: string, position: number): QueueItem => ({
  id, sessionId: 's1', text, position, createdAt: position,
});

function seed(texts: string[]) {
  useQueueStore.setState({
    queues: new Map([['s1', texts.map((t, i) => item(i + 1, t, i))]]),
    automation: new Map(),
    composeDrafts: new Map(),
  });
}

const order = () => (useQueueStore.getState().queues.get('s1') ?? []).map((i) => i.text);
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-queue-item]'));
const renderTab = () => render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" fullHeight />);

beforeEach(() => {
  platform.isMobile = true;
  useUiStore.setState({ queuePanelCollapsed: true });
  useSessionStore.setState({
    sessions: new Map([
      ['s1', { sessionId: 's1', title: 'AASC', projectName: 'agent-manager', status: 'waiting' } as unknown as Session],
      ['s2', { sessionId: 's2', title: 'Exmouth 3D', projectName: 'exmouth', status: 'idle' } as unknown as Session],
    ]),
    selectedSessionId: 's1',
  });
  seed(['first', 'second', 'third']);
});

describe('QueueTab on a phone — the QUEUE tab is the queue', () => {
  it('is never folded, whatever the docked strip\'s stored flag says, and its header is a label', () => {
    renderTab();
    const root = document.querySelector('[data-queue-panel]') as HTMLElement;
    expect(root.className).not.toMatch(/collapsed/);
    expect(root.className).toMatch(/queuePanelPhone/);
    expect(screen.queryByRole('button', { name: /^▶?\s*QUEUE/ })).toBeNull();
    for (const name of [/Collapse the queue/, /Expand the queue/, /Detach Queue/, /Switch to (card|list) view/]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.getByPlaceholderText(/Add a prompt to the queue/)).toBeInTheDocument();
  });

  it('Auto-Enter and Auto-send are labelled switches that say their state', async () => {
    renderTab();
    const autoEnter = screen.getByRole('button', { name: /Auto-Enter/ });
    expect(autoEnter).toHaveAttribute('aria-pressed', 'true');
    expect(autoEnter).toHaveTextContent(/Auto-Enter\s*on/i);
    await userEvent.setup().click(autoEnter);
    expect(useQueueStore.getState().automation.get('s1')?.autoEnter).toBe(false);
    expect(screen.getByRole('button', { name: /Auto-Enter/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /Auto-Enter/ })).toHaveTextContent(/off/i);
    expect(screen.getByRole('button', { name: /Auto-send/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('every row carries SEND, EDIT, MOVE, DEL and More; ▲ ▼ ★ live in the More sheet', () => {
    renderTab();
    const first = within(rows()[0]);
    for (const name of [/^SEND$/, /^EDIT$/, /^MOVE$/, /Delete prompt 1/, /More for prompt 1/]) {
      expect(first.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(first.queryByRole('button', { name: 'Move up' })).toBeNull();
    expect(first.queryByRole('button', { name: 'Toggle favorite' })).toBeNull();
  });
});

describe('QueueTab on a phone — DEL asks first', () => {
  it('Cancel keeps the prompt; Delete removes it', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(within(rows()[1]).getByRole('button', { name: /Delete prompt 2/ }));
    const sheet = screen.getByRole('dialog', { name: 'Delete prompt 2?' });
    expect(within(sheet).getByText('second')).toBeInTheDocument();
    expect(order()).toEqual(['first', 'second', 'third']);

    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(order()).toEqual(['first', 'second', 'third']);

    await user.click(within(rows()[1]).getByRole('button', { name: /Delete prompt 2/ }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(order()).toEqual(['first', 'third']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('QueueTab on a phone — More and MOVE are sheets', () => {
  it('More moves a prompt up, and to the top, staying open on it', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(within(rows()[2]).getByRole('button', { name: /More for prompt 3/ }));
    const sheet = screen.getByRole('dialog', { name: 'Prompt 3' });
    await user.click(within(sheet).getByRole('button', { name: /Move up/ }));
    expect(order()).toEqual(['first', 'third', 'second']);
    // The sheet follows the prompt to its new place.
    expect(screen.getByRole('dialog', { name: 'Prompt 2' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Move to top/ }));
    expect(order()).toEqual(['third', 'first', 'second']);
    expect(screen.getByRole('button', { name: /Move up/ })).toBeDisabled();
  });

  it('MOVE lists the other sessions in a sheet; picking one moves the prompt there', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(within(rows()[0]).getByRole('button', { name: /^MOVE$/ }));
    const sheet = screen.getByRole('dialog', { name: 'Move to another session' });
    expect(within(sheet).queryByText('agent-manager')).toBeNull(); // not its own session
    await user.click(within(sheet).getByRole('button', { name: /exmouth/ }));
    expect(order()).toEqual(['second', 'third']);
    expect(useQueueStore.getState().queues.get('s2')?.map((i) => i.text)).toEqual(['first']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/**
 * The gesture inside the real QueueTab, with the rows given real boxes (jsdom has
 * no layout): 80px rows, 8px apart. Pointer events carry pointerType 'touch' and
 * the finger's touchmove is dispatched on the row, as a browser does.
 */
describe('QueueTab on a phone — press and hold to reorder', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const i = rows().indexOf(this);
      const top = i < 0 ? 0 : i * 88;
      return { left: 0, right: 340, top, bottom: top + 80, width: 340, height: i < 0 ? 0 : 80, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
  });
  afterEach(() => {
    rectSpy.mockRestore();
    vi.useRealTimers();
  });

  const textOf = (row: HTMLElement) => row.querySelector('[data-expanded]') as HTMLElement;
  const down = (el: Element, y: number) =>
    fireEvent.pointerDown(el, { clientX: 200, clientY: y, button: 0, pointerType: 'touch' });
  const finger = (el: Element, y: number) => {
    const tm = new Event('touchmove', { bubbles: true, cancelable: true });
    fireEvent(el, tm);
    fireEvent(window, new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent(
      'pointermove', { clientX: 200, clientY: y, bubbles: true, cancelable: true },
    ));
    return tm;
  };
  const up = () => fireEvent(window, new Event('pointerup', { bubbles: true }));

  it('a hold on the third prompt, dragged to the top, makes it the first', () => {
    renderTab();
    const third = rows()[2];
    down(textOf(third), 200);
    act(() => { vi.advanceTimersByTime(HOLD_MS + 10); });
    expect(rows()[2].className).toMatch(/dragging/);
    const moves: Event[] = [];
    act(() => { for (let y = 190; y >= 10; y -= 20) moves.push(finger(third, y)); });
    expect(moves.every((m) => m.defaultPrevented)).toBe(true); // the list does not scroll away
    act(() => { up(); });
    expect(order()).toEqual(['third', 'first', 'second']);
  });

  it('a quick swipe that starts on a prompt scrolls: nothing is cancelled, nothing moves', () => {
    renderTab();
    const third = rows()[2];
    down(textOf(third), 200);
    const moves: Event[] = [];
    act(() => { for (let i = 1; i <= 6; i++) moves.push(finger(third, 200 - i * 15)); });
    act(() => { vi.advanceTimersByTime(HOLD_MS * 2); });
    act(() => { up(); });
    expect(moves.some((m) => m.defaultPrevented)).toBe(false);
    expect(rows()[2].className).not.toMatch(/dragging/);
    expect(order()).toEqual(['first', 'second', 'third']);
  });

  it('a press on a row\'s button is a tap, never a drag', () => {
    renderTab();
    down(within(rows()[0]).getByRole('button', { name: /^EDIT$/ }), 40);
    act(() => { vi.advanceTimersByTime(HOLD_MS * 2); });
    expect(rows()[0].className).not.toMatch(/dragging/);
  });
});

describe('QueueTab on a desktop is unchanged', () => {
  it('keeps the hover row (▲ ▼ ★, DEL removes at once, no More) and the collapse button', async () => {
    platform.isMobile = false;
    useUiStore.setState({ queuePanelCollapsed: false });
    renderTab();
    const first = within(rows()[0]);
    expect(first.getByRole('button', { name: 'Move up' })).toBeInTheDocument();
    expect(first.getByRole('button', { name: 'Toggle favorite' })).toBeInTheDocument();
    expect(first.queryByRole('button', { name: /More for prompt/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse the queue' })).toBeInTheDocument();
    await userEvent.setup().click(first.getByRole('button', { name: 'DEL' }));
    expect(order()).toEqual(['second', 'third']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/** The touch-action split lives in CSS, where no type check reaches it. */
describe('Terminal.module.css — the phone rows hand a swipe to the browser', () => {
  const css = readFileSync(resolve(__dirname, '../../styles/modules/Terminal.module.css'), 'utf8');
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };
  it('phone rows are pan-y; desktop rows stay none', () => {
    expect(rule('.queuePanelPhone .queueItem')).toMatch(/touch-action:\s*pan-y/);
    expect(rule('.queueItem,\n.queueCard')).toMatch(/touch-action:\s*none/);
  });
  it('phone rows show their actions without hover', () => {
    expect(css).toMatch(/\.queuePanelPhone \.queueItem \.queueActions,\s*\n\.queuePanelPhone \.queueItem:hover \.queueActions \{\s*\n\s*display: flex;/);
  });
});

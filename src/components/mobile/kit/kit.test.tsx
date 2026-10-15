// kit.test.tsx — the phone UI kit's controls and their states (AASC-38): default,
// disabled with a reason (still focusable, reason announced, tap ignored), loading,
// toggles, keyboard paths for every gesture, and the pure geometry behind the
// sheet's detents and the long-press menu's placement.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Banner,
  Button,
  Chip,
  ConfirmSheet,
  ContextMenu,
  EmptyState,
  ListRow,
  ListSection,
  NavBar,
  SegmentedControl,
  Sheet,
  StatusRing,
  SwipeRow,
} from '.';
import { DRAG_THRESHOLD_PX, nextDetent } from './sheetDetents';
import { LONG_PRESS_MS, clampMenuPosition } from './menuPosition';

afterEach(() => {
  vi.useRealTimers();
});

describe('Button', () => {
  it('runs its action', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Send</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('stays focusable when disabled, says why, and ignores the tap', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick} disabledReason="Your Mac is driving">Send</Button>);
    const button = screen.getByRole('button', { name: 'Send' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(button).toHaveAccessibleDescription('Your Mac is driving');
    expect(screen.getByText('Your Mac is driving')).toBeVisible();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows it is busy while loading and ignores taps', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick} loading loadingLabel="Sending…">Send</Button>);
    const button = screen.getByRole('button', { name: 'Sending…' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('ListSection / ListRow', () => {
  it('names the group by its header and draws rows as list items', () => {
    render(
      <ListSection header="Library">
        <ListRow title="History" chevron onClick={() => {}} />
        <ListRow title="Version" value="2.10" />
      </ListSection>,
    );
    const group = screen.getByRole('region', { name: 'Library' });
    expect(within(group).getAllByRole('listitem')).toHaveLength(2);
    expect(within(group).getByRole('button', { name: /History/ })).toBeTruthy();
    expect(within(group).getByText('2.10')).toBeTruthy();
  });

  it('makes a toggle row one switch', async () => {
    const onChange = vi.fn();
    render(<ul><ListRow title="New design" toggle={{ checked: false, onChange }} /></ul>);
    const sw = screen.getByRole('switch', { name: /New design/ });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('keeps a disabled row focusable with its reason in place of the subtitle', async () => {
    const onClick = vi.fn();
    render(<ul><ListRow title="Unpair" subtitle="hidden" disabledReason="Only from the Mac" onClick={onClick} /></ul>);
    const row = screen.getByRole('button', { name: /Unpair/ });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row).toHaveAccessibleDescription('Only from the Mac');
    expect(screen.queryByText('hidden')).toBeNull();
    await userEvent.click(row);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('SegmentedControl', () => {
  const segments = [
    { value: 'chat', label: 'Chat' },
    { value: 'changes', label: 'Changes', disabledReason: 'Nothing changed yet' },
    { value: 'terminal', label: 'Terminal' },
  ] as const;

  it('is a tab list with one selected segment in the Tab order', () => {
    render(<SegmentedControl segments={segments} value="chat" onChange={() => {}} label="Session view" />);
    const tabs = within(screen.getByRole('tablist', { name: 'Session view' })).getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it('moves with the arrow keys, skipping a disabled segment', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl segments={segments} value="chat" onChange={onChange} label="Session view" />);
    screen.getByRole('tab', { name: 'Chat' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('terminal');
  });

  it('says why a segment is off and ignores a tap on it', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl segments={segments} value="chat" onChange={onChange} label="Session view" />);
    const off = screen.getByRole('tab', { name: 'Changes' });
    expect(off).toHaveAccessibleDescription('Nothing changed yet');
    await userEvent.click(off);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Sheet', () => {
  it('is a dialog that closes on Escape, the close button and the backdrop', async () => {
    const onClose = vi.fn();
    render(<Sheet open onClose={onClose} title="New session"><button type="button">Claude</button></Sheet>);
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Claude' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByTestId('kit-sheet-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('keeps focus where it is when its parent re-renders with a new onClose', async () => {
    // A session update re-renders the composer every hook; an inline onClose is new
    // each time. The search field being typed into must keep its focus.
    const first = vi.fn();
    const body = (onClose: () => void) => (
      <Sheet open onClose={onClose} title="Commands">
        <button type="button">Top</button>
        <input aria-label="Search" />
      </Sheet>
    );
    const { rerender } = render(<><button type="button">Opener</button>{body(first)}</>);
    const search = screen.getByRole('textbox', { name: 'Search' });
    act(() => search.focus());
    const latest = vi.fn();
    rerender(<><button type="button">Opener</button>{body(latest)}</>);
    expect(search).toHaveFocus();
    // And the newest onClose is the one Escape calls.
    await userEvent.keyboard('{Escape}');
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('renders nothing while closed', () => {
    render(<Sheet open={false} onClose={() => {}} title="Hidden">x</Sheet>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens at its first detent', () => {
    render(<Sheet open onClose={() => {}} title="S" detents={['medium', 'large']}>x</Sheet>);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-detent', 'medium');
  });

  it('rests at the next detent after a drag (pure)', () => {
    const both = ['medium', 'large'] as const;
    expect(nextDetent(both, 'medium', -(DRAG_THRESHOLD_PX + 1), 0)).toBe('large');
    expect(nextDetent(both, 'large', DRAG_THRESHOLD_PX + 1, 0)).toBe('medium');
    expect(nextDetent(both, 'medium', DRAG_THRESHOLD_PX + 1, 0)).toBe('close');
    expect(nextDetent(both, 'large', 10, 2)).toBe('close'); // a hard flick closes from anywhere
    expect(nextDetent(both, 'medium', 20, 0)).toBe('medium'); // too small: springs back
    expect(nextDetent(['fit'], 'fit', -200, 0)).toBe('fit');
  });
});

describe('ConfirmSheet', () => {
  it('offers Cancel and the action, the action busy while it runs', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmSheet open title="Kill it?" message="It stops." confirmLabel="Kill" danger onConfirm={onConfirm} onCancel={onCancel} />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Kill it?' });
    const buttons = within(dialog).getAllByRole('button').filter((b) => b.textContent !== '');
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Kill']);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Kill' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    rerender(<ConfirmSheet open title="Kill it?" message="It stops." confirmLabel="Kill" danger busy onConfirm={onConfirm} onCancel={onCancel} />);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Kill' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('Chip, StatusRing, Banner, EmptyState, NavBar', () => {
  it('a filter chip is a toggle button', async () => {
    const onClick = vi.fn();
    render(<Chip label="Needs you" count={3} selected={false} onClick={onClick} />);
    const chip = screen.getByRole('button', { name: /Needs you 3/ });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(chip);
    expect(onClick).toHaveBeenCalled();
  });

  it('a status ring says the status in words', () => {
    render(<><StatusRing status="approval" /><StatusRing status="waiting" interrupted /></>);
    expect(screen.getByRole('img', { name: 'Waiting for approval' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Interrupted' })).toBeTruthy();
  });

  it('an error banner is announced at once, the rest politely', () => {
    render(<><Banner tone="error" title="Refused" /><Banner tone="offline" title="Reconnecting" /></>);
    expect(screen.getByRole('alert')).toHaveTextContent('Refused');
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting');
  });

  it('an empty state can carry its way forward', () => {
    render(<EmptyState title="Nothing needs you" action={<Button>Refresh</Button>} />);
    expect(screen.getByText('Nothing needs you')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });

  it('a compact nav bar names the screen and goes back', async () => {
    const onBack = vi.fn();
    render(<NavBar title="agent-manager-2" subtitle="Working" onBack={onBack} backLabel="Back to Sessions" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('agent-manager-2');
    await userEvent.click(screen.getByRole('button', { name: 'Back to Sessions' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('a large nav bar leaves the heading to the screen (its copy is hidden)', () => {
    render(<NavBar title="Sessions" large />);
    expect(screen.queryByRole('heading')).toBeNull();
  });
});

describe('ContextMenu', () => {
  const items = (onRename = vi.fn()) => [
    { id: 'rename', label: 'Rename', onSelect: onRename },
    { id: 'pin', label: 'Pin', disabledReason: 'Only your Mac can pin', onSelect: vi.fn() },
  ];

  it('opens on contextmenu, runs an item and closes', async () => {
    const onRename = vi.fn();
    render(<ContextMenu items={items(onRename)} label="Actions"><button type="button">Row</button></ContextMenu>);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Row' }), { clientX: 10, clientY: 10 });
    const menu = screen.getByRole('menu', { name: 'Actions' });
    expect(within(menu).getByRole('menuitem', { name: /Pin/ })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }));
    expect(onRename).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens from the keyboard and closes on Escape, focus back on the row', async () => {
    render(<ContextMenu items={items()} label="Actions"><button type="button">Row</button></ContextMenu>);
    const row = screen.getByRole('button', { name: 'Row' });
    row.focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(row).toHaveFocus();
  });

  it('opens on a touch hold, and the hold does not also tap the row', () => {
    vi.useFakeTimers();
    const onTap = vi.fn();
    render(<ContextMenu items={items()} label="Actions"><button type="button" onClick={onTap}>Row</button></ContextMenu>);
    const row = screen.getByRole('button', { name: 'Row' });
    fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 20, clientY: 20 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(row);
    expect(onTap).not.toHaveBeenCalled();
  });

  it('does not open when the finger moves first (a scroll)', () => {
    vi.useFakeTimers();
    render(<ContextMenu items={items()} label="Actions"><button type="button">Row</button></ContextMenu>);
    const row = screen.getByRole('button', { name: 'Row' });
    fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 20, clientY: 20 });
    fireEvent.pointerMove(row, { pointerType: 'touch', clientX: 20, clientY: 60 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('ignores the click a hold’s release lands on an item, until a fresh press in the menu', () => {
    vi.useFakeTimers();
    const onRename = vi.fn();
    render(<ContextMenu items={items(onRename)} label="Actions"><button type="button">Row</button></ContextMenu>);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Row' }), { pointerType: 'touch', clientX: 20, clientY: 20 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    const rename = screen.getByRole('menuitem', { name: 'Rename' });
    fireEvent.click(rename, { detail: 1 }); // the release, hit-tested on the item (iOS)
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.pointerDown(rename, { pointerType: 'touch' });
    fireEvent.click(rename, { detail: 1 });
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('stays inside the viewport, clear of the finger that opened it (pure)', () => {
    expect(clampMenuPosition(10, 10, 200, 100, 390, 844, 8, 24)).toEqual({ left: 10, top: 34 });
    expect(clampMenuPosition(10, 800, 200, 100, 390, 844, 8, 24).top).toBe(800 - 24 - 100);
    expect(clampMenuPosition(10, 10, 200, 100, 390, 844)).toEqual({ left: 10, top: 10 });
    expect(clampMenuPosition(380, 10, 200, 100, 390, 844).left).toBe(390 - 200 - 8);
    expect(clampMenuPosition(10, 800, 200, 100, 390, 844).top).toBe(700); // flipped above the point
    expect(clampMenuPosition(-50, -50, 200, 100, 390, 844)).toEqual({ left: 8, top: 8 });
  });
});

describe('SwipeRow', () => {
  it('keeps its actions out of reach until the row is swiped open', () => {
    render(
      <SwipeRow actions={[{ id: 'delete', label: 'Delete', tone: 'destructive', onAction: vi.fn() }]}>
        <button type="button">Row</button>
      </SwipeRow>,
    );
    const action = screen.getByText('Delete').closest('button')!;
    expect(action.tabIndex).toBe(-1);
    expect(action.parentElement).toHaveAttribute('aria-hidden', 'true');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, createEvent, within } from '@testing-library/react';
import Menu, { type MenuSection } from './Menu';
import { MENU_VIEWPORT_PAD, placeMenu } from '@/lib/menuPlacement';

// Ported from SessionViewModeMenu.test.tsx (AASC-11): that menu's keyboard and
// focus contract is now every menu's, so it is pinned here once.

const VIEWS = ['Rooms', 'Projects', 'Recent activity'] as const;

function Harness({ initial = 'Rooms', onPick = vi.fn(), withFooter = false }: {
  initial?: string;
  onPick?: (v: string) => void;
  withFooter?: boolean;
}) {
  const [view, setView] = useState(initial);
  const [rooms, setRooms] = useState<Set<string>>(new Set());
  const sections: MenuSection[] = [
    {
      id: 'group',
      title: 'Group',
      items: VIEWS.map((v) => ({
        kind: 'radio' as const,
        id: v,
        label: v,
        checked: v === view,
        onSelect: () => { if (v !== view) { setView(v); onPick(v); } },
      })),
    },
    {
      id: 'rooms',
      title: 'Rooms shown',
      items: ['SMS OPS', 'AASC'].map((r) => ({
        kind: 'checkbox' as const,
        id: r,
        label: r,
        checked: rooms.has(r),
        onSelect: () => setRooms((prev) => { const n = new Set(prev); if (n.has(r)) n.delete(r); else n.add(r); return n; }),
      })),
    },
  ];
  return (
    <div>
      <Menu
        label="View"
        triggerLabel={`View: ${view}`}
        triggerText="View"
        active={view !== 'Rooms'}
        sections={sections}
        footer={withFooter ? <p>Status colours</p> : undefined}
      />
      <button type="button">somewhere else</button>
    </div>
  );
}

const trigger = () => screen.getByRole('button', { name: /^View:/ });
const menu = () => screen.getByRole('menu', { name: 'View' });
const radios = () => within(menu()).getAllByRole('menuitemradio');

describe('Menu — the trigger', () => {
  it('announces that it opens a menu, closed to begin with', () => {
    render(<Harness />);
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows its visible text and is lit only for a non-default choice', () => {
    const { unmount } = render(<Harness />);
    expect(trigger()).toHaveTextContent('View');
    expect(trigger().className).not.toMatch(/triggerActive/);
    unmount();
    render(<Harness initial="Projects" />);
    expect(trigger().className).toMatch(/triggerActive/);
  });
});

describe('Menu — the list', () => {
  it('portals to <body>, so no scroller or transformed ancestor can clip it', () => {
    const { container } = render(<Harness />);
    fireEvent.click(trigger());
    expect(container.contains(menu())).toBe(false);
    expect(document.body.contains(menu())).toBe(true);
  });

  it('groups items under captions that name each group', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    expect(within(menu()).getByRole('group', { name: 'Group' })).toBeInTheDocument();
    expect(within(menu()).getByRole('group', { name: 'Rooms shown' })).toBeInTheDocument();
  });

  it('ticks the current radio and reports a new pick, closing and refocusing the trigger', () => {
    const onPick = vi.fn();
    render(<Harness initial="Projects" onPick={onPick} />);
    fireEvent.click(trigger());
    expect(radios().map((el) => el.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    fireEvent.click(radios()[2]);
    expect(onPick).toHaveBeenCalledWith('Recent activity');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('keeps itself open for checkbox items, so several can be ticked', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const [sms, aasc] = within(menu()).getAllByRole('menuitemcheckbox');
    fireEvent.click(sms);
    fireEvent.click(aasc);
    expect(menu()).toBeInTheDocument();
    expect(within(menu()).getAllByRole('menuitemcheckbox').map((el) => el.getAttribute('aria-checked'))).toEqual(['true', 'true']);
  });

  it('puts the footer in the popover but outside role="menu"', () => {
    render(<Harness withFooter />);
    fireEvent.click(trigger());
    const footer = screen.getByText('Status colours');
    expect(menu().contains(footer)).toBe(false);
    expect(footer.closest('[data-menu-popover]')).not.toBeNull();
  });

  it('closes on a second click of the trigger, and on a click anywhere else', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('stays open for a click inside it that picks nothing', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.mouseDown(menu());
    expect(menu()).toBeInTheDocument();
  });
});

describe('Menu — keyboard', () => {
  it('opens on the checked item, and ArrowDown / ArrowUp step through the items, wrapping', () => {
    render(<Harness initial="Projects" />);
    fireEvent.click(trigger());
    const all = () => [...menu().querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    expect(all()[1]).toHaveFocus();
    fireEvent.keyDown(menu(), { key: 'ArrowUp' });
    expect(all()[0]).toHaveFocus();
    fireEvent.keyDown(menu(), { key: 'ArrowUp' });
    expect(all().at(-1)).toHaveFocus();
    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(all()[0]).toHaveFocus();
  });

  it('Home and End jump to the first and last item, without scrolling the page', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const all = () => [...menu().querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    const end = createEvent.keyDown(menu(), { key: 'End' });
    fireEvent(menu(), end);
    expect(end.defaultPrevented).toBe(true);
    expect(all().at(-1)).toHaveFocus();
    fireEvent.keyDown(menu(), { key: 'Home' });
    expect(all()[0]).toHaveFocus();
  });

  it('keeps its items out of the Tab order', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    for (const el of [...menu().querySelectorAll<HTMLElement>('[role^="menuitem"]')]) expect(el).toHaveAttribute('tabindex', '-1');
  });

  it('closes on Escape, hands focus back, and keeps that Escape from the panel behind it', () => {
    const panelEscape = vi.fn();
    document.addEventListener('keydown', panelEscape);
    try {
      render(<Harness />);
      fireEvent.click(trigger());
      fireEvent.keyDown(menu(), { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(trigger()).toHaveFocus();
      expect(panelEscape).not.toHaveBeenCalled();
      // With the menu shut, Escape is not ours to swallow.
      fireEvent.keyDown(trigger(), { key: 'Escape' });
      expect(panelEscape).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', panelEscape);
    }
  });

  it('ignores the arrow keys while closed', () => {
    render(<Harness />);
    const event = createEvent.keyDown(trigger(), { key: 'ArrowDown' });
    fireEvent(trigger(), event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('closes when Tab moves focus to another control, but not between its own parts or on a lost focus', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const [first, second] = radios();
    fireEvent.blur(first, { relatedTarget: second });
    fireEvent.blur(second, { relatedTarget: trigger() });
    fireEvent.blur(second, { relatedTarget: null });
    expect(menu()).toBeInTheDocument();
    fireEvent.blur(second, { relatedTarget: screen.getByRole('button', { name: 'somewhere else' }) });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('placeMenu — staying inside the viewport', () => {
  const vp = { width: 1000, height: 800 };
  const trig = (left: number, top: number, w = 60, h = 24) => ({ left, top, right: left + w, bottom: top + h });

  it('sits under the trigger, lined up with its start edge', () => {
    expect(placeMenu(trig(100, 100), { width: 200, height: 300 }, vp)).toEqual({ top: 128, left: 100, maxHeight: 800 - 124 - 4 - MENU_VIEWPORT_PAD });
  });

  it('flips above when there is no room below and more above', () => {
    const p = placeMenu(trig(100, 700), { width: 200, height: 300 }, vp);
    expect(p.top + 300).toBe(700 - 4);
  });

  it('is pulled back inside the right edge (a trigger near the edge)', () => {
    const p = placeMenu(trig(950, 100), { width: 200, height: 100 }, vp);
    expect(p.left).toBe(1000 - 200 - MENU_VIEWPORT_PAD);
  });

  it('is pulled back inside the left edge when lined up with the end of a trigger near it', () => {
    const p = placeMenu(trig(10, 100), { width: 200, height: 100 }, vp, 'end');
    expect(p.left).toBe(MENU_VIEWPORT_PAD);
  });

  it('scrolls in the room it has when it is taller than either side', () => {
    const p = placeMenu(trig(100, 380), { width: 200, height: 2000 }, vp);
    expect(p.maxHeight).toBe(800 - 404 - 4 - MENU_VIEWPORT_PAD);
    expect(p.top).toBe(408);
  });
});

// Code review of AASC-11 (HIGH + MEDIUM findings).
describe('Menu — review fixes', () => {
  const pop = () => document.querySelector<HTMLElement>('[data-menu-popover]')!;

  it('keeps its height cap through page scrolls (place() used to clear it on the DOM node, and React never wrote it back)', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const cap = pop().style.maxHeight;
    expect(cap).not.toBe('');
    fireEvent.scroll(window);
    fireEvent.scroll(document.body);
    expect(pop().style.maxHeight).toBe(cap);
  });

  it('ignores scrolls from inside itself, so scrolling the list never re-places it', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const measure = vi.spyOn(trigger(), 'getBoundingClientRect');
    fireEvent.scroll(pop());
    expect(measure).not.toHaveBeenCalled();
    fireEvent.scroll(window);
    expect(measure).toHaveBeenCalled();
  });

  it('closes on Escape even when a click left focus on <body>, and the panel behind never hears it', () => {
    const panelEscape = vi.fn();
    window.addEventListener('keydown', panelEscape);
    try {
      render(<Harness />);
      fireEvent.click(trigger());
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(panelEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', panelEscape);
    }
  });

  it('is focusable itself, so a click on a caption keeps focus inside it', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    expect(pop()).toHaveAttribute('tabindex', '-1');
  });

  it('Tab out of the list goes on from the trigger (the list is portaled to the end of <body>)', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(trigger()).toHaveFocus();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

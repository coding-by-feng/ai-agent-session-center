import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, createEvent, within } from '@testing-library/react';

import SessionViewModeMenu from './SessionViewModeMenu';
import { useDropdownFlipX } from '@/hooks/useDropdownFlipX';
import type { SessionSortMode } from '@/stores/uiStore';

// The viewport-edge guard is a hook with its own tests; what this menu owes is calling it with its own
// open state and element (the repo's rule for any new dropdown), so the hook is stubbed to observe that.
vi.mock('@/hooks/useDropdownFlipX', () => ({ useDropdownFlipX: vi.fn() }));

const trigger = (name: RegExp | string = /^Session view:/) => screen.getByRole('button', { name });
const menu = () => screen.getByRole('menu', { name: 'Session view' });
const items = () => within(menu()).getAllByRole('menuitemradio');

function setup(mode: SessionSortMode = 'room') {
  const onChange = vi.fn();
  const utils = render(<SessionViewModeMenu mode={mode} onChange={onChange} />);
  return { onChange, ...utils };
}

describe('SessionViewModeMenu', () => {
  beforeEach(() => {
    vi.mocked(useDropdownFlipX).mockClear();
  });

  describe('the button', () => {
    it.each([
      ['room', 'Session view: Rooms'],
      ['project', 'Session view: Projects'],
      ['activity', 'Session view: Recent activity'],
    ] as const)('says the current view when it is %s', (mode, name) => {
      setup(mode);
      expect(trigger()).toHaveAccessibleName(name);
    });

    it('announces that it opens a menu, closed to begin with', () => {
      setup();
      expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
      expect(trigger()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('is lit when the view is anything but the default rooms', () => {
      const { rerender } = setup('room');
      expect(trigger().className).not.toMatch(/roomFilterActive/);
      rerender(<SessionViewModeMenu mode="project" onChange={vi.fn()} />);
      expect(trigger().className).toMatch(/roomFilterActive/);
      rerender(<SessionViewModeMenu mode="activity" onChange={vi.fn()} />);
      expect(trigger().className).toMatch(/roomFilterActive/);
    });
  });

  describe('the menu', () => {
    it('lists the three views and ticks the current one', () => {
      setup('project');
      fireEvent.click(trigger());
      expect(trigger()).toHaveAttribute('aria-expanded', 'true');
      expect(items().map((el) => el.textContent?.trim())).toEqual(['Rooms', 'Projects', 'Recent activity']);
      expect(items().map((el) => el.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    });

    it.each([
      ['Projects', 'project'],
      ['Recent activity', 'activity'],
    ] as const)('switching to %s reports it and closes', (label, mode) => {
      const { onChange } = setup('room');
      fireEvent.click(trigger());
      fireEvent.click(within(menu()).getByRole('menuitemradio', { name: label }));
      expect(onChange).toHaveBeenCalledExactlyOnceWith(mode);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('can go back to rooms', () => {
      const { onChange } = setup('project');
      fireEvent.click(trigger());
      fireEvent.click(within(menu()).getByRole('menuitemradio', { name: 'Rooms' }));
      expect(onChange).toHaveBeenCalledExactlyOnceWith('room');
    });

    it('closes without reporting anything when the view you are already in is chosen', () => {
      const { onChange } = setup('project');
      fireEvent.click(trigger());
      fireEvent.click(within(menu()).getByRole('menuitemradio', { name: 'Projects' }));
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('closes on a second click of the button', () => {
      setup();
      fireEvent.click(trigger());
      fireEvent.click(trigger());
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('closes on a click anywhere else', () => {
      setup();
      fireEvent.click(trigger());
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('stays open for a click inside it that picks nothing', () => {
      setup();
      fireEvent.click(trigger());
      fireEvent.mouseDown(menu());
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('closes on Escape and hands focus back to the button', () => {
      setup();
      fireEvent.click(trigger());
      fireEvent.keyDown(menu(), { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(trigger()).toHaveFocus();
    });

    it('keeps the Escape that closes it from also reaching the panel, whose own Escape exits maximize / minimizes', () => {
      const panelEscape = vi.fn();
      document.addEventListener('keydown', panelEscape);
      try {
        setup();
        fireEvent.click(trigger());
        fireEvent.keyDown(menu(), { key: 'Escape' });
        expect(panelEscape).not.toHaveBeenCalled();

        // With the menu shut, Escape is not ours to swallow.
        fireEvent.keyDown(trigger(), { key: 'Escape' });
        expect(panelEscape).toHaveBeenCalledTimes(1);
      } finally {
        document.removeEventListener('keydown', panelEscape);
      }
    });

    it('hands focus back to the button after a choice, instead of dropping it with the option that unmounted', () => {
      setup('room');
      fireEvent.click(trigger());
      fireEvent.click(within(menu()).getByRole('menuitemradio', { name: 'Projects' }));
      expect(trigger()).toHaveFocus();
    });
  });

  // A role="menu" promises arrow-key movement; without it only Tab gets you around.
  describe('keyboard', () => {
    const press = (key: string) => fireEvent.keyDown(document.activeElement ?? menu(), { key });
    const focused = () => document.activeElement?.textContent?.trim();

    it('opens on the current view, and ArrowDown / ArrowUp step through the views', () => {
      setup('project');
      fireEvent.click(trigger());
      expect(focused()).toBe('Projects');
      press('ArrowDown');
      expect(focused()).toBe('Recent activity');
      press('ArrowUp');
      expect(focused()).toBe('Projects');
    });

    it('wraps at both ends', () => {
      setup('room');
      fireEvent.click(trigger());
      expect(focused()).toBe('Rooms');
      press('ArrowUp');
      expect(focused()).toBe('Recent activity');
      press('ArrowDown');
      expect(focused()).toBe('Rooms');
    });

    it('Home and End jump to the first and last view', () => {
      setup('project');
      fireEvent.click(trigger());
      press('End');
      expect(focused()).toBe('Recent activity');
      press('Home');
      expect(focused()).toBe('Rooms');
    });

    it('does not scroll the page with the arrow keys it handles', () => {
      setup();
      fireEvent.click(trigger());
      const event = createEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      fireEvent(document.activeElement!, event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('keeps its items out of the Tab order — the arrow keys are how you move between them', () => {
      setup();
      fireEvent.click(trigger());
      expect(items().map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1']);
    });

    describe('when focus leaves it', () => {
      const withOutsideControl = () => {
        const onChange = vi.fn();
        const utils = render(
          <div>
            <SessionViewModeMenu mode="room" onChange={onChange} />
            <button type="button">somewhere else</button>
          </div>,
        );
        return { onChange, ...utils, elsewhere: screen.getByRole('button', { name: 'somewhere else' }) };
      };

      it('closes when Tab moves it to another control — without this a keyboard user is left with a menu open over the next one', () => {
        const { elsewhere } = withOutsideControl();
        fireEvent.click(trigger());
        fireEvent.blur(document.activeElement!, { relatedTarget: elsewhere });
        expect(screen.queryByRole('menu')).toBeNull();
      });

      it('stays open while focus moves between its own parts', () => {
        withOutsideControl();
        fireEvent.click(trigger());
        const [first, second] = items();
        fireEvent.blur(first, { relatedTarget: second });
        fireEvent.blur(second, { relatedTarget: trigger() });
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      it('stays open when focus is simply lost, which is the outside click handler\'s business (and Safari never focuses a clicked button)', () => {
        withOutsideControl();
        fireEvent.click(trigger());
        fireEvent.blur(document.activeElement!, { relatedTarget: null });
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
    });

    it('ignores the arrow keys while the menu is closed', () => {
      setup();
      const event = createEvent.keyDown(trigger(), { key: 'ArrowDown' });
      fireEvent(trigger(), event);
      expect(event.defaultPrevented).toBe(false);
    });
  });

  describe('viewport edge', () => {
    it('hands the open menu to the edge guard, which keeps it on screen near the window edge', () => {
      setup();
      expect(vi.mocked(useDropdownFlipX).mock.calls.at(-1)?.[0]).toBe(false);
      fireEvent.click(trigger());
      const [open, ref] = vi.mocked(useDropdownFlipX).mock.calls.at(-1)!;
      expect(open).toBe(true);
      expect(ref.current).toBe(menu());
    });
  });
});

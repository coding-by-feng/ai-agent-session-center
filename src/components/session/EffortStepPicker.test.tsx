import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EffortStepPicker from './EffortStepPicker';
import { EFFORT_STEP_LEVELS } from '@/lib/queueEffort';

function mount(props: Partial<React.ComponentProps<typeof EffortStepPicker>> = {}) {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const onPick = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <EffortStepPicker anchor={anchor} onPick={onPick} onClose={onClose} {...props} />,
  );
  return { anchor, onPick, onClose, ...utils };
}

describe('EffortStepPicker', () => {
  it('lists every effort level as a menu item, in order', () => {
    mount();
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');
    expect(items).toHaveLength(EFFORT_STEP_LEVELS.length);
    EFFORT_STEP_LEVELS.forEach((level, i) => expect(items[i]).toContain(level));
  });

  it('is portaled to <body>, outside any scroll box the trigger sits in', () => {
    const { container } = mount();
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('picking a level reports it and closes', () => {
    const { onPick, onClose } = mount();
    fireEvent.click(screen.getByRole('menuitem', { name: /max/ }));
    expect(onPick).toHaveBeenCalledWith('max');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('puts keyboard focus on the first item so the menu is usable without a mouse', () => {
    mount();
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
  });

  it('REGRESSION: asks for focus only once the menu is visible — a browser ignores focus() on a hidden element', () => {
    // jsdom focuses a `visibility: hidden` node happily, so the test has to look at
    // what the menu's style says at the moment focus() is called. In Chromium the
    // first version of this picker never took focus: it asked during the unplaced frame.
    const seen: string[] = [];
    const realFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function patched(this: HTMLElement, ...args: Parameters<HTMLElement['focus']>) {
      const menu = this.closest('[role="menu"]') as HTMLElement | null;
      if (menu) seen.push(menu.style.visibility);
      return realFocus.apply(this, args);
    };
    try {
      mount();
    } finally {
      HTMLElement.prototype.focus = realFocus;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === 'visible')).toBe(true);
  });

  it('moves focus with the arrow keys, wrapping at both ends', () => {
    mount();
    const items = screen.getAllByRole('menuitem');
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: 'ArrowUp' });
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(items[items.length - 1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('Home and End jump to the first and last level', () => {
    mount();
    const items = screen.getAllByRole('menuitem');
    fireEvent.keyDown(items[0], { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(items[items.length - 1], { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('Escape closes without picking and hands focus back to the trigger', () => {
    const { anchor, onPick, onClose } = mount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(anchor);
  });

  it('Tab closes the menu and hands focus back to the trigger, so it never lingers behind the focus', () => {
    const { anchor, onClose } = mount();
    const items = screen.getAllByRole('menuitem');
    fireEvent.keyDown(items[0], { key: 'Tab' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(anchor);
  });

  it('closes on an outside mousedown but ignores one on its own trigger', () => {
    const { anchor, onClose } = mount();
    anchor.setAttribute('data-effort-trigger', 'before');
    fireEvent.mouseDown(anchor);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays hidden until it has been measured, so it never flashes in the top-left corner', () => {
    mount();
    // jsdom has no layout, so the measured position settles on the first pass;
    // what matters is the inline style carries a position at all.
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    expect(menu.style.top).not.toBe('');
    expect(menu.style.left).not.toBe('');
  });
});

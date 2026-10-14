import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ModelStepPicker from './ModelStepPicker';
import { MODEL_STEP_OPTIONS, MODEL_TRIGGER_ATTR } from '@/lib/queueModel';

function mount() {
  const anchor = document.createElement('button');
  anchor.setAttribute(MODEL_TRIGGER_ATTR, 'before');
  document.body.appendChild(anchor);
  const onPick = vi.fn();
  const onClose = vi.fn();
  const utils = render(<ModelStepPicker anchor={anchor} onPick={onPick} onClose={onClose} />);
  return { anchor, onPick, onClose, ...utils };
}

describe('ModelStepPicker', () => {
  it('lists every model as a menu item, in order, inside a menu named for models', () => {
    mount();
    const menu = screen.getByRole('menu', { name: /set model/i });
    const items = screen.getAllByRole('menuitem');
    expect(items.map((el) => el.querySelector('span')?.textContent)).toEqual([...MODEL_STEP_OPTIONS]);
    // Portaled: the positioned box is a direct child of <body>, outside any scroll box.
    expect(menu.parentElement?.parentElement).toBe(document.body);
  });

  it('marks an alias as following the latest model and a full ID as pinned', () => {
    mount();
    expect(screen.getByRole('menuitem', { name: /^opus/ }).textContent).toMatch(/latest/);
    expect(screen.getByRole('menuitem', { name: /claude-opus-4-8/ }).textContent).toMatch(/pinned/);
  });

  it('says a pick is also saved as the default, outside the menu items', () => {
    mount();
    const note = screen.getByText(/default for new sessions/i);
    expect(note.closest('[role="menuitem"]')).toBeNull();
  });

  it('picking a model reports it and closes', () => {
    const { onPick, onClose } = mount();
    fireEvent.click(screen.getByRole('menuitem', { name: /^sonnet/ }));
    expect(onPick).toHaveBeenCalledWith('sonnet');
    expect(onClose).toHaveBeenCalled();
  });

  it('arrow keys wrap over the models only — the note is never a stop', () => {
    mount();
    const items = screen.getAllByRole('menuitem');
    items[0].focus();
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(items[items.length - 1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('closes on an outside mousedown but ignores one on its own trigger', () => {
    const { anchor, onClose } = mount();
    fireEvent.mouseDown(anchor);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape closes without picking and hands focus back to the trigger', () => {
    const { anchor, onPick, onClose } = mount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(anchor);
  });
});

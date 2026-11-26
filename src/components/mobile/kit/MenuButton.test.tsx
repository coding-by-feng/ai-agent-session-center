// MenuButton (Nov 24 2026): a title-bar button whose tap opens the kit's menu (MenuLayer), so a
// screen can fold several icons behind one. ContextMenu shares the same layer for long presses.
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MenuButton from './MenuButton';

const items = (onCall = vi.fn(), onSearch = vi.fn()) => [
  { id: 'call', label: 'Call AASC', onSelect: onCall },
  { id: 'search', label: 'Search', onSelect: onSearch },
];

describe('MenuButton', () => {
  it('is a button that says it opens a menu, closed at first', () => {
    render(<MenuButton label="More actions" menuLabel="Session actions" items={items()} icon={<span>⋯</span>} />);
    const button = screen.getByRole('button', { name: 'More actions' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens on a tap, runs the picked item once and closes, focus back on the button', async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<MenuButton label="More actions" menuLabel="Session actions" items={items(vi.fn(), onSearch)} icon={<span>⋯</span>} />);
    const button = screen.getByRole('button', { name: 'More actions' });
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'Session actions' });
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((i) => i.textContent)).toEqual(['Call AASC', 'Search']);
    await user.click(screen.getByRole('menuitem', { name: 'Search' }));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes on Escape without running anything', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    render(<MenuButton label="More actions" menuLabel="Session actions" items={items(onCall)} icon={<span>⋯</span>} />);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onCall).not.toHaveBeenCalled();
  });

  it('focuses the first item when the keyboard opens it', async () => {
    const user = userEvent.setup();
    render(<MenuButton label="More actions" menuLabel="Session actions" items={items()} icon={<span>⋯</span>} />);
    screen.getByRole('button', { name: 'More actions' }).focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Call AASC' }));
  });

  it('shows pressed while what it opened is on (Search open behind it)', () => {
    render(<MenuButton label="More actions" menuLabel="Session actions" items={items()} icon={<span>⋯</span>} pressed />);
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveAttribute('data-pressed', '');
  });
});

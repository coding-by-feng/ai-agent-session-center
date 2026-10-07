import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import Button from './Button';
import IconButton from './IconButton';

describe('Button', () => {
  it('is a type="button" by default, so it never submits the form it sits in', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button>Refresh</Button>
      </form>,
    );
    const btn = screen.getByRole('button', { name: 'Refresh' });
    expect(btn.getAttribute('type')).toBe('button');
    fireEvent.click(btn);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps an explicit type="submit"', () => {
    render(<Button type="submit">Add task</Button>);
    expect(screen.getByRole('button', { name: 'Add task' }).getAttribute('type')).toBe('submit');
  });

  it('renders aria-pressed only when it is a toggle', () => {
    const { rerender } = render(<Button>Export</Button>);
    expect(screen.getByRole('button', { name: 'Export' }).hasAttribute('aria-pressed')).toBe(false);

    rerender(<Button pressed={false}>Favorites</Button>);
    expect(screen.getByRole('button', { name: 'Favorites' }).getAttribute('aria-pressed')).toBe('false');

    rerender(<Button pressed>Favorites</Button>);
    expect(screen.getByRole('button', { name: 'Favorites' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('puts the icon in its own slot before the label', () => {
    render(<Button icon={<svg data-testid="glyph" />}>Rescan</Button>);
    const btn = screen.getByRole('button', { name: 'Rescan' });
    const icon = screen.getByTestId('glyph').parentElement;
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(btn.firstElementChild).toBe(icon);
  });

  it('forwards clicks and the disabled state', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Retry</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<Button onClick={onClick} disabled>Retry</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('merges a caller class with its own', () => {
    render(<Button className="extra">Go</Button>);
    const cls = screen.getByRole('button', { name: 'Go' }).className;
    expect(cls).toContain('extra');
    expect(cls.split(' ').length).toBeGreaterThan(1);
  });
});

describe('IconButton', () => {
  it('names itself from `label` — the glyph alone has no accessible name', () => {
    render(<IconButton label="Delete task">🗑</IconButton>);
    const btn = screen.getByRole('button', { name: 'Delete task' });
    expect(btn.getAttribute('type')).toBe('button');
  });

  it('reflects a toggle in aria-pressed', () => {
    const { rerender } = render(<IconButton label="Favorite" pressed={false}>☆</IconButton>);
    expect(screen.getByRole('button', { name: 'Favorite' }).getAttribute('aria-pressed')).toBe('false');
    rerender(<IconButton label="Favorite" pressed>★</IconButton>);
    expect(screen.getByRole('button', { name: 'Favorite' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    render(<IconButton label="Copy prompt" onClick={onClick}>⧉</IconButton>);
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

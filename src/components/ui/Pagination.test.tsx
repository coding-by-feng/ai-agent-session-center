import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import Pagination from './Pagination';
import { pageWindow } from '@/lib/pageWindow';

describe('pageWindow', () => {
  it('lists every page when there are few', () => {
    expect(pageWindow(1, 4)).toEqual([1, 2, 3, 4]);
  });

  it('keeps the first and last page and a window around the current one', () => {
    expect(pageWindow(10, 20)).toEqual([1, 'gap', 8, 9, 10, 11, 12, 'gap', 20]);
  });

  it('does not put a gap between neighbours', () => {
    expect(pageWindow(3, 20)).toEqual([1, 2, 3, 4, 5, 'gap', 20]);
    expect(pageWindow(18, 20)).toEqual([1, 'gap', 16, 17, 18, 19, 20]);
  });

  it('shows a lone skipped page instead of a gap that saves nothing', () => {
    expect(pageWindow(5, 20)).toEqual([1, 2, 3, 4, 5, 6, 7, 'gap', 20]);
  });
});

describe('Pagination', () => {
  it('renders nothing for a single page', () => {
    const { container } = render(<Pagination page={1} totalPages={1} onPageChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('disables Previous on the first page and Next on the last', () => {
    const { rerender } = render(<Pagination page={1} totalPages={3} onPageChange={() => {}} />);
    expect((screen.getByRole('button', { name: /Previous/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Next/ }) as HTMLButtonElement).disabled).toBe(false);

    rerender(<Pagination page={3} totalPages={3} onPageChange={() => {}} />);
    expect((screen.getByRole('button', { name: /Next/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('marks the current page and jumps to another', () => {
    const onPageChange = vi.fn();
    render(<Pagination page={2} totalPages={5} onPageChange={onPageChange} />);
    expect(screen.getByRole('button', { name: 'Page 2' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: 'Page 5' }));
    expect(onPageChange).toHaveBeenCalledWith(5);
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('is a named navigation landmark with a plain "page x of y" read-out', () => {
    render(<Pagination page={2} totalPages={5} onPageChange={() => {}} label="Session pages" />);
    const nav = screen.getByRole('navigation', { name: 'Session pages' });
    expect(nav.textContent).toContain('Page 2 of 5');
  });
});

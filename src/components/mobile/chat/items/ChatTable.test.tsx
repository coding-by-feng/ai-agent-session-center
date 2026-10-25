// ChatTable.test.tsx — a Markdown table in the phone chat (Oct 22 2026): cells keep whole words in a capped box,
// a column's alignment survives, and a table that scrolls says so (edge shade, named region in the Tab order).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ChatMarkdown from './ChatMarkdown';

const TABLE = ['| Style | 中文 | Covers |', '| --- | :-: | --- |', '| E1 | 单门（现有） | EE-78, and EE-89 #1? |', '| E2 | 单门 + 一侧玻璃 | EE-80 |'].join('\n');

/** jsdom lays nothing out: give the scroller the widths a phone would. */
function sized(scrollWidth: number, clientWidth: number) {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.tagName === 'DIV' ? scrollWidth : 0; });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.tagName === 'DIV' ? clientWidth : 0; });
}

describe('ChatTable', () => {
  afterEach(() => vi.restoreAllMocks());

  it('puts every cell in a capped box and keeps the column alignment', async () => {
    const { container } = render(<ChatMarkdown text={TABLE} />);
    const cells = container.querySelectorAll('th, td');
    expect(cells).toHaveLength(9);
    for (const c of cells) expect(c.firstElementChild?.className).toMatch(/cell/);
    expect((container.querySelectorAll('td')[1] as HTMLElement).style.textAlign).toBe('center');
    expect(screen.getByText('单门 + 一侧玻璃')).toBeTruthy();
  });

  it('a table that fits is not a scroll stop and shows no shade', async () => {
    sized(300, 300);
    const { container } = render(<ChatMarkdown text={TABLE} />);
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    expect(screen.queryByRole('region', { name: 'Table, scrolls sideways' })).toBeNull();
    expect(container.querySelector('[data-more-end]')).toBeNull();
  });

  it('a wider table is a named, focusable region with a shade on the side that hides more', async () => {
    sized(600, 300);
    const { container } = render(<ChatMarkdown text={TABLE} />);
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    const region = screen.getByRole('region', { name: 'Table, scrolls sideways' });
    expect(region.tabIndex).toBe(0);
    expect(container.querySelector('[data-more-end]')).toBeTruthy();
    expect(container.querySelector('[data-more-start]')).toBeNull();
    region.scrollLeft = 300;
    fireEvent.scroll(region);
    expect(container.querySelector('[data-more-start]')).toBeTruthy();
    expect(container.querySelector('[data-more-end]')).toBeNull();
  });
});

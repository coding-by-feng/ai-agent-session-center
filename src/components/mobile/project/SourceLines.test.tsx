// SourceLines.test.tsx — a long file's line window and find (AASC-56): stepping to
// a hit outside the window brings the window to it, but only when the hit
// changes; "Show earlier / later lines" still pages while find is open.
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SourceLines, { type SourceFind } from './SourceLines';
import { findLineMatches } from '@/lib/codeLines';

vi.mock('./useCodeHighlight', () => ({ useCodeHighlight: () => null }));

const LINES = Array.from({ length: 5000 }, (_, i) => (i === 9 || i === 4499 ? `needle ${i + 1}` : `line ${i + 1}`));
const CONTENT = LINES.join('\n');
const matches = findLineMatches(LINES, 'needle');

function view(find: SourceFind | null) {
  return <SourceLines scrollRef={createRef()} content={CONTENT} fileName="big.log" wrap line={null} query="" find={find} />;
}

const shown = (n: number) => document.querySelector(`[data-line="${n}"]`) !== null;

describe('SourceLines', () => {
  it('brings the window to a find hit outside it', () => {
    const { rerender } = render(view({ matches, index: 0 }));
    expect(shown(10)).toBe(true);
    rerender(view({ matches, index: 1 }));
    expect(shown(4500)).toBe(true);
    expect(document.querySelector('[data-line="4500"] [data-find-current]')?.textContent).toBe('needle');
  });

  it('still pages with "Show later lines" while a hit is current', () => {
    render(view({ matches, index: 0 }));
    expect(shown(2500)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Show later lines/ }));
    expect(shown(2500)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Show later lines/ }));
    expect(shown(4500)).toBe(true);
  });
});

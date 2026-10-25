// SectionTabs.test.tsx — the RESOURCES tab row (Oct 23 2026) keeps the open tab in view at narrow
// widths: again when a count badge loads and widens a tab before it, and by scrolling only the
// strip, never the page (scrollIntoView would scroll every ancestor too).
import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SectionTabs from './SectionTabs';

const scrollIntoView = vi.fn();
beforeEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  vi.restoreAllMocks();
  scrollIntoView.mockReset();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

/** A 358px strip at x 16; the open tab is 78px wide and ends at `tabRight`. */
function layout(list: HTMLElement, tabRight: number) {
  let left = 0;
  Object.defineProperty(list, 'scrollLeft', {
    configurable: true,
    get: () => left,
    set: (v: number) => {
      left = v;
    },
  });
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 16, y: 0, width: 358, height: 32 }),
  );
  const tab = list.querySelector<HTMLElement>('[aria-selected="true"]')!;
  vi.spyOn(tab, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: tabRight - 78, y: 0, width: 78, height: 32 }),
  );
  return () => left;
}

it('scrolls the strip again when a badge pushes the open tab past its edge', () => {
  const { rerender, getByRole } = render(
    <SectionTabs baseId="t" section="health" badges={{}} onSelect={vi.fn()} />,
  );
  const scrolled = layout(getByRole('tablist'), 398);
  rerender(<SectionTabs baseId="t" section="health" badges={{ sync: 5 }} onSelect={vi.fn()} />);
  expect(scrolled()).toBe(24);
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it('brings back an open tab scrolled off the start', () => {
  const { rerender, getByRole } = render(
    <SectionTabs baseId="t" section="library" badges={{}} onSelect={vi.fn()} />,
  );
  const list = getByRole('tablist');
  const scrolled = layout(list, 0);
  list.scrollLeft = 140;
  rerender(<SectionTabs baseId="t" section="library" badges={{ health: 2 }} onSelect={vi.fn()} />);
  // The tab spans -78…0 against a strip that starts at 16: 94px back.
  expect(scrolled()).toBe(46);
  expect(scrollIntoView).not.toHaveBeenCalled();
});

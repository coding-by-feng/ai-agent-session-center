// useHorizontalSwipe.test.ts — where a swipe on the phone's session header may
// start (AASC-18): never in a text field, a [data-no-swipe] control, or outside
// the area (a sheet portaled out of it).
import { describe, it, expect } from 'vitest';
import { ignoresSwipe } from './useHorizontalSwipe';

function area(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('ignoresSwipe', () => {
  it('lets a swipe start on ordinary header content', () => {
    const root = area('<div><span id="t">Title</span></div>');
    expect(ignoresSwipe(root.querySelector('#t'), root)).toBe(false);
  });

  it('ignores text fields and controls marked data-no-swipe', () => {
    const root = area('<input id="i" /><textarea id="a"></textarea><div data-no-swipe><button id="b">x</button></div>');
    expect(ignoresSwipe(root.querySelector('#i'), root)).toBe(true);
    expect(ignoresSwipe(root.querySelector('#a'), root)).toBe(true);
    expect(ignoresSwipe(root.querySelector('#b'), root)).toBe(true);
  });

  it('ignores a touch that did not start inside the area', () => {
    const root = area('<span>in</span>');
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    expect(ignoresSwipe(outside, root)).toBe(true);
    expect(ignoresSwipe(null, root)).toBe(true);
  });
});

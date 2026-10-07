// LiveHintCallout.test.tsx — the tip bubble aims its caret at the NavBar tab
// marked `data-live-tab`. Concrete numbers (not the helper's own output) so a
// broken measurement, or a dropped resize/scroll listener, fails here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import LiveHintCallout from './LiveHintCallout';

const rect = (left: number, width: number) =>
  ({ left, width, right: left + width, top: 0, bottom: 20, height: 20, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

let tabLeft = 150;

beforeEach(() => {
  tabLeft = 150;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.hasAttribute('data-live-tab')) return rect(tabLeft, 60); // centre at tabLeft + 30
    return rect(24, 1000); // the board row the bubble sits in
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('role') === 'note' ? 320 : 0;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderWithTab(withTab = true) {
  render(
    <>
      {withTab && <a data-live-tab="">LIVE</a>}
      <LiveHintCallout onDismiss={() => {}} />
    </>,
  );
  return screen.getByRole('note', { name: /tip/i });
}

describe('LiveHintCallout — aims at the LIVE tab', () => {
  it('puts the caret under the middle of the tab', () => {
    const bubble = renderWithTab();
    // tab centre 180, board from 24: the bubble starts 132px in, caret 24px into it (24 + 132 + 24 = 180)
    expect(bubble.style.getPropertyValue('--hint-left')).toBe('132px');
    expect(bubble.style.getPropertyValue('--caret-x')).toBe('24px');
  });

  it('follows the tab when the window resizes', () => {
    const bubble = renderWithTab();
    tabLeft = 400;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(bubble.style.getPropertyValue('--hint-left')).toBe('382px');
  });

  it('follows the tab when the top bar scrolls sideways (a scroll anywhere, caught on capture)', () => {
    const bubble = renderWithTab();
    tabLeft = 60;
    act(() => { document.dispatchEvent(new Event('scroll')); });
    // tab centre 90: the bubble would start at 42, the caret 24 into it
    expect(bubble.style.getPropertyValue('--hint-left')).toBe('42px');
  });

  it('with no LIVE tab on the page (no top bar) it keeps its default place', () => {
    const bubble = renderWithTab(false);
    expect(bubble.style.getPropertyValue('--hint-left')).toBe('');
    expect(bubble.style.getPropertyValue('--caret-x')).toBe('');
  });
});

// The LIVE tab moves without the bubble or its row changing size: a theme with
// another font re-lays the top bar out, or the tip's dot widens the tab. Found
// in a real render (Command Center at 600px: caret 5px off after a theme
// switch). So the bubble also watches the top bar's items — every child, so
// anything ever placed before LIVE (+ NEW / DIRS used to be) is covered too.
describe('LiveHintCallout — re-aims when the top bar re-lays out', () => {
  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    observed = new Set<Element>();
    constructor(public cb: ResizeObserverCallback) { FakeResizeObserver.instances.push(this); }
    observe(el: Element) { this.observed.add(el); }
    unobserve(el: Element) { this.observed.delete(el); }
    disconnect() { this.observed.clear(); }
    fire() { this.cb([], this as unknown as ResizeObserver); }
  }

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('watches the LIVE tab and what sits before it, and moves the caret when they change', () => {
    render(
      <>
        <nav>
          <div data-testid="before">an item before LIVE</div>
          <a data-live-tab="">LIVE</a>
        </nav>
        <LiveHintCallout onDismiss={() => {}} />
      </>,
    );
    const ro = FakeResizeObserver.instances[0];
    expect(ro.observed.has(screen.getByText('LIVE'))).toBe(true);
    expect(ro.observed.has(screen.getByTestId('before'))).toBe(true);
    tabLeft = 250; // the item before it grew: LIVE moved right, nothing else resized
    act(() => ro.fire());
    expect(screen.getByRole('note', { name: /tip/i }).style.getPropertyValue('--hint-left')).toBe('232px');
  });
});


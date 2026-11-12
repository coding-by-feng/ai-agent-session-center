import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, within, fireEvent } from '@testing-library/react';

import Tooltip, { type TooltipPlacement } from './Tooltip';

/**
 * Only the `content` prop is covered here: a small React body (rows, a bar)
 * under the label, for a tooltip with more to say than a sentence. It is added
 * to the same measured box, so the viewport flip / clamp applies to it unchanged.
 */
describe('Tooltip — rich content', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const open = () => {
    act(() => {
      screen.getByRole('button', { name: 'trigger' }).focus();
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    return screen.getByRole('tooltip');
  };

  it('shows the content under the label when the trigger is focused', () => {
    render(
      <Tooltip label="Usage" content={<ul><li>5-hour 63%</li></ul>}>
        <button>trigger</button>
      </Tooltip>,
    );
    const tip = open();
    expect(within(tip).getByText('Usage')).toBeTruthy();
    const body = within(tip).getByText('5-hour 63%');
    expect(body).toBeTruthy();
    // label first, then the body
    expect(tip.textContent?.indexOf('Usage')).toBeLessThan(tip.textContent?.indexOf('5-hour 63%') ?? -1);
  });

  it('draws nothing extra when no content is given', () => {
    render(
      <Tooltip label="Usage" description="A sentence.">
        <button>trigger</button>
      </Tooltip>,
    );
    expect(open().textContent).toBe('UsageA sentence.');
  });

  it('keeps the content up to date while the tooltip is open', () => {
    const { rerender } = render(
      <Tooltip label="Usage" content={<p>63%</p>}>
        <button>trigger</button>
      </Tooltip>,
    );
    const tip = open();
    expect(within(tip).getByText('63%')).toBeTruthy();
    rerender(
      <Tooltip label="Usage" content={<p>71%</p>}>
        <button>trigger</button>
      </Tooltip>,
    );
    expect(within(screen.getByRole('tooltip')).getByText('71%')).toBeTruthy();
  });
});

/**
 * Touch (AASC-20): a finger has no hover. A tap must not pop the tooltip (the
 * mouseenter and focus it emulates are ignored); holding 500 ms does, and the
 * click that ends the hold does not press the button.
 */
describe('Tooltip — long press on touch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (onClick = vi.fn()) => {
    render(
      <Tooltip label="Plan usage" description="5-hour window 42%">
        <button onClick={onClick}>trigger</button>
      </Tooltip>,
    );
    return { button: screen.getByRole('button', { name: 'trigger' }), onClick };
  };

  it('opens after a 500 ms hold and swallows the click that ends it', () => {
    const { button, onClick } = setup();
    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(499); });
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole('tooltip').textContent).toContain('Plan usage');
    fireEvent.pointerUp(button, { pointerType: 'touch' });
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    // The next tap is a tap again.
    fireEvent.pointerDown(button, { pointerType: 'touch' });
    fireEvent.pointerUp(button, { pointerType: 'touch' });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a quick tap presses the button and never opens the tooltip, even with the emulated mouseenter and focus', () => {
    const { button, onClick } = setup();
    fireEvent.pointerDown(button, { pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(120); });
    fireEvent.pointerUp(button, { pointerType: 'touch' });
    fireEvent.mouseEnter(button);
    act(() => { button.focus(); });
    fireEvent.click(button);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a finger that moves (a scroll) cancels the long press', () => {
    const { button } = setup();
    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.pointerMove(button, { pointerType: 'touch', clientX: 10, clientY: 30 });
    act(() => { vi.advanceTimersByTime(800); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes on the next touch anywhere, or by itself after a few seconds', () => {
    const { button } = setup();
    fireEvent.pointerDown(button, { pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.pointerDown(document.body, { pointerType: 'touch' });
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.pointerDown(button, { pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a mouse still opens it on hover, and never by holding', () => {
    const { button } = setup();
    fireEvent.pointerDown(button, { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.pointerUp(button, { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(1000); });
    fireEvent.mouseEnter(button);
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });

  it('a disabled tooltip ignores a long press and leaves the click alone', () => {
    const onClick = vi.fn();
    render(
      <Tooltip label="Hidden" disabled>
        <button onClick={onClick}>trigger</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'trigger' });
    fireEvent.pointerDown(button, { pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(700); });
    fireEvent.click(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

/**
 * Two layout hooks (Oct 23 2026, the session strip's prompt peek): the wrapper
 * span can take a class, so a trigger that is a flex item (a strip card) keeps
 * its slot, and a tooltip with a list in it can be wider than the 280px a hint gets.
 */
describe('Tooltip — layout hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const openIt = () => {
    act(() => screen.getByRole('button', { name: 'trigger' }).focus());
    act(() => {
      vi.advanceTimersByTime(600);
    });
    return screen.getByRole('tooltip');
  };

  it('puts triggerClassName on the wrapper around the trigger', () => {
    render(
      <Tooltip label="Peek" triggerClassName="fillSlot">
        <button>trigger</button>
      </Tooltip>,
    );
    const wrapper = screen.getByRole('button', { name: 'trigger' }).parentElement as HTMLElement;
    expect(wrapper.className).toMatch(/trigger/);
    expect(wrapper.className).toMatch(/fillSlot/);
  });

  it('marks a wide tooltip, and leaves a plain one as it was', () => {
    const { unmount } = render(
      <Tooltip label="Peek" wide>
        <button>trigger</button>
      </Tooltip>,
    );
    expect(openIt().className).toMatch(/tooltipWide/);
    unmount();
    render(
      <Tooltip label="Hint">
        <button>trigger</button>
      </Tooltip>,
    );
    expect(openIt().className).not.toMatch(/tooltipWide/);
  });

  it('honours its delay', () => {
    render(
      <Tooltip label="Peek" delay={500}>
        <button>trigger</button>
      </Tooltip>,
    );
    act(() => screen.getByRole('button', { name: 'trigger' }).focus());
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });
});

/**
 * Interactive (Oct 29 2026, the session prompt peek): the pointer may cross into
 * the tooltip to scroll a long body. Leaving the trigger waits a moment; a scroll
 * inside the tooltip, or in a scroller that does not hold its trigger (a terminal
 * printing), keeps it open; a click into it does not close it, and its clicks stay
 * its own (a portal still bubbles React events to the trigger's ancestors: the
 * header name renames on a double-click), while a press still reaches the page.
 */
describe('Tooltip — interactive', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = ({ interactive = true, onParent }: { interactive?: boolean; onParent?: () => void } = {}) => {
    render(
      <div onClick={onParent} onDoubleClick={onParent} onContextMenu={onParent}>
        <Tooltip label="Peek" content={<p>Every word of the prompt</p>} interactive={interactive}>
          <button>trigger</button>
        </Tooltip>
      </div>,
    );
    const button = screen.getByRole('button', { name: 'trigger' });
    fireEvent.mouseEnter(button);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    return { button, tip: screen.getByRole('tooltip') };
  };

  it('stays open while the pointer crosses from the trigger into it, and closes once it leaves', () => {
    const { button, tip } = setup();
    fireEvent.mouseLeave(button);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.mouseEnter(tip);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.mouseLeave(tip);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes a moment after the pointer leaves for somewhere else', () => {
    const { button } = setup();
    fireEvent.mouseLeave(button);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a plain tooltip still closes the moment the pointer leaves', () => {
    const { button } = setup({ interactive: false });
    fireEvent.mouseLeave(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a scroll inside it, or in a scroller that does not hold its trigger (a terminal printing), keeps it open', () => {
    const { tip } = setup();
    fireEvent.scroll(within(tip).getByText('Every word of the prompt').parentElement as HTMLElement);
    const terminal = document.body.appendChild(document.createElement('div'));
    try {
      fireEvent.scroll(terminal);
      expect(screen.getByRole('tooltip')).toBeTruthy();
    } finally {
      terminal.remove();
    }
  });

  it('a scroll that may move its trigger closes it: the scroller it sits in', () => {
    const { button } = setup();
    fireEvent.scroll(button.closest('div') as HTMLElement);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a scroll that may move its trigger closes it: the page', () => {
    setup();
    fireEvent.scroll(window);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('puts its content in a scrolling body and marks itself interactive; a plain one stays as it was', () => {
    const { tip } = setup();
    expect(tip.className).toMatch(/tooltipInteractive/);
    expect((within(tip).getByText('Every word of the prompt').parentElement as HTMLElement).className).toMatch(/body/);
  });

  it('a click into it does not close it, though the focus leaves the trigger', () => {
    const { button, tip } = setup();
    act(() => button.focus());
    act(() => tip.focus());
    expect(document.activeElement).toBe(tip);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });

  it("keeps its clicks to itself, while a press still reaches the page's click-outside listeners", () => {
    const onParent = vi.fn();
    const onPagePress = vi.fn();
    document.addEventListener('mousedown', onPagePress);
    try {
      const { tip } = setup({ onParent });
      const text = within(tip).getByText('Every word of the prompt');
      fireEvent.click(text);
      fireEvent.doubleClick(text);
      fireEvent.contextMenu(text);
      expect(onParent).not.toHaveBeenCalled();
      // An open select or menu that closes on a press outside it hears one in the peek.
      fireEvent.mouseDown(text);
      expect(onPagePress).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('mousedown', onPagePress);
    }
  });

  it('describes its trigger by its label, not by a body that can run to thousands of words', () => {
    const { button } = setup();
    const describedBy = button.parentElement?.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe('Peek');
  });

  it('opened by a long press, a touch inside it keeps it until a touch lands elsewhere', () => {
    render(
      <Tooltip label="Peek" content={<p>Every word of the prompt</p>} interactive>
        <button>trigger</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'trigger' });
    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.pointerUp(button, { pointerType: 'touch' });
    // A finger scrolling it: it stays, past the long press's own 4 s close too.
    fireEvent.pointerDown(within(screen.getByRole('tooltip')).getByText('Every word of the prompt'), { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.pointerDown(document.body, { pointerType: 'touch' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

/**
 * Position (Oct 29 2026): a whole-prompt peek can be as tall as the window, which
 * showed what a small tooltip hid. The first measure lands mid fade-in, while the box
 * is drawn at 96%, so it is placed by its layout size; a tooltip the window pushes
 * along keeps its arrow on the trigger; and an interactive tooltip never covers its
 * trigger: it takes the first side with room enough, capped to that room (its body
 * scrolls), rather than flipping beside the trigger or clamping over it. Its height is
 * what its body asks for, not the cap it had. jsdom has no layout: the boxes are given.
 */
describe('Tooltip — position', () => {
  type Box = { left: number; top: number; width: number; height: number };
  let triggerBox: Box;
  let tipSize: { width: number; height: number };

  const rect = ({ left, top, width, height }: Box) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  const setWindow = (width: number, height: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  };
  const isTip = (el: Element) => el.getAttribute('role') === 'tooltip';
  // The scrolling body under a 34px label: its own height is the tooltip's, less that.
  const CHROME = 34;
  const isBody = (el: Element) => !!el.parentElement && isTip(el.parentElement) && /body/.test(el.className);
  // An inline max-height, or the room beside the trigger (`--tooltip-room`, folded into the CSS max-width).
  const capHeight = (el: Element) => parseFloat((el as HTMLElement).style.maxHeight) || Infinity;
  const capWidth = (el: Element) => parseFloat((el as HTMLElement).style.getPropertyValue('--tooltip-room')) || Infinity;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('peek-trigger')) return rect(triggerBox);
      if (!isTip(this)) return rect({ left: 0, top: 0, width: 0, height: 0 });
      // Mid fade-in: drawn at 96% about its centre.
      const { width, height } = tipSize;
      return rect({ left: -9999 + width * 0.02, top: -9999 + height * 0.02, width: width * 0.96, height: height * 0.96 });
    });
    // As a browser would, an inline max-width / max-height caps it.
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return isTip(this) ? Math.min(tipSize.width, capWidth(this)) : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return isTip(this) ? Math.min(tipSize.height, capHeight(this)) : 0;
    });
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
      return isBody(this) ? tipSize.height - CHROME : 0;
    });
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
      return isBody(this) ? Math.min(tipSize.height, capHeight(this.parentElement as Element)) - CHROME : 0;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setWindow(1024, 768);
  });

  const ui = (placement: TooltipPlacement, interactive: boolean, text: string) => (
    <Tooltip label="Peek" content={<p>{text}</p>} placement={placement} interactive={interactive} triggerClassName="peek-trigger">
      <button>trigger</button>
    </Tooltip>
  );
  const open = (placement: TooltipPlacement, interactive = true) => {
    const { rerender } = render(ui(placement, interactive, 'Every word of the prompt'));
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'trigger' }));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const tip = screen.getByRole('tooltip');
    return {
      tip,
      arrow: tip.querySelector('[class*="arrow"]') as HTMLElement,
      grow: (text: string) => rerender(ui(placement, interactive, text)),
    };
  };

  it('places itself by its layout size, not the box its fade-in draws at 96%', () => {
    // The left rail's peek: right of a card centred at y 285, in a 560px window.
    setWindow(900, 560);
    triggerBox = { left: 10, top: 270, width: 200, height: 30 };
    tipSize = { width: 480, height: 544 };
    const { tip } = open('right');
    // 544 tall in 560 leaves exactly the two 8px gutters: top 8, not the 96% box's 24.
    expect(tip.style.top).toBe('8px');
    expect(tip.style.left).toBe('218px');
  });

  it('keeps its arrow on the trigger when the window pushes it along', () => {
    setWindow(900, 560);
    triggerBox = { left: 10, top: 270, width: 200, height: 30 };
    tipSize = { width: 480, height: 544 };
    const { arrow } = open('right');
    // The card's centre (285) less the tooltip's top (8).
    expect(arrow.style.top).toBe('277px');
  });

  it('under a top strip, an interactive one shrinks to the room below instead of flipping beside the card', () => {
    setWindow(1440, 560);
    triggerBox = { left: 100, top: 40, width: 160, height: 90 };
    tipSize = { width: 480, height: 544 };
    const { tip, arrow } = open('bottom');
    expect(tip.className).toMatch(/placement_bottom/);
    // 560 less the strip's bottom (130), the 8px gap and the 8px gutter.
    expect(tip.style.maxHeight).toBe('414px');
    expect(tip.style.top).toBe('138px');
    // Centred on the card (x 180) it would start at -60: held at the gutter, its arrow still on the card.
    expect(tip.style.left).toBe('8px');
    expect(arrow.style.left).toBe('172px');
  });

  it('takes the other side when its own has too little room', () => {
    // A trigger near the bottom: 24px of room below it, 454 above.
    setWindow(1440, 560);
    triggerBox = { left: 600, top: 470, width: 160, height: 50 };
    tipSize = { width: 480, height: 544 };
    const { tip } = open('bottom');
    expect(tip.className).toMatch(/placement_top/);
    expect(tip.style.maxHeight).toBe('454px');
    expect(tip.style.top).toBe('8px');
  });

  it('forgets the room it shrank to once it closes, so the next open measures it whole', () => {
    // Above a trigger low in a 560px window: 454px of room, so capped at 454.
    setWindow(1440, 560);
    triggerBox = { left: 600, top: 470, width: 160, height: 50 };
    tipSize = { width: 480, height: 544 };
    const { tip } = open('top');
    expect(tip.style.maxHeight).toBe('454px');
    fireEvent.mouseLeave(screen.getByRole('button', { name: 'trigger' }));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    // A taller window: 784px of room above the trigger, more than the tooltip's 544.
    setWindow(1440, 900);
    triggerBox = { left: 600, top: 800, width: 160, height: 50 };
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'trigger' }));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    // Its whole 544 sits above the trigger (800 - 544 - 8), not the old 454's 338.
    expect(screen.getByRole('tooltip').style.top).toBe('248px');
  });

  it('beside the left rail in a narrow window, it narrows to the room there instead of covering the card', () => {
    // 600px wide: 374px beside a card ending at 210, short of the peek's 480.
    setWindow(600, 560);
    triggerBox = { left: 10, top: 270, width: 200, height: 30 };
    tipSize = { width: 480, height: 300 };
    const { tip } = open('right');
    expect(tip.className).toMatch(/placement_right/);
    expect(tip.style.getPropertyValue('--tooltip-room')).toBe('374px');
    expect(tip.style.left).toBe('218px');
  });

  it('with no room beside its trigger, it goes above or below it, never over it', () => {
    // A 480px pop-out: 254px beside the card is too narrow, so above it, where there are 254px.
    setWindow(480, 560);
    triggerBox = { left: 10, top: 270, width: 200, height: 30 };
    tipSize = { width: 464, height: 544 };
    const { tip } = open('right');
    expect(tip.className).toMatch(/placement_top/);
    expect(tip.style.maxHeight).toBe('254px');
    expect(tip.style.top).toBe('8px');
  });

  it('measures a body that grows while it is open at its whole height, not the cap it had', () => {
    // 124px of room below the trigger and 364 above: a short peek fits below...
    setWindow(1440, 560);
    triggerBox = { left: 600, top: 380, width: 160, height: 40 };
    tipSize = { width: 480, height: 120 };
    const { tip, grow } = open('bottom');
    expect(tip.className).toMatch(/placement_bottom/);
    expect(tip.style.maxHeight).toBe('124px');
    // ...then a long prompt arrives: all 300px of it go above (380 - 300 - 8).
    tipSize = { width: 480, height: 300 };
    grow('Every word of a much longer prompt');
    const grown = screen.getByRole('tooltip');
    expect(grown.className).toMatch(/placement_top/);
    expect(grown.style.top).toBe('72px');
  });

  it('a plain tooltip still flips beside its trigger, at its own height', () => {
    setWindow(1440, 560);
    triggerBox = { left: 100, top: 40, width: 160, height: 90 };
    tipSize = { width: 480, height: 544 };
    const { tip } = open('bottom', false);
    expect(tip.className).toMatch(/placement_right/);
    expect(tip.style.maxHeight).toBe('');
  });
});

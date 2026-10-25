import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, within, fireEvent } from '@testing-library/react';

import Tooltip from './Tooltip';

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

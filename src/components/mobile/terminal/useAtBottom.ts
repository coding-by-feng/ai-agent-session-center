/**
 * useAtBottom — whether the phone terminal shows its newest line (Oct 23 2026), for the
 * "↓ Latest" button.
 *
 * xterm scrolls its own element (`.xterm-viewport`) inside the viewer. Scroll events don't
 * bubble, so this listens in the capture phase on the viewer wrappers (the screen's and the
 * full-screen overlay's: the xterm element moves between them). New output while you read
 * further up fires no scroll, so the button stays until you go back down.
 */
import { useEffect, useState, type RefObject } from 'react';

/** Within this many pixels of the end counts as the bottom (sub-pixel rounding). */
const SLACK_PX = 2;

export function useAtBottom(
  first: RefObject<HTMLElement | null>,
  second: RefObject<HTMLElement | null>,
): boolean {
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    const roots = [first.current, second.current].filter((el): el is HTMLElement => !!el);
    const onScroll = (event: Event) => {
      const el = event.target;
      if (!(el instanceof HTMLElement) || !el.classList.contains('xterm-viewport')) return;
      setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - SLACK_PX);
    };
    for (const root of roots) root.addEventListener('scroll', onScroll, true);
    return () => {
      for (const root of roots) root.removeEventListener('scroll', onScroll, true);
    };
  }, [first, second]);
  return atBottom;
}

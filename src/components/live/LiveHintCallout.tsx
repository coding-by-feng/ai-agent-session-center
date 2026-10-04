/**
 * LiveHintCallout — the one-time tip above the LIVE board (lib/liveHint.ts):
 * a bubble whose caret points up at the LIVE tab.
 *
 * It sits in the page's flow, not floating: it pushes the board down instead
 * of covering the first row, and nothing in the top bar can clip it (the bar
 * scrolls sideways below 640px, which would crop an overlay anchored inside
 * it). Its horizontal place is measured from the tab marked `data-live-tab`
 * and written straight to two CSS variables, so a resize or a sideways scroll
 * of the bar moves it without a React render.
 */
import { useLayoutEffect, useRef } from 'react';
import { placeLiveHint } from '@/lib/liveHint';
import styles from '@/styles/modules/LiveHintCallout.module.css';

interface LiveHintCalloutProps {
  onDismiss: () => void;
}

export default function LiveHintCallout({ onDismiss }: LiveHintCalloutProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const bubble = bubbleRef.current;
    if (!row || !bubble) return;

    const place = () => {
      const tab = document.querySelector('[data-live-tab]');
      if (!tab) return; // no top bar (a pop-out): the bubble keeps its default place
      const t = tab.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const { left, caretX } = placeLiveHint({
        anchorCenter: t.left + t.width / 2,
        containerLeft: r.left,
        containerWidth: r.width,
        bubbleWidth: bubble.offsetWidth,
      });
      bubble.style.setProperty('--hint-left', `${left}px`);
      bubble.style.setProperty('--caret-x', `${caretX}px`);
    };

    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(row);
    observer?.observe(bubble);
    // The tab can move while nothing here changes size: another theme's font
    // re-lays the top bar out, the tip's own dot widens the tab, + NEW / DIRS
    // change width. Watch the top bar's items too (a handful of elements).
    const tab = document.querySelector('[data-live-tab]');
    const bar = tab?.closest('nav') ?? tab?.parentElement;
    if (bar) for (const item of Array.from(bar.children)) observer?.observe(item);
    window.addEventListener('resize', place);
    // Capture: the top bar's own sideways scroll does not bubble.
    document.addEventListener('scroll', place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, []);

  return (
    <div className={styles.row} ref={rowRef}>
      <div className={styles.bubble} ref={bubbleRef} role="note" aria-label="Tip">
        <p className={styles.text}>
          <strong className={styles.lead}>Open a session:</strong> click its card, or press LIVE.
        </p>
        <button
          type="button"
          className={styles.close}
          onClick={onDismiss}
          aria-label="Dismiss tip"
          title="Dismiss tip"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

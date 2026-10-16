/**
 * useDomFind — find in a rendered file on a phone (a Markdown page, AASC-56):
 * the hits are found in the page's own text and lit with the CSS Custom
 * Highlight API, so the rendered Markdown is never re-rendered to wrap a match
 * (the chat search does the same, useSearchHighlight). The current hit is
 * scrolled into the middle of the file's own scroller. Where the API is missing
 * (older web views) the count and the scrolling still work.
 *
 * Matching is the shared rule (textHighlight.normalizeQuery: trimmed,
 * lowercased, plain substring), the one the code view's find uses too.
 */
import { useLayoutEffect, type RefObject } from 'react';
import { normalizeQuery } from '@/lib/textHighlight';
import { scrollIntoContainer } from '@/lib/scrollWithinContainer';

const ALL = 'project-find';
const CURRENT = 'project-find-current';
/** Ranges found at most (a one-letter query on a long page finds thousands). */
export const MAX_DOM_MATCHES = 1000;

interface HighlightSet {
  add(range: Range): void;
}

interface HighlightRegistry {
  set(name: string, value: HighlightSet): void;
  delete(name: string): void;
}

function registry(): { highlights: HighlightRegistry; Highlight: new () => HighlightSet } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Ctor = (globalThis as { Highlight?: new () => HighlightSet }).Highlight;
  return css?.highlights && Ctor ? { highlights: css.highlights, Highlight: Ctor } : null;
}

function findRanges(root: Element, q: string): Range[] {
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && out.length < MAX_DOM_MATCHES; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLowerCase();
    for (let at = text.indexOf(q); at >= 0 && out.length < MAX_DOM_MATCHES; at = text.indexOf(q, at + q.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + q.length);
      out.push(range);
    }
  }
  return out;
}

/**
 * Lights `query` inside `rootRef` and brings hit `index` into view; reports the
 * number of hits through `onCount` (stable: a state setter). Re-runs when the
 * page's content changes (the Markdown renders after its lazy chunk loads).
 */
export function useDomFind(
  rootRef: RefObject<HTMLElement | null>,
  query: string,
  index: number,
  enabled: boolean,
  onCount: (count: number) => void,
): void {
  useLayoutEffect(() => {
    const root = rootRef.current;
    const api = registry();
    const q = normalizeQuery(query);
    const clear = () => {
      api?.highlights.delete(ALL);
      api?.highlights.delete(CURRENT);
    };
    if (!enabled || !root || !q) {
      clear();
      onCount(0);
      return clear;
    }
    let lastCurrent: Range | null = null;
    const run = () => {
      const ranges = findRanges(root, q);
      onCount(ranges.length);
      if (ranges.length === 0) {
        clear();
        return;
      }
      const current = ranges[((index % ranges.length) + ranges.length) % ranges.length];
      if (api) {
        const others = new api.Highlight();
        const now = new api.Highlight();
        for (const r of ranges) (r === current ? now : others).add(r);
        api.highlights.set(ALL, others);
        api.highlights.set(CURRENT, now);
      }
      // Scroll only when the hit moved: a re-render of the same page must not jump.
      const target = current.startContainer.parentElement;
      if (!lastCurrent || lastCurrent.startContainer !== current.startContainer || lastCurrent.startOffset !== current.startOffset) {
        scrollIntoContainer(root, target, { block: 'center', behavior: 'auto' });
      }
      lastCurrent = current;
    };
    run();
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(run) : null;
    observer?.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer?.disconnect();
      clear();
    };
  }, [rootRef, query, index, enabled, onCount]);
}

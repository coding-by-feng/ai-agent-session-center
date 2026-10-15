/**
 * useSearchHighlight — lights up the search's text in the chat rows on screen
 * (AASC-41) with the CSS Custom Highlight API, so Markdown, diffs and bubbles keep
 * their own markup: nothing is re-rendered to wrap a match. The current match's
 * row gets the stronger colour. Where the API is missing (older web views) the
 * current row's tint (`data-current`) still shows where the match is.
 *
 * Matching is the chat's one rule (textHighlight.normalizeQuery: lowercased,
 * trimmed, plain substring), the same one that counts and orders the matches.
 */
import { useEffect, type RefObject } from 'react';
import { normalizeQuery } from '@/lib/textHighlight';
import { rowSelector } from './useChatScroll';

const ALL = 'chat-search';
const CURRENT = 'chat-search-current';
/** Ranges lit at most (a one-letter query in a long window would find thousands). */
const MAX_RANGES = 500;

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

/** Adds the matches inside `root` to `into`; returns how many ranges are left to give. */
function addRanges(root: Element, query: string, into: HighlightSet, budget: number): number {
  let left = budget;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && left > 0; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLowerCase();
    let at = text.indexOf(query);
    while (at >= 0 && left > 0) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + query.length);
      into.add(range);
      left -= 1;
      at = text.indexOf(query, at + query.length);
    }
  }
  return left;
}

export function useSearchHighlight(
  listRef: RefObject<HTMLElement | null>,
  query: string,
  currentKey: string | null,
  /** Anything that changes what is rendered (the rows, the window, what is open). */
  renderKey: unknown,
): void {
  useEffect(() => {
    const api = registry();
    const list = listRef.current;
    const q = normalizeQuery(query);
    if (!api) return;
    if (!list || !q) {
      api.highlights.delete(ALL);
      api.highlights.delete(CURRENT);
      return;
    }
    const current = currentKey ? list.querySelector(rowSelector(currentKey)) : null;
    const now = new api.Highlight();
    let left = current ? addRanges(current, q, now, MAX_RANGES) : MAX_RANGES;
    const others = new api.Highlight();
    for (const row of Array.from(list.children)) {
      if (left <= 0) break;
      if (row !== current) left = addRanges(row, q, others, left);
    }
    api.highlights.set(ALL, others);
    api.highlights.set(CURRENT, now);
    return () => {
      api.highlights.delete(ALL);
      api.highlights.delete(CURRENT);
    };
  }, [listRef, query, currentKey, renderKey]);
}

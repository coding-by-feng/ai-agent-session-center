/**
 * Move keyboard focus before a list row is removed, so it never falls to
 * <body> when the focused control unmounts with its row (Remove, Delete,
 * Move-to-another-list). Call it while the row is still in the DOM.
 *
 * It focuses the nearest other control matching `selector` inside `scope`
 * (default: the row's parent): the first one after the row in document order,
 * else the last one before it, else `fallback`. A wider scope lets focus cross
 * from the last row of one table into the next (QUEUE's per-session groups).
 * Import-free and DOM-only, so any view can use it.
 */
export function focusSiblingAfterRemoval(
  row: Element | null | undefined,
  selector: string,
  fallback?: HTMLElement | null,
  scope?: ParentNode | null,
): void {
  const within = scope ?? row?.parentElement;
  const target = row && within ? nearestControl(row, selector, within) : undefined;
  (target ?? fallback ?? null)?.focus();
}

function nearestControl(row: Element, selector: string, scope: ParentNode): HTMLElement | undefined {
  // querySelectorAll returns document order, so the first control past the row
  // belongs to the next row and the last one before it to the previous row.
  const others = Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter((el) => !row.contains(el));
  const isAfter = (el: Element) => (row.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  return others.find(isAfter) ?? others.filter((el) => !isAfter(el)).pop();
}

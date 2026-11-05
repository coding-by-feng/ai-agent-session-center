/**
 * projectsListModel.ts — the order a phone keeps for its Sessions list grouped by
 * project (Nov 4 2026). Pure: no store, no DOM.
 *
 * A project is a folder, not a record the Mac holds, so there is no shared order
 * to change: the desktop strip works out A to Z and stores nothing
 * (projectGroups.ts). Dragging a project is this phone's view, in its own
 * localStorage key, unlike a room's order, which is the Mac's `listOrder`.
 */
import { mergeRoomOrder } from '@/lib/roomOrder';

/** The project keys (`host|path`) in the order this phone lists them (JSON array). */
export const PROJECT_ORDER_KEY = 'aasc.phoneProjectOrder';

/** Keys outlive their sessions (see below), so a limit keeps the list from growing forever. */
const MAX_ORDERED = 200;

/** The order from what localStorage held; anything malformed reads as no order. */
export function parseProjectOrder(raw: string | null): readonly string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const keys = value.filter((key): key is string => typeof key === 'string' && key.length > 0);
    return [...new Set(keys)].slice(0, MAX_ORDERED);
  } catch {
    return [];
  }
}

/**
 * `items` in the stored order. One the order has not met goes after those, in the
 * order it came (A to Z), so a new project shifts nothing. A new array; `items`
 * stays as it was.
 */
export function applyProjectOrder<T>(items: readonly T[], keyOf: (item: T) => string, order: readonly string[]): T[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  const rankOf = (item: T) => rank.get(keyOf(item)) ?? order.length;
  return [...items].sort((a, b) => rankOf(a) - rankOf(b));
}

/**
 * What a drop saves, or null when nothing moved. `visibleNext` is only the
 * projects on screen, in their new order: one a filter hides, or with no live
 * session right now, keeps its slot, so it is back where it was when it returns.
 *
 * @param stored      The order so far.
 * @param live        Every project this phone lists unfiltered, A to Z.
 * @param visibleNext The groups on screen after the drop.
 */
export function projectOrderAfterDrag(
  stored: readonly string[],
  live: readonly string[],
  visibleNext: readonly string[],
): readonly string[] | null {
  const known = new Set(stored);
  const current = [...stored, ...live.filter((key) => !known.has(key))];
  const merged = mergeRoomOrder(current, visibleNext);
  if (merged === current) return null;
  const excess = merged.length - MAX_ORDERED;
  if (excess <= 0) return merged;
  // Over the limit: forget projects with no live session, oldest first. A plain cut
  // would take new projects off the end, and with them the drop just made.
  const liveKeys = new Set(live);
  const forgotten = new Set(merged.filter((key) => !liveKeys.has(key)).slice(0, excess));
  return merged.filter((key) => !forgotten.has(key)).slice(0, MAX_ORDERED);
}

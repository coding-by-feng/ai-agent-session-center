/**
 * @module pinOrder
 * Each pinned card's place in the PINNED frame (`Session.pinOrder`, 1 = top; Nov 18 2026).
 * Dragging a card in PINNED sends the new order; a new pin goes to the end. The card numbers
 * (`numberedSessions`) rank pinned sessions by it, so every device lists and numbers them alike.
 * Pure and dependency-free: the server (sessionStore) and the browser (sessionStore) both apply it.
 */

interface PinState {
  pinned?: boolean;
  pinOrder?: number;
}

/** The place for a session being pinned now: after every pinned one, placed or not. */
export function nextPinOrder(sessions: Iterable<PinState>): number {
  let max = 0;
  let pins = 0;
  for (const s of sessions) {
    if (!s.pinned) continue;
    pins += 1;
    if (typeof s.pinOrder === 'number' && s.pinOrder > max) max = s.pinOrder;
  }
  return Math.max(max, pins) + 1;
}

/**
 * The places after a drag: the `requested` ids first, in that order, then every other pinned
 * session in its old order (unplaced last, input order kept), renumbered 1..N. `pinned` is every
 * pinned session; requested ids that are not among them, and repeats, are ignored.
 */
export function planPinnedOrder(
  pinned: readonly { sessionId: string; pinOrder?: number }[],
  requested: readonly string[],
): Map<string, number> {
  const known = new Set(pinned.map((s) => s.sessionId));
  const first: string[] = [];
  for (const id of requested) {
    if (known.has(id) && !first.includes(id)) first.push(id);
  }
  const rest = pinned
    .map((s, i) => ({ id: s.sessionId, order: s.pinOrder ?? Number.POSITIVE_INFINITY, i }))
    .filter((s) => !first.includes(s.id))
    .sort((a, b) => (a.order === b.order ? a.i - b.i : a.order < b.order ? -1 : 1))
    .map((s) => s.id);
  return new Map([...first, ...rest].map((id, i) => [id, i + 1]));
}

/**
 * The order to apply when the device sees only some pins (a phone sees the shared ones, Nov 18 2026).
 * It sends just those, in their new order. Their slots in the full order are refilled with them in
 * that order (a visible pin it left out follows the listed ones), and every pin it can't see keeps
 * its slot, so a phone's reorder never moves a session it can't see.
 */
export function placeVisiblePins(
  pinned: readonly { sessionId: string; pinOrder?: number }[],
  requested: readonly string[],
  visible: (id: string) => boolean,
): string[] {
  const full = [...planPinnedOrder(pinned, [])].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  const listed: string[] = [];
  for (const id of requested) {
    if (visible(id) && full.includes(id) && !listed.includes(id)) listed.push(id);
  }
  const shown = [...listed, ...full.filter((id) => visible(id) && !listed.includes(id))];
  let next = 0;
  return full.map((id) => (visible(id) ? shown[next++] : id));
}

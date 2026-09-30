/**
 * panelResize — height maths for the draggable terminal/queue divider.
 *
 * Pure and DOM-free so the two things that are easy to get wrong, and
 * invisible in a diff, are unit-testable: the INVERTED drag delta and the two
 * clamps.
 */

/** Height the queue strip starts at, and returns to on a double-click. */
export const DEFAULT_QUEUE_HEIGHT = 250;
/** Below this the compose row and type pills start clipping. */
export const MIN_QUEUE_HEIGHT = 120;
/**
 * Height the TERMINAL must keep. The queue's maximum is derived from this
 * rather than being a percentage: a percentage cap looks reasonable and still
 * starves the terminal to a couple of rows in a short window, which is the
 * case that actually matters.
 */
export const MIN_TERMINAL_HEIGHT = 160;

/**
 * The queue's height for a drag in progress.
 *
 * `dy` is the pointer's movement since the press, positive downward. The
 * divider is the queue's TOP edge, so moving it down makes the queue SHORTER —
 * hence the subtraction. Getting this backwards yields a handle that appears
 * to flee the cursor, which reads as "resize is broken" rather than as a sign
 * error.
 *
 * @param containerHeight Height available to terminal + queue together. When
 *   it is unknown or absurd (0 during first layout), only the minimum is
 *   applied — clamping against a bogus maximum would snap the panel shut.
 */
export function resolveQueueHeight(
  startHeight: number,
  dy: number,
  containerHeight: number,
): number {
  const desired = startHeight - dy;
  return clampQueueHeight(desired, containerHeight);
}

/** Clamp a height to the usable range for this container. */
export function clampQueueHeight(height: number, containerHeight: number): number {
  const min = MIN_QUEUE_HEIGHT;
  if (!Number.isFinite(height)) return min;
  if (!Number.isFinite(containerHeight) || containerHeight <= 0) {
    return Math.max(min, height);
  }
  // If the container cannot satisfy both floors, the queue yields — the
  // terminal is the primary surface, and a queue pinned to its minimum is
  // still usable where a 2-row terminal is not.
  const max = Math.max(min, containerHeight - MIN_TERMINAL_HEIGHT);
  return Math.min(max, Math.max(min, height));
}

/** Read a persisted height, falling back to the default. Exported so the
 *  storage key and the parsing rule live in one place. */
export function loadQueueHeight(): number {
  try {
    const raw = localStorage.getItem('queue-panel-height');
    const n = raw === null ? NaN : Number(raw);
    // A stored value is clamped only against its own minimum here: the
    // container size is not known at module/init time, and clamping against a
    // guess would permanently shrink the panel on a narrow first paint.
    return Number.isFinite(n) && n > 0 ? Math.max(MIN_QUEUE_HEIGHT, n) : DEFAULT_QUEUE_HEIGHT;
  } catch {
    return DEFAULT_QUEUE_HEIGHT;
  }
}

export function saveQueueHeight(height: number): void {
  try {
    localStorage.setItem('queue-panel-height', String(Math.round(height)));
  } catch {
    /* private mode / storage disabled — the height simply won't persist */
  }
}

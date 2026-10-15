/**
 * sheetDetents — where a kit Sheet comes to rest after a drag (AASC-38). Pure.
 *
 *   'fit'     as tall as its content
 *   'medium'  half the screen
 *   'large'   all but the status bar
 */
export type SheetDetent = 'fit' | 'medium' | 'large';

/** A drag past this many px, or a flick faster than FLICK px/ms, changes the detent. */
export const DRAG_THRESHOLD_PX = 80;
const FLICK = 0.6;

export function nextDetent(
  detents: readonly SheetDetent[],
  current: SheetDetent,
  dy: number,
  velocity: number,
): SheetDetent | 'close' {
  const at = detents.indexOf(current);
  const down = dy > DRAG_THRESHOLD_PX || velocity > FLICK;
  const up = dy < -DRAG_THRESHOLD_PX || velocity < -FLICK;
  if (down) return at <= 0 || velocity > FLICK * 2 ? 'close' : detents[at - 1];
  if (up && at < detents.length - 1) return detents[at + 1];
  return current;
}

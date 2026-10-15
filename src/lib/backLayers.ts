/**
 * backLayers — what a phone's back closes first (AASC-48): an open sheet, menu
 * or dialog.
 *
 * Android's back button walks the page's history, which the phone frame owns
 * (stores/phoneNavStore.ts): with a sheet open, a back used to pop the screen
 * under it and leave the sheet's state behind. An open layer registers here; on
 * a back the frame didn't start, the nav store closes the top layer instead and
 * puts the history entry back, so the screen stays.
 *
 * Kept tiny and free of phone imports: the shared BottomSheet and Modal register
 * too, and they sit in the desktop's entry chunk, where no frame ever asks.
 */
import { useEffect, useRef } from 'react';

const layers: Array<() => void> = [];

/** Register an open layer; returns its release. The newest is closed first. */
export function openBackLayer(close: () => void): () => void {
  const layer = () => close();
  layers.push(layer);
  return () => {
    const at = layers.lastIndexOf(layer);
    if (at >= 0) layers.splice(at, 1);
  };
}

/** Close the top layer, if any (it is released at once: one back, one layer). */
export function closeTopBackLayer(): boolean {
  const top = layers.pop();
  if (!top) return false;
  top();
  return true;
}

/** While `open`, a back closes this layer through `onClose`. */
export function useBackLayer(open: boolean, onClose: () => void): void {
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  useEffect(() => (open ? openBackLayer(() => latest.current()) : undefined), [open]);
}

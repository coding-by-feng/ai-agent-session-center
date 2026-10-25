/**
 * dragSettle — the glide that ends a carried drag: every element that moved
 * goes from where it was drawn at the drop into wherever the re-render put it.
 *
 * Shared by the room strip (`useRoomDragReorder`) and the queue's List layout
 * (`useQueueDragReorder`, Oct 21 2026), so a drop lands the same way in both.
 * The queue's Card grid (Oct 22 2026) moves cards sideways too, so the glide has
 * an x part; rows and rooms never move sideways and still glide on translateY.
 */

/** Where an element was on screen at the moment of the drop. */
export interface DropPose {
  el: HTMLElement;
  /** Centre y, carry offset / in-flight slide included. */
  center: number;
  /** Centre x, the same way (only a Card-grid card ever changes it). */
  centerX: number;
  /** The carried element: it also comes down from the lift scale. */
  lifted: boolean;
}

/** Each element's pose at this instant: read BEFORE the drop's commit re-renders them. */
export function dropPoses(frames: readonly { el: HTMLElement; lifted: boolean }[]): DropPose[] {
  return frames.map(({ el, lifted }) => {
    const r = el.getBoundingClientRect();
    return { el, center: r.top + r.height / 2, centerX: r.left + r.width / 2, lifted };
  });
}

/** On drop, glide every element from where it was on screen into wherever the
 *  re-render put it (a FLIP). That is the carried one coming down from where it
 *  was carried — also after a drop that changed nothing — and any passed one
 *  still mid-slide when a quick flick released: the drop removes the slide
 *  transition in the same render that commits the order, so without this it
 *  would jump the rest of the way. Measured by CENTRE, not top: the lifted one
 *  is scaled about its centre, the one point the scale leaves in place. Runs on
 *  the next frame, after React has committed the new order and before that
 *  frame paints, so no jump is ever visible. Started animations are added to
 *  `running` so the next lift can land them before measuring. Returns the
 *  scheduled frame, or null when nothing was scheduled. */
export function settleInto(
  poses: DropPose[],
  running: Set<Animation>,
  { durationMs, liftScale }: { durationMs: number; liftScale: number },
): number | null {
  if (poses.length === 0 || typeof requestAnimationFrame !== 'function') return null;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null;
  return requestAnimationFrame(() => {
    for (const { el, center, centerX, lifted } of poses) {
      if (!el.isConnected || typeof el.animate !== 'function') continue;
      const r = el.getBoundingClientRect();
      const dx = centerX - (r.left + r.width / 2);
      const dy = center - (r.top + r.height / 2);
      const sideways = Math.abs(dx) >= 0.5;
      // One that neither moved nor was lifted has nothing to settle.
      if (!lifted && !sideways && Math.abs(dy) < 0.5) continue;
      const move = sideways ? `translate(${dx}px, ${dy}px)` : `translateY(${dy}px)`;
      const from = lifted ? `${move} scale(${liftScale})` : move;
      const anim = el.animate(
        [{ transform: from }, { transform: 'none' }],
        { duration: durationMs, easing: 'ease-out' },
      );
      running.add(anim);
      const forget = () => running.delete(anim);
      anim.addEventListener('finish', forget);
      anim.addEventListener('cancel', forget);
    }
  });
}

/** Land any glide still running (and a scheduled one): `getBoundingClientRect`
 *  includes a running animation's transform, so measuring for a new lift while
 *  one glides would freeze a moving box into every slot of that drag. */
export function landSettle(running: Set<Animation>, frame: { current: number | null }): void {
  if (frame.current !== null) {
    cancelAnimationFrame(frame.current);
    frame.current = null;
  }
  for (const anim of running) anim.finish();
  running.clear();
}

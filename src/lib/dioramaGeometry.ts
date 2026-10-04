/**
 * Shared rounded geometry for the diorama scene style.
 *
 * The cyberdrome style is built from sharp `BoxGeometry`. The diorama wants the same shapes with
 * softly rounded edges — a toy-like look that also catches light along the edges. A rounded box has
 * far more vertices than a plain one, so these are built ONCE per size and shared by every mesh that
 * uses them: a geometry per robot (or per desk chair) would be GPU churn with fifty sessions.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/** A side thinner than this stays a plain box — rounding a 5 mm screen would only fold it over itself. */
const MIN_ROUNDABLE = 0.02;
/** Radius as a share of the smallest side: under half, so opposite corner arcs can never meet. */
const ROUND_FRACTION = 0.45;
/** …and never rounder than this, so a big slab keeps a crisp silhouette. */
const MAX_RADIUS = 0.06;

const roundedByKey = new Map<string, THREE.BufferGeometry>();

/**
 * A rounded box of the given size, shared across callers. `segments` is how finely each corner is
 * rounded: 2 for the robots (seen up close), 1 for scenery drawn hundreds of times.
 */
export function roundedBox(
  width: number,
  height: number,
  depth: number,
  segments = 2,
): THREE.BufferGeometry {
  const key = `${width}|${height}|${depth}|${segments}`;
  const known = roundedByKey.get(key);
  if (known) return known;

  const smallest = Math.min(width, height, depth);
  const geometry =
    smallest < MIN_ROUNDABLE
      ? new THREE.BoxGeometry(width, height, depth)
      : new RoundedBoxGeometry(width, height, depth, segments, Math.min(MAX_RADIUS, smallest * ROUND_FRACTION));
  roundedByKey.set(key, geometry);
  return geometry;
}

/** Tallest a livery band gets, and how far above the torso's bottom edge it sits. */
const BAND_HEIGHT = 0.07;
const BAND_INSET = 0.03;

/**
 * Where the livery band sits on a torso `torsoHeight` tall: low on the chest, clear of the core and
 * the badge above it, and always wholly inside the torso. `offsetY` is relative to the torso's
 * centre. A short torso (the drone, the spider) gets a band no taller than 40% of it — a fixed offset
 * left the band hanging off the bottom of those.
 */
export function bandPlacement(torsoHeight: number): { height: number; offsetY: number } {
  const height = Math.min(BAND_HEIGHT, torsoHeight * 0.4);
  const offsetY = Math.min(-torsoHeight / 2 + height / 2 + BAND_INSET, torsoHeight / 2 - height / 2);
  return { height, offsetY };
}

const dioramaOf = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

/**
 * The diorama counterpart of a robot part's geometry: a box becomes a rounded box of the same size,
 * anything else (spheres, cylinders) stays as it is. The answer is remembered per source geometry.
 */
export function toDioramaGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!(source instanceof THREE.BoxGeometry) || source instanceof RoundedBoxGeometry) return source;
  const known = dioramaOf.get(source);
  if (known) return known;
  const { width, height, depth } = source.parameters;
  const rounded = roundedBox(width, height, depth);
  dioramaOf.set(source, rounded);
  return rounded;
}

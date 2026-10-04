import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { bandPlacement, roundedBox, toDioramaGeometry } from './dioramaGeometry';

function size(geometry: THREE.BufferGeometry): THREE.Vector3 {
  geometry.computeBoundingBox();
  return geometry.boundingBox!.getSize(new THREE.Vector3());
}

/** The corner radius three.js actually used (after clamping) — present at runtime, missing from @types/three. */
function radiusOf(geometry: THREE.BufferGeometry): number {
  return (geometry as unknown as { parameters: { radius: number } }).parameters.radius;
}

describe('roundedBox', () => {
  it('has the size it was asked for', () => {
    const s = size(roundedBox(0.32, 0.38, 0.2));
    expect(s.x).toBeCloseTo(0.32, 5);
    expect(s.y).toBeCloseTo(0.38, 5);
    expect(s.z).toBeCloseTo(0.2, 5);
  });

  it('really is rounded: no vertex sits on a sharp corner', () => {
    const geometry = roundedBox(0.32, 0.38, 0.2);
    const corner = new THREE.Vector3(0.16, 0.19, 0.1);
    const position = geometry.getAttribute('position');
    let nearest = Infinity;
    for (let i = 0; i < position.count; i++) {
      nearest = Math.min(nearest, corner.distanceTo(new THREE.Vector3().fromBufferAttribute(position, i)));
    }
    expect(nearest).toBeGreaterThan(0.01);
  });

  it('returns the same geometry for the same size, so every robot shares one', () => {
    expect(roundedBox(0.28, 0.24, 0.26)).toBe(roundedBox(0.28, 0.24, 0.26));
    expect(roundedBox(0.28, 0.24, 0.26)).not.toBe(roundedBox(0.28, 0.24, 0.27));
  });

  it('keeps a sliver a plain box — rounding a 5 mm screen would only fold it over itself', () => {
    const screen = roundedBox(0.44, 0.28, 0.005);
    expect(screen).not.toBeInstanceOf(RoundedBoxGeometry);
    const s = size(screen);
    expect(s.z).toBeCloseTo(0.005, 6);
  });

  it('rounds a thin panel by less than half its thickness, so opposite corner arcs never meet', () => {
    // (three.js clamps the radius to half the thinnest side, so the bounding box says nothing here:
    // the radius it actually used is the evidence.)
    const deskTop = roundedBox(1.5, 0.05, 0.65);
    expect(deskTop).toBeInstanceOf(RoundedBoxGeometry);
    expect(size(deskTop).y).toBeCloseTo(0.05, 5);
    expect(radiusOf(deskTop)).toBeGreaterThan(0);
    expect(radiusOf(deskTop)).toBeLessThan(0.05 / 2);
  });

  it('keeps a big slab crisp: its corners are never rounder than a few centimetres', () => {
    const slab = roundedBox(2, 2, 2);
    expect(radiusOf(slab)).toBeLessThanOrEqual(0.06);
    expect(radiusOf(slab)).toBeGreaterThan(0.02);
  });

  it('can be built coarser for scenery that is drawn hundreds of times', () => {
    const fine = roundedBox(1, 1, 1, 3);
    const coarse = roundedBox(1, 1, 1, 1);
    expect(coarse.getAttribute('position').count).toBeLessThan(fine.getAttribute('position').count);
  });
});

// The livery band wraps the lower torso. The six model variants have very different torsos, and a
// band placed for the standard robot floated clear of the drone, the spider and the tank.
describe('bandPlacement', () => {
  const torsos: Array<[string, number]> = [
    ['robot', 0.38],
    ['mech', 0.44],
    ['drone', 0.18],
    ['spider', 0.14],
    ['tank', 0.3],
    ['a sliver', 0.05],
  ];

  it.each(torsos)('keeps the band wholly inside a %s torso (height %f)', (_name, torsoHeight) => {
    const { height, offsetY } = bandPlacement(torsoHeight);
    expect(offsetY - height / 2).toBeGreaterThanOrEqual(-torsoHeight / 2 - 1e-9);
    expect(offsetY + height / 2).toBeLessThanOrEqual(torsoHeight / 2 + 1e-9);
  });

  it.each(torsos)('leaves some torso showing above the band on a %s (height %f)', (_name, torsoHeight) => {
    expect(bandPlacement(torsoHeight).height).toBeLessThan(torsoHeight * 0.5);
  });

  it('never makes the band taller than a band should be', () => {
    expect(bandPlacement(2).height).toBeLessThanOrEqual(0.07);
  });

  it('keeps the standard robot looking as it did: low on the chest', () => {
    expect(bandPlacement(0.38).offsetY).toBeCloseTo(-0.125, 3);
    expect(bandPlacement(0.38).height).toBeCloseTo(0.07, 6);
  });

  it('sits lower on a taller torso, since it follows the bottom edge', () => {
    expect(bandPlacement(0.44).offsetY).toBeLessThan(bandPlacement(0.3).offsetY);
  });
});

describe('toDioramaGeometry', () => {
  it('turns a box into a rounded box of the same size', () => {
    const box = new THREE.BoxGeometry(0.42, 0.44, 0.26);
    const rounded = toDioramaGeometry(box);
    expect(rounded).toBeInstanceOf(RoundedBoxGeometry);
    const s = size(rounded);
    expect(s.x).toBeCloseTo(0.42, 5);
    expect(s.y).toBeCloseTo(0.44, 5);
    expect(s.z).toBeCloseTo(0.26, 5);
  });

  it('gives a source geometry the same answer every time', () => {
    const box = new THREE.BoxGeometry(0.28, 0.24, 0.26);
    expect(toDioramaGeometry(box)).toBe(toDioramaGeometry(box));
  });

  it('shares the rounded geometry between sources of the same size', () => {
    const a = new THREE.BoxGeometry(0.11, 0.3, 0.11);
    const b = new THREE.BoxGeometry(0.11, 0.3, 0.11);
    expect(toDioramaGeometry(a)).toBe(toDioramaGeometry(b));
  });

  it('leaves spheres and cylinders as they are', () => {
    const sphere = new THREE.SphereGeometry(0.22, 12, 12);
    const cylinder = new THREE.CylinderGeometry(0.1, 0.1, 0.4, 8);
    expect(toDioramaGeometry(sphere)).toBe(sphere);
    expect(toDioramaGeometry(cylinder)).toBe(cylinder);
  });

  it('does not round a geometry that is already rounded', () => {
    const rounded = roundedBox(0.3, 0.3, 0.3);
    expect(toDioramaGeometry(rounded)).toBe(rounded);
  });
});

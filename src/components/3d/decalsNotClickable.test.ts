import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { noRaycast } from './sceneDecals';

/**
 * The robot group carries the click handler and R3F raycasts a handler's whole subtree, so a decal
 * mesh inside it is a click target unless it opts out. There is no renderer in a unit test to ask
 * "what does a click here hit?", so the guard is on the source: every <mesh> a decal component draws
 * must pass `raycast={noRaycast}`. (The real behaviour is checked in the browser harness.)
 */
const read = (file: string) => readFileSync(resolve(__dirname, file), 'utf8');
const count = (text: string, needle: RegExp) => (text.match(needle) ?? []).length;

describe.each(['BlobShadow.tsx', 'SelectionMarker.tsx'])('%s', (file) => {
  const source = read(file);

  it('draws at least one mesh', () => {
    expect(count(source, /<mesh\b/g)).toBeGreaterThan(0);
  });

  it('opts every mesh out of pointer hits', () => {
    expect(count(source, /raycast=\{noRaycast\}/g)).toBe(count(source, /<mesh\b/g));
  });
});

describe('noRaycast', () => {
  it('reports no intersections: it neither throws nor adds to the hit list', () => {
    const hits: unknown[] = [];
    expect(noRaycast()).toBeUndefined();
    expect(hits).toHaveLength(0);
  });
});

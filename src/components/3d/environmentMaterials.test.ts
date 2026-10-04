import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * three.js rule: toggling a material's `map` between a texture and null needs `material.needsUpdate`, or the
 * compiled shader keeps (or lacks) its `USE_MAP` define and the floor draws the OTHER look's texture. React
 * Three Fiber assigns the prop and does not set it. The environment toggles the slab texture with the look
 * (`map={diorama ? … : null}`), so each of those materials must be a fresh instance per look — a `key` that
 * changes with `diorama`, which remounts the material. Measured in a real renderer before this guard existed:
 * after diorama -> cyberdrome, 3 of 4 floors had `map === null` and a program still sampling the old texture.
 */
const source = readFileSync(resolve(__dirname, 'CyberdromeEnvironment.tsx'), 'utf8');

/** Every JSX `<meshStandardMaterial … />` in the file, as written. */
const materials = [...source.matchAll(/<meshStandardMaterial\b[\s\S]*?\/>/g)].map((m) => m[0]);

describe('CyberdromeEnvironment floor materials', () => {
  const toggled = materials.filter((tag) => /\bmap=\{diorama\b/.test(tag));

  it('has the slab-textured floors to guard (main floor and each room floor)', () => {
    expect(toggled.length).toBeGreaterThanOrEqual(2);
  });

  it.each(toggled.map((tag, i) => [i, tag] as const))('keys floor material %i by the look, so a look switch builds a new material', (_i, tag) => {
    expect(tag).toMatch(/\bkey=\{diorama\b/);
  });
});

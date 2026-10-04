/**
 * Shared pieces for the diorama style's flat decals — the soft shadow under a robot, the glow pad and
 * corner brackets of a selected one, the pin an attention-needing robot wears.
 *
 * Everything here is built once and shared. A decal appears under every robot (or under the one that
 * is selected), so a texture or geometry per instance would be churn for no benefit; the material
 * (colour, opacity) is the only thing that varies, and that is the caller's.
 */
import * as THREE from 'three';

/** How far above the floor the flat decals sit — clear of the floor panels (0.003) and borders (0.015). */
export const DECAL_Y = 0.03;

/**
 * `raycast` for a mesh the pointer must never hit. The robot group carries the click handler, and
 * R3F raycasts a handler's WHOLE subtree — so a decal inside it (a 2-unit selection pad, a blob
 * shadow) would otherwise select the robot, and snap the camera back to it, on any click or
 * orbit-drag that ends on the floor beside it.
 */
export const noRaycast = (): void => undefined;

// ---------------------------------------------------------------------------
// Soft disc — alpha fades from solid in the middle to nothing at the rim
// ---------------------------------------------------------------------------

let softDisc: THREE.Texture | null = null;

/**
 * A white disc whose alpha falls off toward the rim, tinted by the material colour. Used for the
 * blob shadow under a robot and the glow pad under a selected one.
 *
 * Without a 2D canvas (a unit test) it is a plain 1x1 white texture: the shape is not asserted
 * anywhere that cannot draw it.
 */
export function getSoftDiscTexture(): THREE.Texture {
  if (softDisc) return softDisc;
  const size = 64;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (canvas) {
    canvas.width = size;
    canvas.height = size;
  }
  const ctx = canvas ? canvas.getContext('2d') : null;
  if (canvas && ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.7)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    softDisc = new THREE.CanvasTexture(canvas);
    softDisc.colorSpace = THREE.SRGBColorSpace;
  } else {
    softDisc = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    softDisc.needsUpdate = true;
  }
  return softDisc;
}

// ---------------------------------------------------------------------------
// Marking paint
// ---------------------------------------------------------------------------

/** Lane paint and bay paint, taken from the theme so every palette gets markings that suit it. */
export function markingColors(theme: { grid1: string; stripSecondary: string }): {
  lane: THREE.Color;
  bay: THREE.Color;
} {
  const white = new THREE.Color('#ffffff');
  return {
    // Road paint is white-ish whatever the palette: lean the theme's grid colour toward white.
    lane: new THREE.Color(theme.grid1).lerp(white, 0.6),
    // Bay paint: the theme's accent, eased toward white so a seat's outline reads as paint on the
    // floor, not a neon tube.
    bay: new THREE.Color(theme.stripSecondary).lerp(white, 0.3),
  };
}

// ---------------------------------------------------------------------------
// Ribbed (corrugated) wall panel
// ---------------------------------------------------------------------------

/** Distance between the ribs of a corrugated wall panel. */
export const RIB_PITCH = 0.25;

/** How many ribs a wall `length` units long carries — whole ribs, so the pattern tiles cleanly. */
export function ribCount(length: number): number {
  return Math.max(1, Math.round(length / RIB_PITCH));
}

const ribbedByCount = new Map<number, THREE.Texture>();

/**
 * Corrugated stripes for a wall `length` units long, to be multiplied with the wall colour: lit
 * flank, shaded groove, lit flank. One texture per rib count, shared by every wall of that length.
 * Null where there is no 2D canvas (a unit test) — the wall is then simply plain.
 */
export function getRibbedTexture(length: number): THREE.Texture | null {
  const ribs = ribCount(length);
  const known = ribbedByCount.get(ribs);
  if (known) return known;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas ? canvas.getContext('2d') : null;
  if (!canvas || !ctx) return null;

  canvas.width = 16;
  canvas.height = 4;
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(0.25, '#ececec');
  gradient.addColorStop(0.5, '#b4b4b4');
  gradient.addColorStop(0.75, '#ececec');
  gradient.addColorStop(1, '#ffffff');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(ribs, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  ribbedByCount.set(ribs, texture);
  return texture;
}

// ---------------------------------------------------------------------------
// Flat unit disc
// ---------------------------------------------------------------------------

let disc: THREE.BufferGeometry | null = null;

/** A radius-1 disc already lying flat (facing up); scale a mesh to size it. */
export function getDiscGeometry(): THREE.BufferGeometry {
  if (!disc) disc = new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2);
  return disc;
}

// ---------------------------------------------------------------------------
// Corner brackets
// ---------------------------------------------------------------------------

/** Half the bracketed square, how far each bracket arm reaches along a side, and how thick it is. */
export const BRACKET_HALF = 0.85;
const BRACKET_ARM = 0.34;
const BRACKET_THICK = 0.07;

let brackets: THREE.BufferGeometry | null = null;

/**
 * Four L-shaped corner brackets around a square, flat at y = 0, as one geometry (one draw call).
 * Each L is two rectangles that do not overlap, so a translucent paint shows no darker corner.
 */
export function getBracketGeometry(): THREE.BufferGeometry {
  if (brackets) return brackets;

  /** x0, z0, x1, z1 of each rectangle. */
  const rects: Array<[number, number, number, number]> = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cornerX = sx * BRACKET_HALF;
      const cornerZ = sz * BRACKET_HALF;
      // The arm along X, reaching in from the corner…
      rects.push([cornerX, cornerZ, cornerX - sx * BRACKET_ARM, cornerZ - sz * BRACKET_THICK]);
      // …and the arm along Z, starting just inside it so the corner square is covered only once.
      rects.push([cornerX, cornerZ - sz * BRACKET_THICK, cornerX - sx * BRACKET_THICK, cornerZ - sz * BRACKET_ARM]);
    }
  }

  const positions: number[] = [];
  const indices: number[] = [];
  for (const [ax, az, bx, bz] of rects) {
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const z0 = Math.min(az, bz);
    const z1 = Math.max(az, bz);
    const base = positions.length / 3;
    positions.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
    // Wound to face up (the material is double-sided as well, so culling can never hide them).
    indices.push(base, base + 3, base + 1, base + 1, base + 3, base + 2);
  }

  brackets = new THREE.BufferGeometry();
  brackets.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  brackets.setIndex(indices);
  return brackets;
}

// ---------------------------------------------------------------------------
// Pin
// ---------------------------------------------------------------------------

let pinHead: THREE.BufferGeometry | null = null;
let pinTip: THREE.BufferGeometry | null = null;

/** The round head of a map pin, radius 0.1, centred on its own origin. */
export function getPinHeadGeometry(): THREE.BufferGeometry {
  if (!pinHead) pinHead = new THREE.SphereGeometry(0.1, 16, 12);
  return pinHead;
}

/** The tapering point of a map pin: apex DOWN at y = -0.1, base up at y = +0.1. */
export function getPinTipGeometry(): THREE.BufferGeometry {
  if (!pinTip) pinTip = new THREE.ConeGeometry(0.095, 0.2, 16).rotateX(Math.PI);
  return pinTip;
}

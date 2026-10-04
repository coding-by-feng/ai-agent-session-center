/**
 * Shared 3D robot geometry, materials, and palettes.
 * Ported from docs/3D/index.html lines 425-456.
 * All geometries created once and shared across all robot instances.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Color Palette (16 cyberpunk neon colors)
// ---------------------------------------------------------------------------

// Lives in its own Three-free module so 2D consumers (DetailPanel,
// FloatingTerminalPanel) can import the colors without pulling in Three.js.
// Re-exported here so 3D code keeps its single import site.
export { PALETTE } from './robotPalette';
import { PALETTE } from './robotPalette';
import { CLAY_PAINT, type ClayTone } from './dioramaLighting';

// ---------------------------------------------------------------------------
// Shared Body Geometries (10 parts)
// ---------------------------------------------------------------------------

export const robotGeo = {
  head: new THREE.BoxGeometry(0.28, 0.24, 0.26),
  visor: new THREE.BoxGeometry(0.24, 0.065, 0.02),
  antenna: new THREE.CylinderGeometry(0.007, 0.007, 0.14, 4),
  aTip: new THREE.SphereGeometry(0.02, 6, 6),
  torso: new THREE.BoxGeometry(0.32, 0.38, 0.2),
  core: new THREE.SphereGeometry(0.032, 8, 8),
  joint: new THREE.SphereGeometry(0.035, 8, 8),
  arm: new THREE.BoxGeometry(0.08, 0.26, 0.08),
  leg: new THREE.BoxGeometry(0.09, 0.28, 0.09),
  foot: new THREE.BoxGeometry(0.1, 0.045, 0.12),
};

// ---------------------------------------------------------------------------
// Edge Geometries (4 parts — wireframe outlines)
// ---------------------------------------------------------------------------

export const robotEdgeGeo = {
  head: new THREE.EdgesGeometry(robotGeo.head),
  torso: new THREE.EdgesGeometry(robotGeo.torso),
  arm: new THREE.EdgesGeometry(robotGeo.arm),
  leg: new THREE.EdgesGeometry(robotGeo.leg),
};

// ---------------------------------------------------------------------------
// Shared Metallic Body Materials
// ---------------------------------------------------------------------------

export const metalMat = new THREE.MeshStandardMaterial({
  color: '#2a2a3e',
  roughness: 0.3,
  metalness: 0.85,
});

export const darkMat = new THREE.MeshStandardMaterial({
  color: '#1c1c2c',
  roughness: 0.4,
  metalness: 0.7,
});

// ---------------------------------------------------------------------------
// Diorama style — matte clay body, livery paint in the session colour
// ---------------------------------------------------------------------------

function createClay(tone: ClayTone) {
  return {
    /** Matte body (head, torso, feet). */
    body: new THREE.MeshStandardMaterial({ color: CLAY_PAINT[tone].body, roughness: 0.62, metalness: 0 }),
    /** A darker clay for the parts that should recede (antenna, legs). */
    shade: new THREE.MeshStandardMaterial({ color: CLAY_PAINT[tone].shade, roughness: 0.7, metalness: 0 }),
  };
}

const clay: Record<ClayTone, ReturnType<typeof createClay>> = {
  standard: createClay('standard'),
  deep: createClay('deep'),
};

/**
 * The diorama's clay materials for a tone — shared, so a caller that animates one clones it. The tone is
 * a parameter and the materials are NOT exported on their own: a bare `clayMat` would be one paint for
 * every palette, which is exactly how the robot ended up white on white (see `CLAY_PAINT`).
 */
export function clayMaterials(tone: ClayTone) {
  return clay[tone];
}

/**
 * Matte paint in a session's colour — the arms and the chest band, where the neon style used glowing
 * metal. A little emissive keeps the colour from going muddy in a dim scene.
 */
export function createLiveryMat(hex: string): THREE.MeshStandardMaterial {
  const c = new THREE.Color(hex);
  return new THREE.MeshStandardMaterial({
    color: c,
    emissive: c,
    emissiveIntensity: 0.28,
    roughness: 0.55,
    metalness: 0,
  });
}

// ---------------------------------------------------------------------------
// Per-Color Material Factories
// ---------------------------------------------------------------------------

export function createNeonMat(hex: string): THREE.MeshStandardMaterial {
  const c = new THREE.Color(hex);
  return new THREE.MeshStandardMaterial({
    color: c,
    emissive: c,
    emissiveIntensity: 2,
    roughness: 0.2,
    metalness: 0.3,
  });
}

export function createEdgeMat(hex: string): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color: hex,
    transparent: true,
    opacity: 0.3,
  });
}

// ---------------------------------------------------------------------------
// Pre-built Per-Palette Material Pools
// ---------------------------------------------------------------------------

export const neonMats = PALETTE.map((h) => createNeonMat(h));
export const edgeMats = PALETTE.map((h) => createEdgeMat(h));
export const liveryMats = PALETTE.map((h) => createLiveryMat(h));


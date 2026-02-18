/**
 * Shared 3D robot geometry, materials, and palettes.
 * Ported from docs/3D/index.html lines 425-456.
 * All geometries created once and shared across all robot instances.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Color Palette (16 cyberpunk neon colors)
// ---------------------------------------------------------------------------

export const PALETTE = [
  '#00f0ff', '#ff00aa', '#a855f7', '#00ff88',
  '#ff4444', '#ffaa00', '#00aaff', '#ff66ff',
  '#44ff44', '#ff8800', '#8855ff', '#00ffcc',
  '#ff0066', '#ccff00', '#ff5577', '#33ddff',
] as const;

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


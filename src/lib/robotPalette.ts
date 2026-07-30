/**
 * The 16 cyberpunk neon accent colors, used both to tint 3D robots and to color
 * 2D session UI (detail panel header, floating terminal chrome).
 *
 * Deliberately its own module with NO imports. It used to live in
 * `robot3DGeometry.ts`, which does `import * as THREE from 'three'` and builds
 * materials at module scope — so DetailPanel and FloatingTerminalPanel, both
 * eagerly loaded and neither of them 3D, dragged all ~1.2 MB of Three.js into
 * the app's boot path for the sake of sixteen hex strings.
 *
 * Keep this file dependency-free.
 */
export const PALETTE = [
  '#00f0ff', '#ff00aa', '#a855f7', '#00ff88',
  '#ff4444', '#ffaa00', '#00aaff', '#ff66ff',
  '#44ff44', '#ff8800', '#8855ff', '#00ffcc',
  '#ff0066', '#ccff00', '#ff5577', '#33ddff',
] as const;

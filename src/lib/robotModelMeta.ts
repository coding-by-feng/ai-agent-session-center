/**
 * Robot model variant identity — the type union plus the human-readable label
 * and description shown in Settings ▸ Theme.
 *
 * Deliberately its own module with NO imports. This metadata used to live in
 * `robot3DModels.ts`, which does `import * as THREE from 'three'` and builds
 * BoxGeometry/SphereGeometry at module scope — so ThemeSettings, an eagerly
 * loaded 2D settings panel, dragged all ~1.2 MB of Three.js into the app's boot
 * path just to render six radio-button labels.
 *
 * Keep this file dependency-free. `robot3DModels.ts` re-exports these so 3D code
 * keeps a single import site.
 */

export type RobotModelType = 'robot' | 'mech' | 'drone' | 'spider' | 'orb' | 'tank';

export const ROBOT_MODEL_TYPES: RobotModelType[] = [
  'robot', 'mech', 'drone', 'spider', 'orb', 'tank',
];

interface RobotModelMeta {
  label: string;
  description: string;
}

const MODEL_META: Record<RobotModelType, RobotModelMeta> = {
  robot: { label: 'Robot', description: 'Standard humanoid robot' },
  mech: { label: 'Mech', description: 'Bulkier torso, wider stance, angular head' },
  drone: { label: 'Drone', description: 'Smaller hovering unit with antenna array' },
  spider: { label: 'Spider', description: 'Low body with 4 stubby legs' },
  orb: { label: 'Orb', description: 'Spherical body with stubby arms and short legs' },
  tank: { label: 'Tank', description: 'Wide body with one thick arm, treads for legs' },
};

export function getModelLabel(type: RobotModelType): string {
  return MODEL_META[type]?.label ?? 'Robot';
}

export function getModelDescription(type: RobotModelType): string {
  return MODEL_META[type]?.description ?? '';
}

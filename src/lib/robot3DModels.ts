/**
 * Robot 3D model variant definitions.
 * Each variant shares the same skeletal structure (head, torso, arms, legs)
 * but with different proportions, shapes, and visual characteristics.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RobotModelType = 'robot' | 'mech' | 'drone' | 'spider' | 'orb' | 'tank';

export interface PartOverride {
  geometry?: THREE.BufferGeometry;
  position?: [number, number, number];
  scale?: [number, number, number];
  visible?: boolean;
}

export interface ModelDef {
  type: RobotModelType;
  label: string;
  description: string;
  head: PartOverride;
  torso: PartOverride;
  armL: PartOverride;
  armR: PartOverride;
  legL: PartOverride;
  legR: PartOverride;
  /** Whether this model hovers (no ground contact) */
  hovers: boolean;
  /** Base Y offset for the whole model */
  baseY: number;
}

// ---------------------------------------------------------------------------
// Model Definitions
// ---------------------------------------------------------------------------

const modelDefs: Record<RobotModelType, ModelDef> = {
  robot: {
    type: 'robot',
    label: 'Robot',
    description: 'Standard humanoid robot',
    head: {},
    torso: {},
    armL: {},
    armR: {},
    legL: { visible: false },
    legR: { visible: false },
    hovers: true,
    baseY: 0.2,
  },

  mech: {
    type: 'mech',
    label: 'Mech',
    description: 'Bulkier torso, wider stance, angular head',
    head: {
      geometry: new THREE.BoxGeometry(0.34, 0.2, 0.3),
      position: [0, 1.36, 0],
    },
    torso: {
      geometry: new THREE.BoxGeometry(0.42, 0.44, 0.26),
      position: [0, 0.87, 0],
    },
    armL: {
      geometry: new THREE.BoxGeometry(0.11, 0.3, 0.11),
      position: [-0.27, 1.07, 0],
    },
    armR: {
      geometry: new THREE.BoxGeometry(0.11, 0.3, 0.11),
      position: [0.27, 1.07, 0],
    },
    legL: { visible: false },
    legR: { visible: false },
    hovers: true,
    baseY: 0.2,
  },

  drone: {
    type: 'drone',
    label: 'Drone',
    description: 'Smaller hovering unit with antenna array',
    head: {
      geometry: new THREE.SphereGeometry(0.14, 8, 8),
      position: [0, 1.2, 0],
    },
    torso: {
      geometry: new THREE.BoxGeometry(0.28, 0.18, 0.28),
      position: [0, 0.95, 0],
    },
    armL: {
      geometry: new THREE.BoxGeometry(0.22, 0.04, 0.06),
      position: [-0.25, 0.95, 0],
    },
    armR: {
      geometry: new THREE.BoxGeometry(0.22, 0.04, 0.06),
      position: [0.25, 0.95, 0],
    },
    legL: { visible: false },
    legR: { visible: false },
    hovers: true,
    baseY: 0.3,
  },

  spider: {
    type: 'spider',
    label: 'Spider',
    description: 'Low body with 4 stubby legs',
    head: {
      geometry: new THREE.SphereGeometry(0.12, 8, 8),
      position: [0, 0.85, 0.1],
    },
    torso: {
      geometry: new THREE.BoxGeometry(0.36, 0.14, 0.32),
      position: [0, 0.65, 0],
    },
    armL: {
      geometry: new THREE.BoxGeometry(0.06, 0.22, 0.06),
      position: [-0.2, 0.65, -0.12],
      scale: [1, 1, 1],
    },
    armR: {
      geometry: new THREE.BoxGeometry(0.06, 0.22, 0.06),
      position: [0.2, 0.65, -0.12],
      scale: [1, 1, 1],
    },
    legL: { visible: false },
    legR: { visible: false },
    hovers: true,
    baseY: 0.05,
  },

  orb: {
    type: 'orb',
    label: 'Orb',
    description: 'Spherical body with stubby arms and short legs',
    head: {
      geometry: new THREE.SphereGeometry(0.1, 8, 8),
      position: [0, 1.28, 0],
    },
    torso: {
      geometry: new THREE.SphereGeometry(0.22, 12, 12),
      position: [0, 0.92, 0],
    },
    armL: {
      geometry: new THREE.BoxGeometry(0.06, 0.18, 0.06),
      position: [-0.24, 0.92, 0],
    },
    armR: {
      geometry: new THREE.BoxGeometry(0.06, 0.18, 0.06),
      position: [0.24, 0.92, 0],
    },
    legL: { visible: false },
    legR: { visible: false },
    hovers: true,
    baseY: 0.2,
  },

  tank: {
    type: 'tank',
    label: 'Tank',
    description: 'Wide body with one thick arm, treads for legs',
    head: {
      geometry: new THREE.BoxGeometry(0.24, 0.18, 0.22),
      position: [0, 1.24, 0],
    },
    torso: {
      geometry: new THREE.BoxGeometry(0.44, 0.3, 0.26),
      position: [0, 0.87, 0],
    },
    armL: { visible: false },
    armR: {
      geometry: new THREE.BoxGeometry(0.14, 0.34, 0.14),
      position: [0.3, 0.87, 0],
    },
    legL: { visible: false },
    legR: { visible: false },
    hovers: true,
    baseY: 0.15,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const ROBOT_MODEL_TYPES: RobotModelType[] = [
  'robot', 'mech', 'drone', 'spider', 'orb', 'tank',
];

export function getModelDef(type: RobotModelType): ModelDef {
  return modelDefs[type] ?? modelDefs.robot;
}

export function getModelLabel(type: RobotModelType): string {
  return modelDefs[type]?.label ?? 'Robot';
}

export function getModelDescription(type: RobotModelType): string {
  return modelDefs[type]?.description ?? '';
}

/**
 * Robot3DModel -- Single robot mesh + animation loop.
 * Ported from docs/3D/index.html Robot class, adapted for React Three Fiber.
 *
 * Enhancements:
 * - WS4.A: CLI source accent color override
 * - WS7.B: Alert urgency escalation (visor flashing)
 * - WS7.C: Tool-specific working animations
 */
import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text, Billboard } from '@react-three/drei';
import * as THREE from 'three';
import {
  robotGeo,
  metalMat,
  darkMat,
  neonMats,
  edgeMats,
  createNeonMat,
  createEdgeMat,
  PALETTE,
} from '@/lib/robot3DGeometry';
import type { Robot3DState } from '@/lib/robotStateMap';
import { getModelDef, type RobotModelType } from '@/lib/robot3DModels';
import { useSettingsStore } from '@/stores/settingsStore';

// Pre-created visor override materials (shared, never disposed)
const ALERT_VISOR_MAT = createNeonMat('#ffdd00');
const INPUT_VISOR_MAT = createNeonMat('#aa66ff');
const OFFLINE_VISOR_MAT = createNeonMat('#333344');

// ---------------------------------------------------------------------------
// Tool Category Mapping for WS7.C
// ---------------------------------------------------------------------------

type ToolAnimCategory = 'read' | 'write' | 'bash' | 'web' | 'task' | 'default';

function classifyTool(toolName: string | null): ToolAnimCategory {
  if (!toolName) return 'default';
  const t = toolName.toLowerCase();
  if (t === 'read' || t === 'grep' || t === 'glob' || t === 'notebookedit') return 'read';
  if (t === 'write' || t === 'edit') return 'write';
  if (t === 'bash') return 'bash';
  if (t === 'webfetch' || t === 'websearch') return 'web';
  if (t === 'task') return 'task';
  return 'default';
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** CLI badge configuration for the robot's chest emblem */
export interface CliBadge {
  letter: string;
  color: string;
}

export interface Robot3DModelProps {
  neonColor: string;
  state: Robot3DState;
  scale?: number;
  rotation?: number;
  modelType?: RobotModelType;
  /** Ref tracking whether the robot is seated at a desk (read in useFrame, no re-render) */
  seatedRef?: React.RefObject<boolean>;
  /** CLI source badge rendered on the robot's chest */
  cliBadge?: CliBadge;
  /** Current active tool name (for tool-specific working animations) */
  currentTool?: string | null;
  /** Timestamp (ms) when the current status started (for urgency + progress timer) */
  statusStartTime?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Robot3DModel({
  neonColor,
  state,
  scale: scaleProp = 1,
  rotation = 0,
  modelType = 'robot',
  seatedRef,
  cliBadge,
  currentTool = null,
  statusStartTime,
}: Robot3DModelProps) {
  // Model variant overrides
  const modelDef = useMemo(() => getModelDef(modelType), [modelType]);
  const groupRef = useRef<THREE.Group>(null);
  const aTipRef = useRef<THREE.Mesh>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const bodyMeshRef = useRef<THREE.Mesh>(null);
  const bodyEdgeRef = useRef<THREE.LineSegments>(null);
  const visorRef = useRef<THREE.Mesh>(null);
  const armLRef = useRef<THREE.Group>(null);
  const armRRef = useRef<THREE.Group>(null);
  const legLRef = useRef<THREE.Group>(null);
  const legRRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Mesh>(null);

  const phase = useMemo(() => Math.random() * Math.PI * 2, []);
  const connectStartTime = useRef<number | null>(null);

  // Memoize tool category
  const toolCategory = useMemo(() => classifyTool(currentTool), [currentTool]);

  // Resolve materials -- use pre-built palette pool if color matches, else create
  const { neonMat, edgeMat, isCustom } = useMemo(() => {
    const idx = (PALETTE as readonly string[]).indexOf(neonColor);
    if (idx >= 0) {
      return { neonMat: neonMats[idx], edgeMat: edgeMats[idx], isCustom: false };
    }
    return {
      neonMat: createNeonMat(neonColor),
      edgeMat: createEdgeMat(neonColor),
      isCustom: true,
    };
  }, [neonColor]);

  // Per-instance body materials: animations mutate emissive/color each frame,
  // so every robot needs its own clone to avoid cross-contamination of the shared pool.
  const bodyMat = useMemo(() => metalMat.clone(), []);
  const bodyEdgeMat = useMemo(() => edgeMat.clone(), [edgeMat]);

  // Dispose materials on unmount or color change
  useEffect(() => {
    return () => {
      if (isCustom) {
        neonMat.dispose();
        edgeMat.dispose();
      }
      bodyMat.dispose();
      bodyEdgeMat.dispose();
    };
  }, [neonMat, edgeMat, isCustom, bodyMat, bodyEdgeMat]);

  // Track status duration for urgency escalation
  const statusElapsed = useRef(0);
  useEffect(() => {
    statusElapsed.current = 0;
  }, [state]);

  // Animation loop — reads settings imperatively (no Zustand subscription)
  useFrame((_, delta) => {
    const settings = useSettingsStore.getState();
    const animSpeed = settings.animationSpeed / 100;
    const ai = settings.animationIntensity / 100;
    const t = (performance.now() / 1000) * animSpeed;
    const dt = Math.min(delta, 0.1);
    const group = groupRef.current;
    if (!group) return;

    // Track status elapsed time
    statusElapsed.current += dt;
    const elapsed = statusStartTime
      ? (Date.now() - statusStartTime) / 1000
      : statusElapsed.current;

    // Antenna tip + core pulse (always active)
    if (aTipRef.current) {
      let tipScale = 0.8 + ((Math.sin(t * 6 + phase) + 1) * 0.5) * 0.4 * ai;
      // WS7.C: WebFetch/WebSearch = brighter antenna
      if (state === 'working' && toolCategory === 'web') {
        tipScale = 1.0 + Math.sin(t * 8 + phase) * 0.3 * ai;
        const mat = aTipRef.current.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = 3 + Math.sin(t * 10) * 1.5;
      }
      aTipRef.current.scale.setScalar(tipScale);
    }
    if (coreRef.current) {
      coreRef.current.scale.setScalar(0.9 + Math.sin(t * 3 + phase) * 0.12 * ai);
    }

    // State-specific animations
    switch (state) {
      case 'idle':
        animateIdle(t, dt, phase, ai);
        break;
      case 'thinking':
        animateThinking(t, dt, phase, ai);
        break;
      case 'working':
        animateWorking(t, dt, phase, ai);
        break;
      case 'waiting':
        animateWaiting(t, dt, phase, ai);
        break;
      case 'alert':
        animateAlert(t, dt, phase, ai, elapsed);
        break;
      case 'input':
        animateInput(t, dt, phase, ai);
        break;
      case 'offline':
        animateOffline(t, dt);
        break;
      case 'connecting':
        animateConnecting(t, dt);
        break;
    }

  });

  // --- Animation functions ---

  /** Reset body emissive glow that working state applies. */
  function resetBodyCharge() {
    if (bodyMeshRef.current) {
      const bodyMtl = bodyMeshRef.current.material as THREE.MeshStandardMaterial;
      if (bodyMtl.emissive) {
        bodyMtl.emissive.set('#000000');
        bodyMtl.emissiveIntensity = 0;
      }
    }
    if (bodyEdgeRef.current) {
      const edgeMtl = bodyEdgeRef.current.material as THREE.LineBasicMaterial;
      edgeMtl.color.set(neonColor);
      edgeMtl.opacity = 0.5;
    }
    if (coreRef.current) {
      (coreRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.0;
    }
    if (visorRef.current && state !== 'alert' && state !== 'input') {
      (visorRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.5;
    }
  }

  function animateIdle(t: number, _dt: number, ph: number, ai: number) {
    resetBodyCharge();
    const group = groupRef.current!;
    group.position.y = Math.sin(t * 1.5 + ph) * 0.02 * ai;
    if (armLRef.current) armLRef.current.rotation.x = Math.sin(t * 0.8 + ph) * 0.08 * ai;
    if (armRRef.current) armRRef.current.rotation.x = -Math.sin(t * 0.8 + ph) * 0.08 * ai;
    if (legLRef.current) legLRef.current.rotation.x = 0;
    if (legRRef.current) legRRef.current.rotation.x = 0;
    if (bodyMeshRef.current) bodyMeshRef.current.rotation.z = Math.sin(t * 0.5 + ph) * 0.01 * ai;
    if (bodyEdgeRef.current) bodyEdgeRef.current.rotation.z = Math.sin(t * 0.5 + ph) * 0.01 * ai;
  }

  function animateThinking(t: number, _dt: number, ph: number, ai: number) {
    resetBodyCharge();
    const group = groupRef.current!;
    if (seatedRef?.current) {
      // Seated thinking: head tilted, right arm raised in chin-scratch pose
      group.position.y = Math.sin(t * 0.8 + ph) * 0.005 * ai;
      if (headRef.current) {
        headRef.current.rotation.z = 0.12 + Math.sin(t * 0.5 + ph) * 0.04 * ai;
        headRef.current.rotation.x = -0.08;
      }
      if (armRRef.current) armRRef.current.rotation.x = -1.1 + Math.sin(t * 1.8 + ph) * 0.06 * ai;
      if (armLRef.current) armLRef.current.rotation.x = -0.3 + Math.sin(t * 0.5 + ph) * 0.02 * ai;
      if (legLRef.current) legLRef.current.rotation.x = 1.2;
      if (legRRef.current) legRRef.current.rotation.x = 1.2;
      if (bodyMeshRef.current) bodyMeshRef.current.rotation.z = Math.sin(t * 0.4 + ph) * 0.008 * ai;
      if (bodyEdgeRef.current) bodyEdgeRef.current.rotation.z = Math.sin(t * 0.4 + ph) * 0.008 * ai;
    } else {
      group.position.y = Math.sin(t * 1.2 + ph) * 0.015 * ai;
      if (headRef.current) {
        headRef.current.rotation.z = Math.sin(t * 0.6 + ph) * 0.08 * ai;
        headRef.current.rotation.x = 0;
      }
      if (armRRef.current) armRRef.current.rotation.x = -0.6 + Math.sin(t * 1.5 + ph) * 0.05 * ai;
      if (armLRef.current) armLRef.current.rotation.x = Math.sin(t * 0.7 + ph) * 0.06 * ai;
      if (legLRef.current) legLRef.current.rotation.x = 0;
      if (legRRef.current) legRRef.current.rotation.x = 0;
    }
  }

  function animateWorking(t: number, _dt: number, ph: number, ai: number) {
    // WS7.C: Tool-specific working animations
    switch (toolCategory) {
      case 'read': {
        // Head scanning left-right
        if (headRef.current) headRef.current.rotation.y = Math.sin(t * 2.5 + ph) * 0.35 * ai;
        if (headRef.current) headRef.current.rotation.z = 0;
        const ty = Math.sin(t * 6 + ph) * 0.03 * ai;
        if (armLRef.current) armLRef.current.rotation.x = -0.4 + ty;
        if (armRRef.current) armRRef.current.rotation.x = -0.4 - ty;
        break;
      }
      case 'write': {
        // Rapid arm typing
        const ty = Math.sin(t * 14 + ph) * 0.07 * ai;
        if (armLRef.current) armLRef.current.rotation.x = -0.6 + ty;
        if (armRRef.current) armRRef.current.rotation.x = -0.6 - ty;
        if (headRef.current) {
          headRef.current.rotation.y = 0;
          headRef.current.rotation.z = Math.sin(t * 0.8 + ph) * 0.02 * ai;
        }
        break;
      }
      case 'bash': {
        // One arm extended forward
        if (armRRef.current) armRRef.current.rotation.x = -0.9 + Math.sin(t * 2 + ph) * 0.04 * ai;
        if (armLRef.current) armLRef.current.rotation.x = -0.3 + Math.sin(t * 4 + ph) * 0.03 * ai;
        if (headRef.current) {
          headRef.current.rotation.y = 0;
          headRef.current.rotation.z = 0;
        }
        break;
      }
      case 'task': {
        // Both arms raised slightly
        if (armLRef.current) armLRef.current.rotation.x = -0.8 + Math.sin(t * 1.5 + ph) * 0.05 * ai;
        if (armRRef.current) armRRef.current.rotation.x = -0.8 - Math.sin(t * 1.5 + ph) * 0.05 * ai;
        if (headRef.current) {
          headRef.current.rotation.y = Math.sin(t * 0.7 + ph) * 0.1 * ai;
          headRef.current.rotation.z = 0;
        }
        break;
      }
      default: {
        // Default working (original)
        const ty = Math.sin(t * 10 + ph) * 0.05 * ai;
        if (armLRef.current) armLRef.current.rotation.x = -0.5 + ty;
        if (armRRef.current) armRRef.current.rotation.x = -0.5 - ty;
        if (headRef.current) {
          headRef.current.rotation.y = 0;
          headRef.current.rotation.z = 0;
        }
        break;
      }
    }

    if (seatedRef?.current) {
      // Seated: legs bent at desk
      if (legLRef.current) legLRef.current.rotation.x = 1.2;
      if (legRRef.current) legRRef.current.rotation.x = 1.2;
    } else {
      // Walking to desk: legs animate walking motion
      if (legLRef.current) legLRef.current.rotation.x = Math.sin(t * 8 + ph) * 0.3 * ai;
      if (legRRef.current) legRRef.current.rotation.x = -Math.sin(t * 8 + ph) * 0.3 * ai;
    }
    if (bodyMeshRef.current) bodyMeshRef.current.rotation.z = Math.sin(t * 0.7 + ph) * 0.012 * ai;
    if (bodyEdgeRef.current) bodyEdgeRef.current.rotation.z = Math.sin(t * 0.7 + ph) * 0.012 * ai;

    // === CHARGING BODY EFFECT ===
    // Robot looks electrified: wireframe edges glow brighter, core surges,
    // visor intensifies, rapid energy flicker across the whole body.

    // Edge wireframe: electric surge flicker (rapid emissive intensity oscillation)
    if (bodyEdgeRef.current) {
      const edgeMtl = bodyEdgeRef.current.material as THREE.LineBasicMaterial;
      const surge = 1.0 + Math.sin(t * 12 + ph) * 0.4 + Math.sin(t * 23 + ph * 2) * 0.3;
      edgeMtl.opacity = Math.min(1, 0.6 + surge * 0.2);
    }

    // Core glow: rapid pulsing energy charge
    if (coreRef.current) {
      const coreMtl = coreRef.current.material as THREE.MeshStandardMaterial;
      coreMtl.emissiveIntensity = 2.0 + Math.sin(t * 8 + ph) * 1.2 + Math.sin(t * 19) * 0.6;
    }

    // Visor: brightened and flickering like it's processing hard
    if (visorRef.current) {
      const visorMtl = visorRef.current.material as THREE.MeshStandardMaterial;
      visorMtl.emissiveIntensity = 2.0 + Math.sin(t * 10 + ph) * 0.8 + Math.sin(t * 17) * 0.4;
    }

    // Antenna tip: energy crackle
    if (aTipRef.current) {
      const tipMtl = aTipRef.current.material as THREE.MeshStandardMaterial;
      tipMtl.emissiveIntensity = 2.5 + Math.sin(t * 15 + ph) * 1.5;
      const tipFlicker = 1.0 + Math.sin(t * 20 + ph) * 0.15 * ai;
      aTipRef.current.scale.setScalar(tipFlicker);
    }

    // Body mesh: subtle brightness boost (metallic sheen under charge)
    if (bodyMeshRef.current) {
      const bodyMtl = bodyMeshRef.current.material as THREE.MeshStandardMaterial;
      if (bodyMtl.emissive) {
        bodyMtl.emissive.set(neonColor);
        bodyMtl.emissiveIntensity = 0.15 + Math.sin(t * 14 + ph) * 0.1;
      }
    }
  }

  function animateWaiting(t: number, _dt: number, ph: number, ai: number) {
    resetBodyCharge();
    const group = groupRef.current!;
    group.position.y = Math.abs(Math.sin(t * 2 + ph)) * 0.06 * ai;
    if (headRef.current) headRef.current.rotation.y = Math.sin(t * 0.8 + ph) * 0.3 * ai;
    if (armLRef.current) armLRef.current.rotation.x = Math.sin(t * 1.2 + ph) * 0.12 * ai;
    if (armRRef.current) armRRef.current.rotation.x = -Math.sin(t * 1.2 + ph) * 0.12 * ai;
    if (legLRef.current) legLRef.current.rotation.x = 0;
    if (legRRef.current) legRRef.current.rotation.x = 0;
  }

  function animateAlert(t: number, _dt: number, ph: number, ai: number, elapsed: number) {
    const group = groupRef.current!;
    if (visorRef.current) {
      // Urgency-scaled visor intensity
      const baseIntensity = elapsed > 30 ? 2.5 : 1.5;
      const pulseRange = elapsed > 30 ? 1.5 : 1.0;
      const pulseSpeed = elapsed > 15 ? 12 : 8;
      const intensity = baseIntensity + Math.sin(t * pulseSpeed) * pulseRange;
      (visorRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = intensity;
    }
    if (seatedRef?.current) {
      group.position.y = Math.abs(Math.sin(t * 6 + ph)) * 0.03 * ai;
      if (armLRef.current) armLRef.current.rotation.x = -1.2 + Math.sin(t * 8 + ph) * 0.2 * ai;
      if (armRRef.current) armRRef.current.rotation.x = -1.2 - Math.sin(t * 8 + ph) * 0.2 * ai;
      if (legLRef.current) legLRef.current.rotation.x = 1.2;
      if (legRRef.current) legRRef.current.rotation.x = 1.2;
      if (headRef.current) headRef.current.rotation.z = Math.sin(t * 10 + ph) * 0.05 * ai;
    } else {
      group.position.y = Math.abs(Math.sin(t * 6 + ph)) * 0.08 * ai;
      // WS7.B: 30s+ subtle shake
      const shake = elapsed > 30 ? Math.sin(t * 16 + ph) * 0.03 * ai : Math.sin(t * 12 + ph) * 0.02 * ai;
      group.position.x = shake;
      if (armLRef.current) armLRef.current.rotation.x = -1.2 + Math.sin(t * 8 + ph) * 0.2 * ai;
      if (armRRef.current) armRRef.current.rotation.x = -1.2 - Math.sin(t * 8 + ph) * 0.2 * ai;
      if (legLRef.current) legLRef.current.rotation.x = 0;
      if (legRRef.current) legRRef.current.rotation.x = 0;
      if (headRef.current) headRef.current.rotation.z = 0;
    }
  }

  function animateInput(t: number, _dt: number, ph: number, ai: number) {
    const group = groupRef.current!;
    if (visorRef.current) {
      const intensity = 1.5 + Math.sin(t * 4) * 0.8;
      (visorRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = intensity;
    }
    if (seatedRef?.current) {
      group.position.y = Math.sin(t * 1.5 + ph) * 0.01 * ai;
      if (armRRef.current) armRRef.current.rotation.x = -1.5 + Math.sin(t * 2 + ph) * 0.1 * ai;
      if (armLRef.current) armLRef.current.rotation.x = -0.3 + Math.sin(t * 0.5 + ph) * 0.03 * ai;
      if (legLRef.current) legLRef.current.rotation.x = 1.2;
      if (legRRef.current) legRRef.current.rotation.x = 1.2;
    } else {
      group.position.y = Math.sin(t * 2 + ph) * 0.03 * ai;
      group.rotation.y = rotation + Math.sin(t * 0.8 + ph) * 0.06 * ai;
      if (armRRef.current) armRRef.current.rotation.x = -1.5 + Math.sin(t * 2 + ph) * 0.1 * ai;
      if (armLRef.current) armLRef.current.rotation.x = Math.sin(t * 0.7 + ph) * 0.05 * ai;
      if (legLRef.current) legLRef.current.rotation.x = 0;
      if (legRRef.current) legRRef.current.rotation.x = 0;
    }
  }

  function animateOffline(_t: number, _dt: number) {
    const group = groupRef.current!;
    if (visorRef.current) {
      const mat = visorRef.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = Math.max(0, mat.emissiveIntensity - 0.02);
    }
    if (coreRef.current) {
      const mat = coreRef.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = Math.max(0, mat.emissiveIntensity - 0.02);
    }

    if (seatedRef?.current) {
      group.position.y = 0;
      if (headRef.current) {
        headRef.current.rotation.x = 0.3;
        headRef.current.rotation.z = 0.1;
      }
      if (armLRef.current) armLRef.current.rotation.x = 0.3;
      if (armRRef.current) armRRef.current.rotation.x = 0.3;
      if (legLRef.current) legLRef.current.rotation.x = 1.2;
      if (legRRef.current) legRRef.current.rotation.x = 1.2;
      if (bodyMeshRef.current) bodyMeshRef.current.rotation.x = 0.15;
      if (bodyEdgeRef.current) bodyEdgeRef.current.rotation.x = 0.15;
    } else {
      group.position.y = -0.05;
      if (armLRef.current) armLRef.current.rotation.x = 0.1;
      if (armRRef.current) armRRef.current.rotation.x = 0.1;
      if (legLRef.current) legLRef.current.rotation.x = 0;
      if (legRRef.current) legRRef.current.rotation.x = 0;
    }
  }

  function animateConnecting(_t: number, _dt: number) {
    if (connectStartTime.current === null) {
      connectStartTime.current = performance.now() / 1000;
    }
    const elapsed = performance.now() / 1000 - connectStartTime.current;
    const progress = Math.min(elapsed / 1.5, 1); // 1.5s boot animation
    const group = groupRef.current!;
    const s = progress * scaleProp;
    group.scale.setScalar(s);
    group.position.y = (1 - progress) * 0.5;
  }

  // Reset connectStartTime when leaving connecting state
  useEffect(() => {
    if (state !== 'connecting') {
      connectStartTime.current = null;
    }
  }, [state]);

  // Visor material: override color for alert/input states (pre-created statics)
  const visorMat = useMemo(() => {
    if (state === 'alert') return ALERT_VISOR_MAT;
    if (state === 'input') return INPUT_VISOR_MAT;
    if (state === 'offline') return OFFLINE_VISOR_MAT;
    return neonMat;
  }, [state, neonMat]);

  // Resolve geometry: model-specific overrides or defaults
  const headGeo = modelDef.head.geometry ?? robotGeo.head;
  const headPos = modelDef.head.position ?? [0, 1.32, 0];
  const torsoGeo = modelDef.torso.geometry ?? robotGeo.torso;
  const torsoPos = modelDef.torso.position ?? [0, 0.87, 0];
  const armLGeo = modelDef.armL.geometry ?? robotGeo.arm;
  const armLPos = modelDef.armL.position ?? [-0.21, 1.07, 0];
  const armRGeo = modelDef.armR.geometry ?? robotGeo.arm;
  const armRPos = modelDef.armR.position ?? [0.21, 1.07, 0];
  const legLGeo = modelDef.legL.geometry ?? robotGeo.leg;
  const legLPos = modelDef.legL.position ?? [-0.09, 0.54, 0];
  const legRGeo = modelDef.legR.geometry ?? robotGeo.leg;
  const legRPos = modelDef.legR.position ?? [0.09, 0.54, 0];
  const showArmL = modelDef.armL.visible !== false;
  const showArmR = modelDef.armR.visible !== false;
  const showLegL = modelDef.legL.visible !== false;
  const showLegR = modelDef.legR.visible !== false;

  // Memoize EdgesGeometry instances (skip invisible parts — #88: legs removed)
  const headEdgeGeo = useMemo(() => new THREE.EdgesGeometry(headGeo), [headGeo]);
  const torsoEdgeGeo = useMemo(() => new THREE.EdgesGeometry(torsoGeo), [torsoGeo]);
  const armLEdgeGeo = useMemo(() => showArmL ? new THREE.EdgesGeometry(armLGeo) : null, [armLGeo, showArmL]);
  const armREdgeGeo = useMemo(() => showArmR ? new THREE.EdgesGeometry(armRGeo) : null, [armRGeo, showArmR]);
  const legLEdgeGeo = useMemo(() => showLegL ? new THREE.EdgesGeometry(legLGeo) : null, [legLGeo, showLegL]);
  const legREdgeGeo = useMemo(() => showLegR ? new THREE.EdgesGeometry(legRGeo) : null, [legRGeo, showLegR]);

  // #50: Dispose edge geometries on unmount to prevent GPU memory leaks
  useEffect(() => {
    return () => {
      headEdgeGeo.dispose();
      torsoEdgeGeo.dispose();
      armLEdgeGeo?.dispose();
      armREdgeGeo?.dispose();
      legLEdgeGeo?.dispose();
      legREdgeGeo?.dispose();
    };
  }, [headEdgeGeo, torsoEdgeGeo, armLEdgeGeo, armREdgeGeo, legLEdgeGeo, legREdgeGeo]);

  return (
    <group
      ref={groupRef}
      position={[0, modelDef.baseY, 0]}
      rotation={[0, rotation, 0]}
      scale={state === 'connecting' ? 0 : scaleProp}
    >
      {/* Head */}
      <mesh ref={headRef} geometry={headGeo} material={metalMat} position={headPos as unknown as THREE.Vector3Tuple} castShadow />
      <lineSegments geometry={headEdgeGeo} material={edgeMat} position={headPos as unknown as THREE.Vector3Tuple} />

      {/* Visor */}
      <mesh ref={visorRef} geometry={robotGeo.visor} material={visorMat} position={[headPos[0], headPos[1], (headPos[2] ?? 0) + 0.13]} />

      {/* Antenna */}
      <mesh geometry={robotGeo.antenna} material={darkMat} position={[0.05, (headPos[1] ?? 1.32) + 0.2, 0]} />
      <mesh ref={aTipRef} geometry={robotGeo.aTip} material={neonMat} position={[0.05, (headPos[1] ?? 1.32) + 0.28, 0]} />

      {/* Torso */}
      <mesh ref={bodyMeshRef} geometry={torsoGeo} material={bodyMat} position={torsoPos as unknown as THREE.Vector3Tuple} castShadow />
      <lineSegments ref={bodyEdgeRef} geometry={torsoEdgeGeo} material={bodyEdgeMat} position={torsoPos as unknown as THREE.Vector3Tuple} />

      {/* Core glow */}
      <mesh ref={coreRef} geometry={robotGeo.core} material={neonMat} position={[(torsoPos[0] ?? 0), (torsoPos[1] ?? 0.87) + 0.04, (torsoPos[2] ?? 0) + 0.105]} />

      {/* CLI source badge -- billboard text on chest */}
      {cliBadge && (
        <Billboard
          position={[(torsoPos[0] ?? 0), (torsoPos[1] ?? 0.87) - 0.06, (torsoPos[2] ?? 0) + 0.12]}
          follow
          lockX={false}
          lockY={false}
          lockZ={false}
        >
          <Text
            fontSize={0.14}
            color={cliBadge.color}
            anchorX="center"
            anchorY="middle"
            fontWeight={700}
            outlineWidth={0.01}
            outlineColor="#000000"
          >
            {cliBadge.letter}
            <meshStandardMaterial
              color={cliBadge.color}
              emissive={cliBadge.color}
              emissiveIntensity={0.8}
              toneMapped={false}
            />
          </Text>
        </Billboard>
      )}

      {/* Shoulder joints */}
      {showArmL && <mesh geometry={robotGeo.joint} material={neonMat} position={armLPos as unknown as THREE.Vector3Tuple} />}
      {showArmR && <mesh geometry={robotGeo.joint} material={neonMat} position={armRPos as unknown as THREE.Vector3Tuple} />}

      {/* Left arm pivot */}
      {showArmL && (
        <group ref={armLRef} position={armLPos as unknown as THREE.Vector3Tuple}>
          <mesh geometry={armLGeo} material={darkMat} position={[0, -0.18, 0]} castShadow />
          {armLEdgeGeo && <lineSegments geometry={armLEdgeGeo} material={edgeMat} position={[0, -0.18, 0]} />}
        </group>
      )}

      {/* Right arm pivot */}
      {showArmR && (
        <group ref={armRRef} position={armRPos as unknown as THREE.Vector3Tuple}>
          <mesh geometry={armRGeo} material={darkMat} position={[0, -0.18, 0]} castShadow />
          {armREdgeGeo && <lineSegments geometry={armREdgeGeo} material={edgeMat} position={[0, -0.18, 0]} />}
        </group>
      )}

      {/* Hip joints */}
      {showLegL && <mesh geometry={robotGeo.joint} material={neonMat} position={legLPos as unknown as THREE.Vector3Tuple} scale={0.9} />}
      {showLegR && <mesh geometry={robotGeo.joint} material={neonMat} position={legRPos as unknown as THREE.Vector3Tuple} scale={0.9} />}

      {/* Left leg pivot */}
      {showLegL && (
        <group ref={legLRef} position={legLPos as unknown as THREE.Vector3Tuple}>
          <mesh geometry={legLGeo} material={darkMat} position={[0, -0.19, 0]} castShadow />
          {legLEdgeGeo && <lineSegments geometry={legLEdgeGeo} material={edgeMat} position={[0, -0.19, 0]} />}
          <mesh geometry={robotGeo.foot} material={metalMat} position={[0, -0.36, 0.012]} castShadow />
        </group>
      )}

      {/* Right leg pivot */}
      {showLegR && (
        <group ref={legRRef} position={legRPos as unknown as THREE.Vector3Tuple}>
          <mesh geometry={legRGeo} material={darkMat} position={[0, -0.19, 0]} castShadow />
          {legREdgeGeo && <lineSegments geometry={legREdgeGeo} material={edgeMat} position={[0, -0.19, 0]} />}
          <mesh geometry={robotGeo.foot} material={metalMat} position={[0, -0.36, 0.012]} castShadow />
        </group>
      )}

    </group>
  );
}

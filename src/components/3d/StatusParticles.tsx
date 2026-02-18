/**
 * StatusParticles -- Brief particle burst on status transitions.
 * Renders inside SessionRobot when a status change occurs.
 *
 * ZERO React state — uses only refs. The <points> is always mounted
 * with draw range set to 0 when inactive. This eliminates all setState
 * from the R3F tree, preventing React Error #185 cascades.
 */
import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Robot3DState } from '@/lib/robotStateMap';

// ---------------------------------------------------------------------------
// Particle burst config per transition type
// ---------------------------------------------------------------------------

interface BurstConfig {
  color: string;
  count: number;
  pattern: 'up' | 'down' | 'ring' | 'confetti';
  speed: number;
  gravity: number;
  lifetime: number;
  size: number;
}

function getBurstConfig(from: Robot3DState, to: Robot3DState): BurstConfig | null {
  if ((from === 'idle' || from === 'waiting') && (to === 'working' || to === 'thinking')) {
    return { color: '#ffdd00', count: 20, pattern: 'up', speed: 2.5, gravity: -1.5, lifetime: 1.5, size: 0.04 };
  }
  if ((from === 'working' || from === 'thinking') && to === 'waiting') {
    return { color: '#00ff88', count: 20, pattern: 'confetti', speed: 1.2, gravity: 2.0, lifetime: 1.5, size: 0.05 };
  }
  if (to === 'alert') {
    return { color: '#ffdd00', count: 25, pattern: 'ring', speed: 2.0, gravity: 0, lifetime: 1.2, size: 0.06 };
  }
  if (to === 'input') {
    return { color: '#aa66ff', count: 20, pattern: 'ring', speed: 1.5, gravity: 0, lifetime: 1.2, size: 0.05 };
  }
  if (to === 'offline') {
    return { color: '#666688', count: 20, pattern: 'down', speed: 0.8, gravity: 0.5, lifetime: 2.0, size: 0.06 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Particle state (ref-only, no React state)
// ---------------------------------------------------------------------------

interface ParticleSet {
  positions: Float32Array;
  velocities: Float32Array;
  count: number;
  startTime: number;
  lifetime: number;
  gravity: number;
  color: THREE.Color;
  size: number;
}

const MAX_PARTICLES = 25;

function createParticles(config: BurstConfig): ParticleSet {
  const { count, pattern, speed, gravity, lifetime, color, size } = config;
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    positions[i3] = (Math.random() - 0.5) * 0.2;
    positions[i3 + 1] = 0.8 + Math.random() * 0.3;
    positions[i3 + 2] = (Math.random() - 0.5) * 0.2;

    switch (pattern) {
      case 'up': {
        velocities[i3] = (Math.random() - 0.5) * speed * 0.5;
        velocities[i3 + 1] = speed * (0.6 + Math.random() * 0.4);
        velocities[i3 + 2] = (Math.random() - 0.5) * speed * 0.5;
        break;
      }
      case 'down': {
        velocities[i3] = (Math.random() - 0.5) * speed * 0.4;
        velocities[i3 + 1] = -speed * (0.3 + Math.random() * 0.3);
        velocities[i3 + 2] = (Math.random() - 0.5) * speed * 0.4;
        break;
      }
      case 'ring': {
        const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3;
        velocities[i3] = Math.cos(angle) * speed;
        velocities[i3 + 1] = (Math.random() - 0.5) * speed * 0.3;
        velocities[i3 + 2] = Math.sin(angle) * speed;
        positions[i3 + 1] = 0.15;
        break;
      }
      case 'confetti': {
        velocities[i3] = (Math.random() - 0.5) * speed;
        velocities[i3 + 1] = speed * (0.2 + Math.random() * 0.3);
        velocities[i3 + 2] = (Math.random() - 0.5) * speed;
        break;
      }
    }
  }

  return {
    positions,
    velocities,
    count,
    startTime: performance.now() / 1000,
    lifetime,
    gravity,
    color: new THREE.Color(color),
    size,
  };
}

// ---------------------------------------------------------------------------
// Component (always mounted, draw range controls visibility)
// ---------------------------------------------------------------------------

interface StatusParticlesProps {
  state: Robot3DState;
}

export default function StatusParticles({ state }: StatusParticlesProps) {
  const pointsRef = useRef<THREE.Points>(null);
  const burstRef = useRef<ParticleSet | null>(null);
  const prevState = useRef<Robot3DState>(state);

  // Pre-allocate buffer geometry (never recreated)
  const bufferGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX_PARTICLES * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, 0); // hidden initially
    return geo;
  }, []);

  // Per-instance material (cloned once)
  const instanceMat = useMemo(() => {
    return new THREE.PointsMaterial({
      size: 0.05,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: false,
    });
  }, []);

  // Dispose on unmount
  useEffect(() => {
    return () => { instanceMat.dispose(); };
  }, [instanceMat]);

  // Track state transitions (ref-only, no setState)
  useEffect(() => {
    if (prevState.current !== state) {
      const config = getBurstConfig(prevState.current, state);
      if (config) {
        burstRef.current = createParticles(config);
      }
      prevState.current = state;
    }
  }, [state]);

  // Animate particles each frame
  useFrame(() => {
    const burst = burstRef.current;
    if (!burst) {
      // Ensure hidden
      bufferGeo.setDrawRange(0, 0);
      instanceMat.opacity = 0;
      return;
    }

    const now = performance.now() / 1000;
    const elapsed = now - burst.startTime;
    const progress = elapsed / burst.lifetime;

    if (progress >= 1) {
      burstRef.current = null;
      bufferGeo.setDrawRange(0, 0);
      instanceMat.opacity = 0;
      return;
    }

    const posAttr = bufferGeo.getAttribute('position') as THREE.BufferAttribute;
    const dt = 1 / 60;

    for (let i = 0; i < burst.count; i++) {
      const i3 = i * 3;
      burst.positions[i3] += burst.velocities[i3] * dt;
      burst.positions[i3 + 1] += burst.velocities[i3 + 1] * dt;
      burst.positions[i3 + 2] += burst.velocities[i3 + 2] * dt;
      burst.velocities[i3 + 1] -= burst.gravity * dt;
      burst.velocities[i3] *= 0.99;
      burst.velocities[i3 + 1] *= 0.99;
      burst.velocities[i3 + 2] *= 0.99;
      posAttr.array[i3] = burst.positions[i3];
      posAttr.array[i3 + 1] = burst.positions[i3 + 1];
      posAttr.array[i3 + 2] = burst.positions[i3 + 2];
    }

    posAttr.needsUpdate = true;
    bufferGeo.setDrawRange(0, burst.count);
    instanceMat.opacity = 1 - progress * progress;
    instanceMat.size = burst.size * (1 - progress * 0.5);
    instanceMat.color.copy(burst.color);
  });

  return <points ref={pointsRef} geometry={bufferGeo} material={instanceMat} />;
}

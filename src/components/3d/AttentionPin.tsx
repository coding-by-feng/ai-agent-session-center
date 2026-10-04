/**
 * AttentionPin — a map pin floating over a robot that needs the user (approval or input), visible
 * from across the scene where the chip's text is not.
 *
 * Mounted only while the robot needs attention, so its one `useFrame` (the gentle bob) costs
 * nothing for the rest of the fleet. Ref-only animation, no state.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Billboard } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getPinHeadGeometry, getPinTipGeometry } from './sceneDecals';

interface AttentionPinProps {
  /** Pin colour: amber for an approval, purple for an input. */
  color: string;
  /** Height of the pin's point above the robot's origin. */
  baseY: number;
}

export default function AttentionPin({ color, baseY }: AttentionPinProps) {
  const groupRef = useRef<THREE.Group>(null);
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45, roughness: 0.45, metalness: 0 }),
    [color],
  );
  useEffect(() => () => material.dispose(), [material]);

  useFrame(() => {
    const group = groupRef.current;
    if (group) group.position.y = baseY + Math.sin(performance.now() / 420) * 0.04;
  });

  return (
    <group ref={groupRef} position={[0, baseY, 0]}>
      {/* the point is at the group origin; the head sits 0.2 above it */}
      <mesh geometry={getPinTipGeometry()} material={material} position={[0, 0.1, 0]} />
      <mesh geometry={getPinHeadGeometry()} material={material} position={[0, 0.2, 0]} />
      <Billboard position={[0, 0.2, 0]}>
        <mesh position={[0, 0, 0.1]}>
          <circleGeometry args={[0.045, 16]} />
          <meshBasicMaterial color="#ffffff" toneMapped={false} />
        </mesh>
      </Billboard>
    </group>
  );
}

/**
 * SelectionMarker — what the selected robot stands in: corner brackets around it and a soft glow
 * pad beneath, like the selection frame in a strategy game.
 *
 * Mounted only on the selected robot, inside a group that keeps it on the floor (see SessionRobot's
 * ground anchor), so it follows the robot without a frame loop of its own.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { getBracketGeometry, getDiscGeometry, getSoftDiscTexture, noRaycast } from './sceneDecals';

const PAD_RADIUS = 1.05;

export default function SelectionMarker({ color }: { color: string }) {
  const bracketMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        toneMapped: false,
      }),
    [color],
  );
  const padMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color,
        map: getSoftDiscTexture(),
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        toneMapped: false,
      }),
    [color],
  );
  // Only the materials are ours — the geometry and the texture are shared.
  useEffect(
    () => () => {
      bracketMaterial.dispose();
      padMaterial.dispose();
    },
    [bracketMaterial, padMaterial],
  );

  return (
    <group>
      <mesh geometry={getDiscGeometry()} material={padMaterial} scale={[PAD_RADIUS, 1, PAD_RADIUS]} renderOrder={2} raycast={noRaycast} />
      <mesh geometry={getBracketGeometry()} material={bracketMaterial} position={[0, 0.005, 0]} renderOrder={3} raycast={noRaycast} />
    </group>
  );
}

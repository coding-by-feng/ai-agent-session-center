/**
 * GroundMarkings — the diorama style's painted floor: dashed lanes down the corridors between
 * rooms, and a thin outline around every seat.
 *
 * One instanced mesh draws all of it. The strips are laid out by `groundMarkings.ts` (pure) and
 * written into the instance buffer once per layout change — never per frame.
 *
 * Props only, no store reads: it lives inside <Canvas> (zero Zustand there).
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { buildBayStrips, buildLaneStrips } from '@/lib/groundMarkings';
import type { RoomConfig, Workstation } from '@/lib/cyberdromeScene';
import type { Scene3DTheme } from '@/lib/sceneThemes';
import { DECAL_Y, markingColors } from './sceneDecals';

interface GroundMarkingsProps {
  rooms: RoomConfig[];
  workstations: Workstation[];
  theme: Scene3DTheme;
}

export default function GroundMarkings({ rooms, workstations, theme }: GroundMarkingsProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const strips = useMemo(
    () => [
      ...buildLaneStrips(rooms),
      ...buildBayStrips(workstations.map((w) => ({ x: w.seatPos.x, z: w.seatPos.z, faceRot: w.faceRot }))),
    ],
    [rooms, workstations],
  );

  const { grid1, stripSecondary } = theme;
  const colors = useMemo(() => markingColors({ grid1, stripSecondary }), [grid1, stripSecondary]);

  // A unit square already lying flat: each instance scales it to (length, 1, width).
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), []);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    [],
  );
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    strips.forEach((strip, i) => {
      rotation.setFromAxisAngle(up, strip.rotY);
      position.set(strip.x, DECAL_Y, strip.z);
      scale.set(strip.length, 1, strip.width);
      mesh.setMatrixAt(i, matrix.compose(position, rotation, scale));
      mesh.setColorAt(i, strip.kind === 'lane' ? colors.lane : colors.bay);
    });
    mesh.count = strips.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [strips, colors]);

  if (strips.length === 0) return null;

  // `args` carries the capacity, so a layout with more strips builds a new, bigger mesh.
  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, strips.length]}
      frustumCulled={false}
      renderOrder={1}
    />
  );
}

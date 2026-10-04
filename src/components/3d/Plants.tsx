/**
 * Plants — the diorama style's potted trees: a pair beside each doorway of every room, and one in each
 * corner of the coffee lounge.
 *
 * Three instanced meshes (pot, trunk, foliage) draw every plant in three calls. Where they stand is
 * decided by `dioramaProps.ts` (pure, and tested against the real desks, seats and lounge); the foliage
 * colour is chosen per palette so a leaf never matches the floor it stands on.
 *
 * Props only, no store reads: it lives inside <Canvas> (zero Zustand there).
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { DOOR_GAP, buildDynamicDeskDefs, type CasualArea, type RoomConfig, type Workstation } from '@/lib/cyberdromeScene';
import { PLANT_PART, buildPlantSpots, plantFoliage } from '@/lib/dioramaProps';
import type { Scene3DTheme } from '@/lib/sceneThemes';

interface PlantsProps {
  rooms: RoomConfig[];
  /** Every seat in the scene — a plant keeps clear of each chair. */
  workstations: Workstation[];
  areas: CasualArea[];
  theme: Scene3DTheme;
}

// One plant at scale 1, bottom to top: a terracotta pot, a short trunk, a ball of leaves. The sizes live in
// `dioramaProps.ts`, next to the clearances they are placed with and the height rule they must keep.
const { potHeight: POT_HEIGHT, trunkHeight: TRUNK_HEIGHT, leafRadius: LEAF_RADIUS } = PLANT_PART;
const POT_COLOR = '#b9704a';
const TRUNK_COLOR = '#7a5a40';

export default function Plants({ rooms, workstations, areas, theme }: PlantsProps) {
  const potRef = useRef<THREE.InstancedMesh>(null);
  const trunkRef = useRef<THREE.InstancedMesh>(null);
  const leafRef = useRef<THREE.InstancedMesh>(null);

  const spots = useMemo(
    () =>
      buildPlantSpots({
        rooms,
        desks: buildDynamicDeskDefs(rooms),
        seats: workstations.map((w) => ({ x: w.seatPos.x, z: w.seatPos.z })),
        areas,
        doorGap: DOOR_GAP,
      }),
    [rooms, workstations, areas],
  );

  const { floor, roomFloor, coffeeFloor } = theme;
  const foliage = useMemo(() => plantFoliage({ floor, roomFloor, coffeeFloor }), [floor, roomFloor, coffeeFloor]);

  const parts = useMemo(
    () => ({
      potGeometry: new THREE.CylinderGeometry(0.2, 0.15, POT_HEIGHT, 12),
      trunkGeometry: new THREE.CylinderGeometry(0.035, 0.045, TRUNK_HEIGHT, 6),
      leafGeometry: new THREE.SphereGeometry(LEAF_RADIUS, 14, 10),
      potMaterial: new THREE.MeshStandardMaterial({ color: POT_COLOR, roughness: 0.85, metalness: 0 }),
      trunkMaterial: new THREE.MeshStandardMaterial({ color: TRUNK_COLOR, roughness: 0.9, metalness: 0 }),
      leafMaterial: new THREE.MeshStandardMaterial({ color: foliage, roughness: 0.85, metalness: 0 }),
    }),
    [foliage],
  );
  useEffect(
    () => () => {
      for (const part of Object.values(parts)) part.dispose();
    },
    [parts],
  );

  useLayoutEffect(() => {
    const pots = potRef.current;
    const trunks = trunkRef.current;
    const leaves = leafRef.current;
    if (!pots || !trunks || !leaves) return;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const tint = new THREE.Color();
    spots.forEach((spot, i) => {
      const s = spot.scale;
      scale.setScalar(s);
      pots.setMatrixAt(i, matrix.compose(position.set(spot.x, (POT_HEIGHT / 2) * s, spot.z), rotation, scale));
      trunks.setMatrixAt(i, matrix.compose(position.set(spot.x, (POT_HEIGHT + TRUNK_HEIGHT / 2) * s, spot.z), rotation, scale));
      leaves.setMatrixAt(i, matrix.compose(position.set(spot.x, (POT_HEIGHT + TRUNK_HEIGHT + LEAF_RADIUS * 0.6) * s, spot.z), rotation, scale));
      // a little lighter or darker per plant, so a row of them is not a row of copies
      const grey = 0.92 + 0.16 * ((i * 0.618) % 1);
      leaves.setColorAt(i, tint.setRGB(grey, grey, grey));
    });
    for (const mesh of [pots, trunks, leaves]) {
      mesh.count = spots.length;
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
  }, [spots, parts]);

  if (spots.length === 0) return null;

  // `args` carries the capacity, so a layout with more plants builds new, bigger meshes.
  return (
    <group>
      <instancedMesh ref={potRef} args={[parts.potGeometry, parts.potMaterial, spots.length]} frustumCulled={false} />
      <instancedMesh ref={trunkRef} args={[parts.trunkGeometry, parts.trunkMaterial, spots.length]} frustumCulled={false} />
      <instancedMesh ref={leafRef} args={[parts.leafGeometry, parts.leafMaterial, spots.length]} frustumCulled={false} />
    </group>
  );
}

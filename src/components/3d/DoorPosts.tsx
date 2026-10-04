/**
 * DoorPosts — the diorama style's doorway frames: a chunky post in the room's accent at each end of each
 * doorway, a hair taller than the wall — a loading dock's door frame, with nothing across the top for a
 * robot to walk through.
 *
 * Two instanced meshes (one per accent colour) draw every post in the scene, so the cost is two draws
 * (plus two for the shadow pass) however many rooms there are. Where the posts stand is decided by
 * `dioramaProps.ts` (pure, tested).
 *
 * Props only, no store reads: it lives inside <Canvas> (zero Zustand there).
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { DOOR_GAP, type RoomConfig } from '@/lib/cyberdromeScene';
import { roundedBox } from '@/lib/dioramaGeometry';
import { DIORAMA_WALL_H, DIORAMA_WALL_T, buildDoorPosts } from '@/lib/dioramaProps';
import type { Scene3DTheme } from '@/lib/sceneThemes';

interface DoorPostsProps {
  rooms: RoomConfig[];
  theme: Scene3DTheme;
}

/** A post is this wide, stands this far over the wall, and is this much deeper than the wall is thick. */
const POST_WIDTH = 0.16;
const POST_OVERHANG = 0.14;
const POST_EXTRA_DEPTH = 0.1;

export default function DoorPosts({ rooms, theme }: DoorPostsProps) {
  const primaryRef = useRef<THREE.InstancedMesh>(null);
  const secondaryRef = useRef<THREE.InstancedMesh>(null);

  const posts = useMemo(() => buildDoorPosts(rooms, DOOR_GAP), [rooms]);
  const byAccent = useMemo(() => [posts.filter((p) => p.accent === 0), posts.filter((p) => p.accent === 1)], [posts]);

  const height = DIORAMA_WALL_H + POST_OVERHANG;
  // Shared and cached by size (the same geometry `Block` uses for the walls' own rounded boxes): never ours to dispose.
  const geometry = roundedBox(POST_WIDTH, height, DIORAMA_WALL_T + POST_EXTRA_DEPTH, 1);

  const { stripPrimary, stripSecondary } = theme;
  const materials = useMemo(
    () =>
      [stripPrimary, stripSecondary].map(
        (color) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.15, roughness: 0.6 }),
      ),
    [stripPrimary, stripSecondary],
  );
  useEffect(
    () => () => {
      for (const material of materials) material.dispose();
    },
    [materials],
  );

  useLayoutEffect(() => {
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const position = new THREE.Vector3();
    [primaryRef.current, secondaryRef.current].forEach((mesh, accent) => {
      if (!mesh) return;
      byAccent[accent].forEach((post, i) => {
        mesh.setMatrixAt(i, matrix.compose(position.set(post.x, height / 2, post.z), rotation, scale));
      });
      mesh.count = byAccent[accent].length;
      mesh.instanceMatrix.needsUpdate = true;
    });
  }, [byAccent, height]);

  // `args` carries the capacity, so a layout with more posts builds a new, bigger mesh; an accent no room
  // wears gets no mesh at all.
  return (
    <group>
      {byAccent[0].length > 0 && (
        <instancedMesh ref={primaryRef} args={[geometry, materials[0], byAccent[0].length]} castShadow frustumCulled={false} />
      )}
      {byAccent[1].length > 0 && (
        <instancedMesh ref={secondaryRef} args={[geometry, materials[1], byAccent[1].length]} castShadow frustumCulled={false} />
      )}
    </group>
  );
}

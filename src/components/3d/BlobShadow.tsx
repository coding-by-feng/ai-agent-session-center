/**
 * BlobShadow — a soft dark disc under a robot, in place of a real shadow.
 *
 * The diorama style takes its robots out of the shadow map: at the default camera a real shadow is a
 * few hard pixels, while a soft disc grounds the robot the way a strategy game grounds a unit — and
 * leaves the robots out of the shadow pass entirely.
 *
 * One material and one geometry are shared by every robot.
 */
import * as THREE from 'three';
import { getDiscGeometry, getSoftDiscTexture, noRaycast } from './sceneDecals';

let material: THREE.MeshBasicMaterial | null = null;

function getBlobMaterial(): THREE.MeshBasicMaterial {
  if (!material) {
    material = new THREE.MeshBasicMaterial({
      color: '#141c33',
      map: getSoftDiscTexture(),
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
      toneMapped: false,
    });
  }
  return material;
}

export default function BlobShadow({ radius = 0.45 }: { radius?: number }) {
  return (
    <mesh geometry={getDiscGeometry()} material={getBlobMaterial()} scale={[radius, 1, radius]} renderOrder={1} raycast={noRaycast} />
  );
}

/**
 * CameraController — Canvas-side component that reads camera navigation
 * requests from the cameraStore and smoothly animates OrbitControls.
 */
import { useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { useCameraStore } from '@/stores/cameraStore';

const LERP_FACTOR = 0.04;
const ARRIVAL_THRESHOLD = 0.1;

interface CameraControllerProps {
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}

export default function CameraController({ controlsRef }: CameraControllerProps) {
  const camera = useThree((s) => s.camera);
  const pendingTarget = useCameraStore((s) => s.pendingTarget);
  const completeAnimation = useCameraStore((s) => s.completeAnimation);

  const targetPos = useRef(new THREE.Vector3());
  const targetLookAt = useRef(new THREE.Vector3());
  const animating = useRef(false);
  const lastRequestId = useRef(0);

  useEffect(() => {
    if (pendingTarget && pendingTarget.requestId !== lastRequestId.current) {
      lastRequestId.current = pendingTarget.requestId;
      targetPos.current.set(...pendingTarget.position);
      targetLookAt.current.set(...pendingTarget.lookAt);
      animating.current = true;
    }
  }, [pendingTarget]);

  useFrame(() => {
    if (!animating.current || !controlsRef.current) return;

    const controls = controlsRef.current;

    camera.position.lerp(targetPos.current, LERP_FACTOR);
    controls.target.lerp(targetLookAt.current, LERP_FACTOR);
    controls.update();

    const posDist = camera.position.distanceTo(targetPos.current);
    const lookDist = controls.target.distanceTo(targetLookAt.current);

    if (posDist < ARRIVAL_THRESHOLD && lookDist < ARRIVAL_THRESHOLD) {
      camera.position.copy(targetPos.current);
      controls.target.copy(targetLookAt.current);
      controls.update();
      animating.current = false;
      completeAnimation();
    }
  });

  return null;
}

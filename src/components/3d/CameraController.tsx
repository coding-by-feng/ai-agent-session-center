/**
 * CameraController — Canvas-side component that reads camera navigation
 * requests from the cameraStore and smoothly animates OrbitControls.
 *
 * ZERO Zustand subscriptions — reads store imperatively in useFrame
 * to prevent cross-reconciler cascades (React Error #185).
 */
import { useRef } from 'react';
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

  const targetPos = useRef(new THREE.Vector3());
  const targetLookAt = useRef(new THREE.Vector3());
  const animating = useRef(false);
  const lastRequestId = useRef(0);
  // #75: Frame counter for polling camera store when idle (not animating)
  const idleFrameCounter = useRef(0);

  useFrame(() => {
    // When not animating, only poll the camera store every 6th frame (#75: reduce idle cost)
    if (!animating.current) {
      idleFrameCounter.current++;
      if (idleFrameCounter.current % 6 !== 0) return;
    }

    // Poll the camera store imperatively — no subscription, no re-render
    const { pendingTarget } = useCameraStore.getState();

    // Detect new fly-to requests
    if (pendingTarget && pendingTarget.requestId !== lastRequestId.current) {
      lastRequestId.current = pendingTarget.requestId;
      targetPos.current.set(...pendingTarget.position);
      targetLookAt.current.set(...pendingTarget.lookAt);
      animating.current = true;
      idleFrameCounter.current = 0;
    }

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
      // Defer the store update out of R3F's render cycle
      queueMicrotask(() => useCameraStore.getState().completeAnimation());
    }
  });

  return null;
}

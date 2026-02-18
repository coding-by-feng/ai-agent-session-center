/**
 * SubagentConnections — Renders animated dashed laser-lines between parent
 * and child robots when team/subagent relationships exist.
 * Uses raw THREE.Line with LineDashedMaterial for animated dash flow.
 *
 * ZERO Zustand subscriptions — receives precomputed connections as props
 * from the DOM layer to prevent cross-reconciler cascades (React Error #185).
 */
import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { robotPositionStore } from './robotPositionStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectionData {
  parentId: string;
  childId: string;
  color: string;
}

// ---------------------------------------------------------------------------
// Single animated connection line (raw THREE.Line via <primitive>)
// ---------------------------------------------------------------------------

function ConnectionLine({ parentId, childId, color }: ConnectionData) {
  const dashOffsetRef = useRef(0);

  const lineObj = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(6); // 2 vertices x 3 components
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.LineDashedMaterial({
      color,
      dashSize: 0.3,
      gapSize: 0.2,
      transparent: true,
      opacity: 0.3,
    });

    const line = new THREE.Line(geom, mat);
    line.computeLineDistances();
    return line;
  }, [color]);

  // Dispose on unmount
  useEffect(() => {
    return () => {
      lineObj.geometry.dispose();
      (lineObj.material as THREE.Material).dispose();
    };
  }, [lineObj]);

  useFrame((_, delta) => {
    const parentPos = robotPositionStore.get(parentId);
    const childPos = robotPositionStore.get(childId);
    if (!parentPos || !childPos) return;

    // Update line geometry positions
    const posAttr = lineObj.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    arr[0] = parentPos.x;
    arr[1] = parentPos.y;
    arr[2] = parentPos.z;
    arr[3] = childPos.x;
    arr[4] = childPos.y;
    arr[5] = childPos.z;
    posAttr.needsUpdate = true;

    // Animate dash offset for flowing effect (parent -> child)
    dashOffsetRef.current -= delta * 2;
    const mat = lineObj.material as THREE.LineDashedMaterial & { dashOffset: number };
    mat.dashOffset = dashOffsetRef.current;

    // Recompute line distances (required for dashed lines)
    lineObj.computeLineDistances();
  });

  return <primitive object={lineObj} />;
}

// ---------------------------------------------------------------------------
// Main Component — receives connections as props (no store subscription)
// ---------------------------------------------------------------------------

export default function SubagentConnections({ connections }: { connections: ConnectionData[] }) {
  if (connections.length === 0) return null;

  return (
    <>
      {connections.map((conn) => (
        <ConnectionLine
          key={`${conn.parentId}-${conn.childId}`}
          parentId={conn.parentId}
          childId={conn.childId}
          color={conn.color}
        />
      ))}
    </>
  );
}

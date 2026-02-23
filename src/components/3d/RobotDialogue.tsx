/**
 * RobotDialogue -- Floating speech-bubble above each 3D robot.
 * Shows contextual messages based on session events.
 *
 * ZERO React state — reads dialogue data from a parent ref in useFrame.
 * This eliminates all setState calls from the R3F render tree,
 * preventing cross-reconciler cascades (React Error #185).
 */
import { useRef, useEffect } from 'react';
import { Text, Billboard } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DialogueData {
  text: string;
  borderColor: string;
  persistent: boolean;
  timestamp: number;
}

export interface RobotDialogueProps {
  dialogueRef: React.RefObject<DialogueData | null>;
}

// ---------------------------------------------------------------------------
// Component (always mounted, visibility controlled by opacity)
// ---------------------------------------------------------------------------

export default function RobotDialogue({ dialogueRef }: RobotDialogueProps) {
  const opacity = useRef(0);
  const lastTimestamp = useRef(0);
  const fadingOut = useRef(false);
  const fadeStartTime = useRef(0);
  const currentText = useRef('');
  const currentBorderColor = useRef('#00e5ff');
  const bgMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const borderMatRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame((_, delta) => {
    const d = dialogueRef.current;
    const now = performance.now() / 1000;

    // Detect new dialogue
    if (d && d.timestamp !== lastTimestamp.current) {
      lastTimestamp.current = d.timestamp;
      currentText.current = d.text;
      currentBorderColor.current = d.borderColor;
      fadingOut.current = false;

      // Schedule fade-out for non-persistent dialogues
      if (!d.persistent) {
        fadeStartTime.current = now + 5; // fade after 5 seconds
      } else {
        fadeStartTime.current = 0; // persistent — never auto-fade
      }
    }

    // Check if it's time to fade out
    if (fadeStartTime.current > 0 && now >= fadeStartTime.current && !fadingOut.current) {
      fadingOut.current = true;
    }

    // Animate opacity
    const target = fadingOut.current ? 0 : (lastTimestamp.current > 0 ? 1 : 0);
    const speed = 4;
    opacity.current += (target - opacity.current) * Math.min(1, speed * delta);

    // Clamp small values to 0
    if (opacity.current < 0.01) opacity.current = 0;

    // Update materials directly (no React re-render needed)
    if (bgMatRef.current) {
      bgMatRef.current.opacity = opacity.current * 0.92;
      bgMatRef.current.visible = opacity.current > 0;
    }
    if (borderMatRef.current) {
      borderMatRef.current.opacity = opacity.current * 0.6;
      borderMatRef.current.visible = opacity.current > 0;
      borderMatRef.current.color.set(currentBorderColor.current);
    }
  });

  // Fixed panel dimensions
  const panelWidth = 2.2;
  const panelHeight = 0.22;

  return (
    <Billboard position={[0, 2.8, 0]} follow lockX={false} lockY={false} lockZ={false}>
      {/* Background panel */}
      <mesh position={[0, 0, -0.01]}>
        <planeGeometry args={[panelWidth, panelHeight]} />
        <meshBasicMaterial
          ref={bgMatRef}
          color="#0a0616"
          transparent
          opacity={0}
          visible={false}
          depthTest={false}
        />
      </mesh>
      {/* Border */}
      <mesh position={[0, 0, -0.005]}>
        <planeGeometry args={[panelWidth + 0.04, panelHeight + 0.04]} />
        <meshBasicMaterial
          ref={borderMatRef}
          color="#00e5ff"
          transparent
          opacity={0}
          visible={false}
          depthTest={false}
        />
      </mesh>
      <Text
        fontSize={0.09}
        color="#ffffff"
        anchorX="center"
        anchorY="middle"
        maxWidth={2}
        outlineWidth={0.005}
        outlineColor="#000000"
        fillOpacity={0}
        outlineOpacity={0}
        /* Text content and opacity are updated in useFrame below */
      >
        {/* Placeholder — overridden by useFrame */}
        {' '}
        <TextUpdater
          opacityRef={opacity}
          textRef={currentText}
        />
      </Text>
    </Billboard>
  );
}

/**
 * Inner component that reads refs in useFrame to update Text properties
 * without any React state. Drei's <Text> exposes troika text via parent ref.
 */
function TextUpdater({
  opacityRef,
  textRef,
}: {
  opacityRef: React.RefObject<number>;
  textRef: React.RefObject<string>;
}) {
  const parentRef = useRef<THREE.Object3D>(null);

  // #58: Dispose Troika text mesh on unmount to prevent cache leaks
  useEffect(() => {
    return () => {
      if (!parentRef.current) return;
      const textMesh = parentRef.current.parent as unknown as {
        dispose?: () => void;
      };
      textMesh?.dispose?.();
    };
  }, []);

  useFrame(() => {
    if (!parentRef.current) return;
    // Walk up to find the Text mesh (parent of this group)
    const textMesh = parentRef.current.parent as unknown as {
      text?: string;
      fillOpacity?: number;
      outlineOpacity?: number;
      sync?: () => void;
    };
    if (!textMesh) return;

    const op = opacityRef.current;
    const txt = textRef.current;

    if (textMesh.fillOpacity !== undefined) {
      textMesh.fillOpacity = op;
    }
    if (textMesh.outlineOpacity !== undefined) {
      textMesh.outlineOpacity = op * 0.5;
    }
    if (textMesh.text !== undefined && textMesh.text !== txt) {
      textMesh.text = txt;
      textMesh.sync?.();
    }
  });

  return <group ref={parentRef} />;
}

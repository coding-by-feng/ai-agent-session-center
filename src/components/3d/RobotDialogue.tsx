/**
 * RobotDialogue -- Floating speech-bubble popup above each 3D robot.
 * Shows contextual messages based on session events: prompts, tool usage,
 * status changes. Uses drei <Text> + <Billboard> for pure WebGL rendering
 * (avoids <Html> DOM portals which cascade in R3F's reconciler).
 */
import { memo, useEffect, useRef, useState } from 'react';
import { Text, Billboard } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RobotDialogueProps {
  text: string | null;
  borderColor: string;
  persistent: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function RobotDialogueInner({ text, borderColor, persistent }: RobotDialogueProps) {
  const [visible, setVisible] = useState(false);
  const fadingOut = useRef(false);
  const opacity = useRef(0);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevText = useRef<string | null>(null);

  // Animate opacity in useFrame instead of CSS transitions
  useFrame((_, delta) => {
    if (!visible) {
      opacity.current = 0;
      return;
    }
    const target = fadingOut.current ? 0 : 1;
    const speed = 4; // lerp speed (higher = faster fade)
    opacity.current += (target - opacity.current) * Math.min(1, speed * delta);

    // Once fully faded out, hide the component
    if (fadingOut.current && opacity.current < 0.01) {
      opacity.current = 0;
      fadingOut.current = false;
      setVisible(false);
    }
  });

  useEffect(() => {
    // Clear existing timers on any change
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);

    if (text) {
      fadingOut.current = false;
      setVisible(true);
      prevText.current = text;

      if (!persistent) {
        // Start fade-out after 5s
        dismissTimer.current = setTimeout(() => {
          fadingOut.current = true;
        }, 5000);
      }
    } else {
      // text cleared -> fade out
      if (visible) {
        fadingOut.current = true;
      }
    }

    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    };
  }, [text, persistent]);

  if (!visible) return null;

  const displayText = text || prevText.current;
  if (!displayText) return null;

  // Fixed panel width — generous estimate for most dialogue strings
  const panelWidth = 2.2;
  const panelHeight = 0.22;

  return (
    <Billboard
      position={[0, 2.8, 0]}
      follow
      lockX={false}
      lockY={false}
      lockZ={false}
    >
      {/* Background panel */}
      <mesh position={[0, 0, -0.01]}>
        <planeGeometry args={[panelWidth, panelHeight]} />
        <meshBasicMaterial
          color="#0a0616"
          transparent
          opacity={opacity.current * 0.92}
        />
      </mesh>
      {/* Border */}
      <mesh position={[0, 0, -0.005]}>
        <planeGeometry args={[panelWidth + 0.04, panelHeight + 0.04]} />
        <meshBasicMaterial
          color={borderColor}
          transparent
          opacity={opacity.current * 0.6}
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
        // Use opacity.current for fade; material transparency driven by ref
        fillOpacity={opacity.current}
        outlineOpacity={opacity.current * 0.5}
      >
        {displayText}
      </Text>
    </Billboard>
  );
}

const RobotDialogue = memo(RobotDialogueInner);
export default RobotDialogue;

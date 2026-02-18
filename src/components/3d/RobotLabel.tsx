/**
 * RobotLabel — Floating label above each 3D robot.
 * Shows session info: project name, status indicator, and alert text.
 * Uses drei <Text> + <Billboard> for pure WebGL rendering to avoid
 * cross-reconciler cascades that cause React Error #185 with <Html> portals.
 *
 * Label size scales with the Font Size setting from the settings panel.
 */
import { memo, useRef, useMemo } from 'react';
import { Text, Billboard } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import type { Session } from '@/types';
import type { Robot3DState } from '@/lib/robotStateMap';

// ---------------------------------------------------------------------------
// Status dot color mapping
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  idle: '#00ff88',
  prompting: '#00e5ff',
  working: '#ff9100',
  waiting: '#00e5ff',
  approval: '#ffdd00',
  input: '#aa66ff',
  ended: '#ff4444',
  connecting: '#888888',
};

// Base dimensions at fontSize 13 (default)
const BASE_FONT = 13;
const BASE_TEXT_SIZE = 0.065;
const BASE_PANEL_W = 1.8;
const BASE_PANEL_H = 0.14;
const BASE_BORDER_W = 1.84;
const BASE_BORDER_H = 0.17;
const BASE_DOT_R = 0.025;
const BASE_DOT_X = -0.82;
const BASE_ALERT_W = 1.6;
const BASE_ALERT_H = 0.16;
const BASE_ALERT_FONT = 0.07;
const BASE_ALERT_Y = 0.18;
const BASE_BILLBOARD_Y = 2.1;
const BASE_MAX_WIDTH = 1.5;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface RobotLabelProps {
  session: Session;
  robotState: Robot3DState;
  isSelected: boolean;
  isHovered: boolean;
  fontSize: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function RobotLabelInner({ session, robotState, fontSize }: RobotLabelProps) {
  const scale = fontSize / BASE_FONT;

  const statusColor = STATUS_COLORS[session.status] ?? '#888888';
  const isAlert = robotState === 'alert';
  const isInput = robotState === 'input';

  const title = useMemo(() => {
    const raw = session.title || session.projectName || 'Unnamed';
    return raw.length > 28 ? raw.slice(0, 28) + '...' : raw;
  }, [session.title, session.projectName]);

  // Alert text for approval/input states
  const alertText = isAlert ? 'APPROVAL NEEDED' : isInput ? 'INPUT NEEDED' : null;
  const alertColor = isAlert ? '#ffdd00' : '#aa66ff';

  // Pulsing opacity for alert banner (only runs computation when alert is active)
  const pulseRef = useRef(1);
  useFrame(() => {
    if (!alertText) return;
    pulseRef.current = 0.8 + 0.2 * Math.sin(performance.now() / 500);
  });

  // Label badge
  const labelBadge = session.label
    ? ` [${session.label.toUpperCase()}]`
    : '';

  // Scaled dimensions
  const textSize = BASE_TEXT_SIZE * scale;
  const panelW = BASE_PANEL_W * scale;
  const panelH = BASE_PANEL_H * scale;
  const borderW = BASE_BORDER_W * scale;
  const borderH = BASE_BORDER_H * scale;
  const dotR = BASE_DOT_R * scale;
  const dotX = BASE_DOT_X * scale;
  const alertW = BASE_ALERT_W * scale;
  const alertH = BASE_ALERT_H * scale;
  const alertFont = BASE_ALERT_FONT * scale;
  const alertY = BASE_ALERT_Y * scale;
  const billboardY = BASE_BILLBOARD_Y + (scale - 1) * 0.3;
  const maxWidth = BASE_MAX_WIDTH * scale;

  return (
    <Billboard position={[0, billboardY, 0]} follow lockX={false} lockY={false} lockZ={false}>
      {/* Alert banner (only for approval/input) */}
      {alertText && (
        <>
          <mesh position={[0, alertY, -0.01]}>
            <planeGeometry args={[alertW, alertH]} />
            <meshBasicMaterial
              color={alertColor}
              transparent
              opacity={pulseRef.current * 0.85}
            />
          </mesh>
          <Text
            position={[0, alertY, 0]}
            fontSize={alertFont}
            color="#000000"
            anchorX="center"
            anchorY="middle"
            fontWeight={700}
            letterSpacing={0.08}
            clipRect={[-alertW / 2, -alertH / 2, alertW / 2, alertH / 2]}
          >
            {alertText}
          </Text>
        </>
      )}

      {/* Background panel */}
      <mesh position={[0, 0, -0.01]}>
        <planeGeometry args={[panelW, panelH]} />
        <meshBasicMaterial color="#0a0616" transparent opacity={0.8} />
      </mesh>

      {/* Border */}
      <mesh position={[0, 0, -0.015]}>
        <planeGeometry args={[borderW, borderH]} />
        <meshBasicMaterial color={statusColor} transparent opacity={0.15} />
      </mesh>

      {/* Status dot */}
      <mesh position={[dotX, 0, 0]}>
        <circleGeometry args={[dotR, 16]} />
        <meshBasicMaterial color={statusColor} />
      </mesh>

      {/* Project name + label badge */}
      <Text
        position={[0.02, 0, 0]}
        fontSize={textSize}
        color="#dddddd"
        anchorX="center"
        anchorY="middle"
        maxWidth={maxWidth}
        clipRect={[-panelW / 2, -panelH / 2, panelW / 2, panelH / 2]}
      >
        {title}{labelBadge}
      </Text>
    </Billboard>
  );
}

// Memoize to prevent unnecessary re-renders.
const RobotLabel = memo(RobotLabelInner, (prev, next) =>
  prev.session.sessionId === next.session.sessionId &&
  prev.session.status === next.session.status &&
  prev.session.title === next.session.title &&
  prev.session.projectName === next.session.projectName &&
  prev.session.label === next.session.label &&
  prev.robotState === next.robotState &&
  prev.isSelected === next.isSelected &&
  prev.isHovered === next.isHovered &&
  prev.fontSize === next.fontSize
);
export default RobotLabel;

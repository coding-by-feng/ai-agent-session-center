/**
 * RobotChip — the diorama style's name tag: a light pill with a status dot, the session's title and
 * its status word, floating above the robot. The selected robot's chip turns navy.
 *
 * Pure WebGL (drei Billboard + Text, a shape for the pill), like the cyberdrome label: an HTML
 * portal inside the Canvas is what causes React Error #185.
 *
 * Sized by the Font Size setting through `chipLayout`, which also places the attention pin, so the
 * two cannot drift apart.
 */
import { memo, useMemo } from 'react';
import { Billboard, Text } from '@react-three/drei';
import * as THREE from 'three';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import {
  CHIP_PILL,
  CHIP_PILL_SELECTED,
  CHIP_TEXT,
  CHIP_TEXT_SELECTED,
  chipLayout,
  chipStatusColor,
  chipStatusWord,
  chipTitle,
} from '@/lib/robotChip';
import type { Session } from '@/types';

function roundedRectShape(width: number, height: number, radius: number): THREE.Shape {
  const x = -width / 2;
  const y = -height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.absarc(x + width - radius, y + radius, radius, -Math.PI / 2, 0, false);
  shape.lineTo(x + width, y + height - radius);
  shape.absarc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2, false);
  shape.lineTo(x + radius, y + height);
  shape.absarc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI, false);
  shape.lineTo(x, y + radius);
  shape.absarc(x + radius, y + radius, radius, Math.PI, Math.PI * 1.5, false);
  return shape;
}

// Every robot at one Font Size gets an identical pill, so the geometry is built once per size and
// shared — never per robot, and never disposed (a handful of sizes, a few dozen vertices each).
const pills = new Map<string, THREE.ShapeGeometry>();
function getPillGeometry(width: number, height: number): THREE.ShapeGeometry {
  const key = `${width}|${height}`;
  let pill = pills.get(key);
  if (!pill) {
    pill = new THREE.ShapeGeometry(roundedRectShape(width, height, height / 2), 10);
    pills.set(key, pill);
  }
  return pill;
}

interface RobotChipProps {
  session: Session;
  isSelected: boolean;
  fontSize: number;
}

function RobotChipInner({ session, isSelected, fontSize }: RobotChipProps) {
  const { scale, width, height, billboardY } = chipLayout(fontSize);

  const { title: rawTitle, projectName } = session;
  const title = useMemo(() => chipTitle(sessionDisplayTitle({ title: rawTitle, projectName })), [rawTitle, projectName]);
  const word = chipStatusWord(session.status);
  const statusColor = chipStatusColor(session.status, isSelected);
  const textColor = isSelected ? CHIP_TEXT_SELECTED : CHIP_TEXT;

  const geometry = getPillGeometry(width, height);

  return (
    <Billboard position={[0, billboardY, 0]} follow lockX={false} lockY={false} lockZ={false}>
      <mesh geometry={geometry} position={[0, 0, -0.01]}>
        <meshBasicMaterial color={isSelected ? CHIP_PILL_SELECTED : CHIP_PILL} transparent opacity={0.94} toneMapped={false} />
      </mesh>

      {/* status dot */}
      <mesh position={[-width / 2 + 0.13 * scale, 0, 0]}>
        <circleGeometry args={[0.036 * scale, 16]} />
        <meshBasicMaterial color={statusColor} toneMapped={false} />
      </mesh>

      {/* The text materials are not tone-mapped: the pill and the dot are not, and text that is would
          come out lighter than its own dot (ACES at this exposure turns amber into pale yellow). */}
      <Text
        position={[-width / 2 + 0.24 * scale, 0, 0]}
        fontSize={0.075 * scale}
        color={textColor}
        anchorX="left"
        anchorY="middle"
        whiteSpace="nowrap"
        clipRect={[0, -height / 2, width * 0.58, height / 2]}
      >
        {title}
        <meshBasicMaterial color={textColor} toneMapped={false} />
      </Text>

      <Text
        position={[width / 2 - 0.12 * scale, 0, 0]}
        fontSize={0.058 * scale}
        color={statusColor}
        anchorX="right"
        anchorY="middle"
        whiteSpace="nowrap"
      >
        {word}
        <meshBasicMaterial color={statusColor} toneMapped={false} />
      </Text>
    </Billboard>
  );
}

const RobotChip = memo(
  RobotChipInner,
  (prev, next) =>
    prev.session.sessionId === next.session.sessionId &&
    prev.session.status === next.session.status &&
    prev.session.title === next.session.title &&
    prev.session.projectName === next.session.projectName &&
    prev.isSelected === next.isSelected &&
    prev.fontSize === next.fontSize,
);
export default RobotChip;

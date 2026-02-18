/**
 * RobotLabel — Floating DOM overlay above each 3D robot.
 * Shows session info: project name, status dot, label badge, and alert banners.
 * Uses drei <Html> for efficient 3D→DOM positioning.
 */
import { memo } from 'react';
import { Html } from '@react-three/drei';
import type { Session } from '@/types';
import type { Robot3DState } from '@/lib/robotStateMap';
import { formatDuration, getStatusLabel } from '@/lib/format';

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

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface RobotLabelProps {
  session: Session;
  robotState: Robot3DState;
  isSelected: boolean;
  isHovered: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function RobotLabelInner({ session, robotState, isSelected, isHovered }: RobotLabelProps) {
  const statusColor = STATUS_COLORS[session.status] ?? '#888888';
  const isAlert = robotState === 'alert';
  const isInput = robotState === 'input';
  const showExpanded = isHovered || isSelected;
  const durText = formatDuration(Date.now() - session.startedAt);

  return (
    <Html
      position={[0, 2.0, 0]}
      center
      distanceFactor={14}
      zIndexRange={[0, 0]}
      style={{ pointerEvents: 'none' }}
    >
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
        minWidth: 80,
        userSelect: 'none',
      }}>
        {/* Alert banner */}
        {(isAlert || isInput) && (
          <div style={{
            padding: '2px 8px',
            borderRadius: 3,
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 1.5,
            textTransform: 'uppercase',
            fontFamily: "'Orbitron', 'JetBrains Mono', sans-serif",
            color: isAlert ? '#000' : '#fff',
            background: isAlert ? '#ffdd00' : '#aa66ff',
            boxShadow: isAlert
              ? '0 0 8px rgba(255, 221, 0, 0.6), 0 0 20px rgba(255, 221, 0, 0.2)'
              : '0 0 8px rgba(170, 102, 255, 0.6), 0 0 20px rgba(170, 102, 255, 0.2)',
            animation: 'pulse-label 1.5s ease-in-out infinite',
          }}>
            {isAlert ? 'APPROVAL NEEDED' : 'INPUT NEEDED'}
          </div>
        )}

        {/* Compact label (always visible) */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '2px 8px',
          borderRadius: 3,
          background: isSelected
            ? 'rgba(0, 240, 255, 0.15)'
            : 'rgba(10, 6, 22, 0.7)',
          backdropFilter: 'blur(8px)',
          border: isSelected
            ? '1px solid rgba(0, 240, 255, 0.4)'
            : '1px solid rgba(255, 255, 255, 0.08)',
          maxWidth: 180,
        }}>
          {/* Status dot */}
          <span style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: statusColor,
            boxShadow: `0 0 4px ${statusColor}`,
            flexShrink: 0,
          }} />

          {/* Project name */}
          <span style={{
            fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace",
            color: '#ddd',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 130,
          }}>
            {session.title || session.projectName || 'Unnamed'}
          </span>

          {/* Label badge */}
          {session.label && (
            <span style={{
              fontSize: 8,
              padding: '1px 4px',
              borderRadius: 2,
              background: 'rgba(255, 145, 0, 0.2)',
              color: '#ff9100',
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              flexShrink: 0,
            }}>
              {session.label}
            </span>
          )}
        </div>

        {/* Expanded info (on hover / selected) */}
        {showExpanded && (
          <div style={{
            padding: '4px 8px',
            borderRadius: 3,
            background: 'rgba(10, 6, 22, 0.85)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(0, 240, 255, 0.12)',
            fontSize: 9,
            fontFamily: "'JetBrains Mono', monospace",
            color: 'rgba(255, 255, 255, 0.6)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            maxWidth: 200,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: statusColor }}>{getStatusLabel(session.status)}</span>
              {durText && <span>{durText}</span>}
            </div>

            {session.currentPrompt && (
              <div style={{
                color: 'rgba(255, 255, 255, 0.4)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 180,
                fontSize: 8,
              }}>
                {session.currentPrompt.slice(0, 60)}
              </div>
            )}

            {session.model && (
              <div style={{ color: 'rgba(0, 240, 255, 0.4)', fontSize: 8 }}>
                {session.model}
              </div>
            )}

            {(session.toolLog?.length ?? 0) > 0 && (
              <div style={{ fontSize: 8, color: 'rgba(255, 255, 255, 0.3)' }}>
                {session.toolLog!.length} tool calls
              </div>
            )}
          </div>
        )}
      </div>

    </Html>
  );
}

// Memoize to prevent unnecessary re-renders of Html portals which can cascade
// in React 19's reconciler when many robots exist simultaneously.
const RobotLabel = memo(RobotLabelInner, (prev, next) =>
  prev.session.sessionId === next.session.sessionId &&
  prev.session.status === next.session.status &&
  prev.session.title === next.session.title &&
  prev.session.projectName === next.session.projectName &&
  prev.session.label === next.session.label &&
  prev.session.currentPrompt === next.session.currentPrompt &&
  prev.session.model === next.session.model &&
  prev.session.startedAt === next.session.startedAt &&
  (prev.session.toolLog?.length ?? 0) === (next.session.toolLog?.length ?? 0) &&
  prev.robotState === next.robotState &&
  prev.isSelected === next.isSelected &&
  prev.isHovered === next.isHovered
);
export default RobotLabel;

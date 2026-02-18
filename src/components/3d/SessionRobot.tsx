/**
 * SessionRobot — Session-aware robot wrapper.
 * Connects a Session object to Robot3DModel with navigation AI.
 * Integrates floating labels, room navigation, and model type selection.
 * Uses dynamic room configs for wall collision and navigation.
 */
import { useRef, useCallback, useEffect, useState, startTransition, useMemo, memo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Session } from '@/types';
import Robot3DModel from './Robot3DModel';
import type { CliBadge, LabelFrameEffect } from './Robot3DModel';
import RobotLabel from './RobotLabel';
import RobotDialogue from './RobotDialogue';
import StatusParticles from './StatusParticles';
import { sessionStatusToRobotState, getRobotStateBehavior, type Robot3DState } from '@/lib/robotStateMap';
import {
  collidesAnyWall,
  getZone,
  pickTargetInRoom,
  pickCorridorTarget,
  computePathWaypoints,
  type DoorWaypoint,
  type Workstation,
  type WallRect,
  type RoomConfig,
} from '@/lib/cyberdromeScene';
import { PALETTE } from '@/lib/robot3DGeometry';
import { detectCli } from '@/lib/cliDetect';
import { useRoomStore } from '@/stores/roomStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { RobotModelType } from '@/lib/robot3DModels';
import { robotPositionStore, updateNavInfo, removeNavInfo } from './robotPositionStore';
import { loadRobotPositions } from '@/lib/robotPositionPersist';

// ---------------------------------------------------------------------------
// CLI Badge Resolution
// ---------------------------------------------------------------------------

/** CLI name -> badge mapping */
const CLI_BADGES: Record<string, CliBadge> = {
  claude: { letter: 'C', color: '#00f0ff' },
  gemini: { letter: 'G', color: '#4285f4' },
  codex: { letter: 'X', color: '#10a37f' },
  openclaw: { letter: 'O', color: '#ff6b2b' },
};

/** Determine CLI badge from session data (model name, events) */
function resolveCliBadge(session: Session): CliBadge {
  const cli = detectCli(session);
  return cli ? CLI_BADGES[cli] : { letter: '?', color: '#aa66ff' };
}

// ---------------------------------------------------------------------------
// Navigation States
// ---------------------------------------------------------------------------

const NAV_WALK = 0;
const NAV_GOTO = 1;
const NAV_SIT = 2;
const NAV_IDLE = 3;

const LABEL_COLORS: Record<string, string> = {
  ONEOFF: '#ff9100',
  HEAVY: '#ff3355',
  IMPORTANT: '#aa66ff',
};

interface NavState {
  mode: number;
  target: THREE.Vector3;
  deskIdx: number;
  speed: number;
  walkHz: number;
  phase: number;
  decisionTimer: number;
  posX: number;
  posY: number;
  posZ: number;
  rotY: number;
  waypoints: THREE.Vector3[];
  waypointIdx: number;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SessionRobotProps {
  session: Session;
  workstations: Workstation[];
  wallRects: WallRect[];
  rooms: RoomConfig[];
  doors: DoorWaypoint[];
  sceneBound: number;
  onSelect: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function SessionRobotInner({
  session,
  workstations,
  wallRects,
  rooms,
  doors,
  sceneBound,
  onSelect,
}: SessionRobotProps) {
  const robotState = sessionStatusToRobotState(session.status);
  const behavior = getRobotStateBehavior(robotState);

  const neonColor = session.accentColor || PALETTE[(session.colorIndex ?? 0) % PALETTE.length];
  const isHoveredRef = useRef(false);
  // NOTE: Do NOT subscribe to selectedSessionId here. When all SessionRobots
  // re-render simultaneously (due to global store change), drei's <Html> portals
  // cascade in R3F's reconciler causing React Error #185. The DetailPanel
  // (outside the Canvas) handles the selected state display instead.
  const isSelected = false;

  // Room mapping
  const getRoomForSession = useRoomStore((s) => s.getRoomForSession);
  const room = getRoomForSession(session.sessionId);
  const roomIndex = room?.roomIndex;

  // Model type: per-session override → global setting
  const globalModel = useSettingsStore((s) => s.characterModel);
  const modelType = (session.characterModel || globalModel || 'robot') as RobotModelType;

  const persisted = loadRobotPositions().get(session.sessionId);
  const initPosX = persisted ? persisted.posX : (Math.random() - 0.5) * 4;
  const initPosZ = persisted ? persisted.posZ : (Math.random() - 0.5) * 4;
  const initRotY = persisted ? persisted.rotY : Math.random() * Math.PI * 2;
  // NAV_GOTO is transient (navigating to a target) — reset to NAV_WALK on restore
  const initMode = persisted
    ? (persisted.mode === NAV_GOTO ? NAV_WALK : persisted.mode)
    : NAV_WALK;
  const initDeskIdx = persisted ? persisted.deskIdx : -1;

  const nav = useRef<NavState>({
    mode: initMode,
    target: new THREE.Vector3(initPosX, 0, initPosZ),
    deskIdx: initDeskIdx,
    speed: 3.0 + Math.random() * 1.5,
    walkHz: 12 + Math.random() * 4,
    phase: Math.random() * Math.PI * 2,
    decisionTimer: 2 + Math.random() * 4,
    posX: initPosX,
    posY: 0,
    posZ: initPosZ,
    rotY: initRotY,
    waypoints: [],
    waypointIdx: 0,
  });

  const prevState = useRef<Robot3DState>(robotState);
  const prevRoomIndex = useRef<number | undefined>(roomIndex);

  // Helper: pick wander target based on room assignment
  function pickWanderTarget(): THREE.Vector3 {
    return roomIndex != null
      ? pickTargetInRoom(roomIndex)
      : pickCorridorTarget(sceneBound);
  }

  // Handle room assignment changes (navigate to assigned room, release desk)
  useEffect(() => {
    if (roomIndex !== prevRoomIndex.current && roomIndex != null) {
      const n = nav.current;
      // Release desk on room reassignment
      if (n.deskIdx >= 0 && workstations[n.deskIdx]) {
        workstations[n.deskIdx].occupantId = null;
        n.deskIdx = -1;
      }
      n.posY = 0;
      const target = pickTargetInRoom(roomIndex);
      setNavTarget(n, target, roomIndex, rooms, doors);
      n.mode = NAV_WALK;
    }
    prevRoomIndex.current = roomIndex;
  }, [roomIndex, workstations, rooms, doors]);

  // Handle state transitions
  useEffect(() => {
    const n = nav.current;

    if (prevState.current !== robotState) {
      const deskSeekingStates: Robot3DState[] = ['thinking', 'working'];
      const casualStates: Robot3DState[] = ['idle', 'waiting'];
      const wasDeskSeeking = deskSeekingStates.includes(prevState.current);
      const isDeskSeeking = deskSeekingStates.includes(robotState);
      const wasCasual = casualStates.includes(prevState.current);

      // Transition between thinking <-> working: keep the desk, no stand-up
      if (wasDeskSeeking && isDeskSeeking) {
        // Already seated → stay seated, no nav change needed
        prevState.current = robotState;
        return;
      }

      // Leaving a desk-seeking state → release desk, stand up
      if (wasDeskSeeking && !isDeskSeeking) {
        if (n.deskIdx >= 0 && workstations[n.deskIdx]) {
          workstations[n.deskIdx].occupantId = null;
          n.deskIdx = -1;
        }
        n.posY = 0;
      }

      // Leaving a casual state (idle/waiting) → release casual seat, stand up
      if (wasCasual && !casualStates.includes(robotState)) {
        if (n.deskIdx >= 0 && workstations[n.deskIdx]) {
          workstations[n.deskIdx].occupantId = null;
          n.deskIdx = -1;
        }
        n.posY = 0;
      }

      // Entering a desk-seeking state → find a desk
      if (isDeskSeeking && n.mode !== NAV_SIT) {
        const zone = roomIndex != null ? roomIndex : getZone(n.posX, n.posZ, rooms);
        let candidates: Workstation[];
        if (zone >= 0) {
          candidates = workstations.filter(ws => ws.zone === zone && !ws.occupantId);
        } else if (roomIndex == null) {
          // Unassigned robot → prefer corridor desks (zone === -1)
          candidates = workstations.filter(ws => ws.zone === -1 && !ws.occupantId);
        } else {
          candidates = workstations.filter(ws => !ws.occupantId);
        }
        if (candidates.length > 0) {
          const ws = candidates[Math.floor(Math.random() * candidates.length)];
          ws.occupantId = session.sessionId;
          n.deskIdx = ws.idx;
          n.mode = NAV_GOTO;
          setNavTarget(n, ws.seatPos, ws.zone, rooms, doors);
        } else {
          // All desks full → stand behind nearest occupied desk (overflow)
          const occupied = zone >= 0
            ? workstations.filter(ws => ws.zone === zone && ws.occupantId)
            : workstations.filter(ws => ws.zone === -1 && ws.occupantId);
          if (occupied.length > 0) {
            let nearest = occupied[0];
            let minDist = Infinity;
            for (const ws of occupied) {
              const dx = ws.seatPos.x - n.posX;
              const dz = ws.seatPos.z - n.posZ;
              const d = dx * dx + dz * dz;
              if (d < minDist) { minDist = d; nearest = ws; }
            }
            // Stand 0.5 units behind the desk seat
            const behindOffset = 0.5;
            const overflowTarget = new THREE.Vector3(
              nearest.seatPos.x - Math.sin(nearest.faceRot) * behindOffset,
              0,
              nearest.seatPos.z - Math.cos(nearest.faceRot) * behindOffset,
            );
            setNavTarget(n, overflowTarget, nearest.zone, rooms, doors);
            n.mode = NAV_GOTO;
          } else {
            n.mode = NAV_WALK;
            const wt = pickWanderTarget();
            n.waypoints = [wt.clone()];
            n.waypointIdx = 0;
            n.target.copy(wt);
          }
        }
      }

      // Transition: alert/input → stay at desk if seated, else freeze in place
      if (robotState === 'alert' || robotState === 'input') {
        if (n.mode !== NAV_SIT) {
          n.mode = NAV_IDLE;
        }
        // If seated (NAV_SIT), remain seated — no change needed
      }

      // Transition: idle → seek coffee workstation (zone -2)
      // Transition: waiting → seek gym workstation (zone -3)
      if (robotState === 'idle' || robotState === 'waiting') {
        const casualZone = robotState === 'idle' ? -2 : -3;
        const casualCandidates = workstations.filter(ws => ws.zone === casualZone && !ws.occupantId);
        if (casualCandidates.length > 0) {
          const ws = casualCandidates[Math.floor(Math.random() * casualCandidates.length)];
          ws.occupantId = session.sessionId;
          n.deskIdx = ws.idx;
          n.mode = NAV_GOTO;
          setNavTarget(n, ws.seatPos, ws.zone, rooms, doors);
        } else {
          // All casual seats full — wander instead
          n.mode = NAV_WALK;
          n.decisionTimer = 2 + Math.random() * 4;
          const wt = pickWanderTarget();
          n.waypoints = [wt.clone()];
          n.waypointIdx = 0;
          n.target.copy(wt);
        }
      }

      // Transition: offline / connecting → stay put
      if (robotState === 'offline' || robotState === 'connecting') {
        n.mode = NAV_IDLE;
      }

      prevState.current = robotState;
    }
  }, [robotState, session.sessionId, workstations, roomIndex, rooms]);

  // Cleanup: release desk on unmount
  useEffect(() => {
    return () => {
      const n = nav.current;
      if (n.deskIdx >= 0 && workstations[n.deskIdx]) {
        workstations[n.deskIdx].occupantId = null;
      }
    };
  }, [workstations]);

  // Navigation update
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const n = nav.current;

    if (n.mode === NAV_IDLE || n.mode === NAV_SIT) return;

    // Movement (WALK or GOTO)
    const dx = n.target.x - n.posX;
    const dz = n.target.z - n.posZ;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 0.5) {
      if (n.waypointIdx < n.waypoints.length - 1) {
        // Advance to next waypoint
        n.waypointIdx++;
        n.target.copy(n.waypoints[n.waypointIdx]);
        return;
      }
      if (n.mode === NAV_GOTO) {
        seatAt(n, workstations);
        return;
      }
      // Wandering — pick new target
      const wt = pickWanderTarget();
      n.waypoints = [wt.clone()];
      n.waypointIdx = 0;
      n.target.copy(wt);
      return;
    }

    // Rotate toward target
    const want = Math.atan2(dx, dz);
    let diff = want - n.rotY;
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    n.rotY += diff * Math.min(1, 10 * dt);

    // Step forward
    const step = n.speed * behavior.speedMultiplier * dt;
    const nx = n.posX + Math.sin(n.rotY) * step;
    const nz = n.posZ + Math.cos(n.rotY) * step;

    if (!collidesAnyWall(nx, nz, wallRects)) {
      n.posX = nx;
      n.posZ = nz;
    } else if (!collidesAnyWall(nx, n.posZ, wallRects)) {
      n.posX = nx;
      if (n.mode === NAV_WALK) {
        const wt = pickWanderTarget();
        n.waypoints = [wt.clone()];
        n.waypointIdx = 0;
        n.target.copy(wt);
      }
    } else if (!collidesAnyWall(n.posX, nz, wallRects)) {
      n.posZ = nz;
      if (n.mode === NAV_WALK) {
        const wt = pickWanderTarget();
        n.waypoints = [wt.clone()];
        n.waypointIdx = 0;
        n.target.copy(wt);
      }
    } else if (n.mode === NAV_WALK) {
      const wt = pickWanderTarget();
      n.waypoints = [wt.clone()];
      n.waypointIdx = 0;
      n.target.copy(wt);
    }

    n.posX = THREE.MathUtils.clamp(n.posX, -sceneBound, sceneBound);
    n.posZ = THREE.MathUtils.clamp(n.posZ, -sceneBound, sceneBound);

    // Walk bounce
    const w = (performance.now() / 1000) * n.walkHz + n.phase;
    n.posY = Math.abs(Math.sin(w * 2)) * 0.03;

    // Decision: try to sit (only while walking and status is working)
    if (n.mode === NAV_WALK && behavior.seekDesk) {
      n.decisionTimer -= dt;
      if (n.decisionTimer <= 0) {
        n.decisionTimer = 3 + Math.random() * 5;
        const zone = roomIndex != null ? roomIndex : getZone(n.posX, n.posZ, rooms);
        // Assigned robots seek room desks; unassigned robots seek corridor desks
        const seekZone = zone >= 0 ? zone : (roomIndex == null ? -1 : -999);
        if (seekZone !== -999) {
          const empty = workstations.filter(ws => ws.zone === seekZone && !ws.occupantId);
          if (empty.length > 0) {
            const ws = empty[Math.floor(Math.random() * empty.length)];
            ws.occupantId = session.sessionId;
            n.deskIdx = ws.idx;
            n.mode = NAV_GOTO;
            setNavTarget(n, ws.seatPos, ws.zone, rooms, doors);
          }
        }
      }
    }
  });

  // Three.js group ref for direct position updates (avoids re-render → position change → pointer event loop)
  const groupRef = useRef<THREE.Group>(null);

  // Update scene group position directly from useFrame (not via React props)
  useFrame(() => {
    const n = nav.current;
    if (groupRef.current) {
      groupRef.current.position.set(n.posX, n.posY, n.posZ);
    }
  });

  const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    // Use React 19's startTransition to mark as non-urgent update.
    // This prevents the reconciler from flushing synchronously inside
    // R3F's render loop and avoids cascading re-renders.
    startTransition(() => {
      onSelect(session.sessionId);
    });
  }, [session.sessionId, onSelect]);

  const handlePointerEnter = useCallback(() => { isHoveredRef.current = true; }, []);
  const handlePointerLeave = useCallback(() => { isHoveredRef.current = false; }, []);

  const robotScale = 0.85 + (nav.current.phase % 0.2);
  // Track seated state — only triggers re-render on actual change (sit down / stand up)
  // Use a ref alongside state to avoid stale closure reads in useFrame.
  // Without seatedRef, React 19's startTransition defers the state update, so `seated`
  // in the closure stays stale across multiple frames, causing repeated setState calls
  // that trigger React Error #185.
  const seatedRef = useRef(false);
  const [seated, setSeated] = useState(false);
  useFrame(() => {
    const isSeated = nav.current.mode === NAV_SIT;
    if (isSeated !== seatedRef.current) {
      seatedRef.current = isSeated;
      startTransition(() => setSeated(isSeated));
    }
  });

  // Register robot world position for subagent connection lines
  // Also keep navInfoMap in sync for periodic persistence saves
  useFrame(() => {
    const n = nav.current;
    robotPositionStore.set(session.sessionId, n.posX, n.posY + 1.0, n.posZ);
    updateNavInfo(session.sessionId, {
      x: n.posX,
      y: n.posY,
      z: n.posZ,
      rotY: n.rotY,
      mode: n.mode,
      deskIdx: n.deskIdx,
    });
  });

  // Cleanup position on unmount
  useEffect(() => {
    return () => {
      robotPositionStore.delete(session.sessionId);
      removeNavInfo(session.sessionId);
    };
  }, [session.sessionId]);

  // CLI badge + WS4.A accent color override
  const cliBadge = useMemo(() => resolveCliBadge(session), [session.model, session.events]);
  // Override neonColor with CLI source accent when no explicit accentColor is set
  const cliNeonColor = session.accentColor ? neonColor : cliBadge.color;

  // WS7.G: Track status start time for progress timer and urgency escalation
  const statusStartTimeRef = useRef(Date.now());
  const prevStatusForTimer = useRef(session.status);
  useEffect(() => {
    if (prevStatusForTimer.current !== session.status) {
      statusStartTimeRef.current = Date.now();
      prevStatusForTimer.current = session.status;
    }
  }, [session.status]);

  // WS7.C: Current active tool (from pendingTool or last tool log entry)
  const currentTool = session.pendingTool
    || (session.toolLog && session.toolLog.length > 0
        ? session.toolLog[session.toolLog.length - 1].tool
        : null);

  // ---------------------------------------------------------------------------
  // Dialogue bubble state
  // ---------------------------------------------------------------------------

  const [dialogue, setDialogue] = useState<{
    text: string;
    borderColor: string;
    persistent: boolean;
    timestamp: number;
  } | null>(null);

  const prevStatus = useRef(session.status);
  const prevToolKey = useRef<string | null>(null);
  const prevPrompt = useRef(session.currentPrompt);
  const lastDialogueUpdate = useRef(0);

  useEffect(() => {
    const statusChanged = prevStatus.current !== session.status;

    // Throttle rapid tool calls to prevent cascading re-renders (500ms minimum)
    const now = Date.now();
    if (now - lastDialogueUpdate.current < 500 && !statusChanged) return;
    lastDialogueUpdate.current = now;

    const toolLog = session.toolLog;
    const lastTool = toolLog && toolLog.length > 0 ? toolLog[toolLog.length - 1] : null;
    const toolKey = lastTool ? `${lastTool.tool}-${lastTool.timestamp}` : null;
    const toolChanged = toolKey !== prevToolKey.current;
    const promptChanged = session.currentPrompt !== prevPrompt.current;

    // Status-based dialogues (highest priority)
    if (statusChanged) {
      const prev = prevStatus.current;

      if (session.status === 'prompting' && session.currentPrompt) {
        const truncated = session.currentPrompt.length > 60
          ? session.currentPrompt.slice(0, 60) + '...'
          : session.currentPrompt;
        setDialogue({ text: truncated, borderColor: '#00e5ff', persistent: false, timestamp: Date.now() });
      } else if (session.status === 'approval') {
        setDialogue({ text: 'AWAITING APPROVAL', borderColor: '#ffdd00', persistent: true, timestamp: Date.now() });
      } else if (session.status === 'input') {
        setDialogue({ text: 'NEEDS INPUT', borderColor: '#aa66ff', persistent: true, timestamp: Date.now() });
      } else if (session.status === 'waiting') {
        setDialogue({ text: 'Task complete!', borderColor: '#00ff88', persistent: false, timestamp: Date.now() });
      } else if (session.status === 'ended') {
        setDialogue({ text: 'OFFLINE', borderColor: '#ff4444', persistent: false, timestamp: Date.now() });
      } else if (session.status === 'idle' && prev !== 'idle' && prev !== 'connecting') {
        setDialogue({ text: 'ONLINE', borderColor: '#00ff88', persistent: false, timestamp: Date.now() });
      }
    }
    // Tool-based dialogues (only when status did not change)
    else if (toolChanged && lastTool) {
      const toolName = lastTool.tool;
      const input = lastTool.input || '';

      if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
        const filename = extractFilename(input);
        setDialogue({ text: `Reading ${filename}...`, borderColor: 'rgba(0,229,255,0.6)', persistent: false, timestamp: Date.now() });
      } else if (toolName === 'Bash') {
        const cmd = input.length > 40 ? input.slice(0, 40) + '...' : input;
        setDialogue({ text: `$ ${cmd}`, borderColor: '#ff9100', persistent: false, timestamp: Date.now() });
      } else if (toolName === 'Edit' || toolName === 'Write') {
        const filename = extractFilename(input);
        setDialogue({ text: `Editing ${filename}...`, borderColor: '#00aaff', persistent: false, timestamp: Date.now() });
      } else if (toolName === 'Task') {
        setDialogue({ text: 'Spawning agent...', borderColor: '#aa66ff', persistent: false, timestamp: Date.now() });
      } else if (toolName === 'WebFetch' || toolName === 'WebSearch') {
        setDialogue({ text: 'Fetching...', borderColor: '#00e5ff', persistent: false, timestamp: Date.now() });
      }
    }
    // Prompt changed while already prompting (no status change)
    else if (promptChanged && session.status === 'prompting' && session.currentPrompt) {
      const truncated = session.currentPrompt.length > 60
        ? session.currentPrompt.slice(0, 60) + '...'
        : session.currentPrompt;
      setDialogue({ text: truncated, borderColor: '#00e5ff', persistent: false, timestamp: Date.now() });
    }

    prevStatus.current = session.status;
    prevToolKey.current = toolKey;
    prevPrompt.current = session.currentPrompt;
  }, [session.status, session.toolLog, session.currentPrompt]);

  // ---------------------------------------------------------------------------
  // Label frame effect: activate when a labeled session transitions to ended
  // ---------------------------------------------------------------------------

  const labelSettings = useSettingsStore((s) => s.labelSettings);
  const activeLabelFrame: LabelFrameEffect = useMemo(() => {
    if (session.status !== 'ended' || !session.label) return 'none';
    const labelUpper = session.label.toUpperCase();
    const cfg = labelSettings[labelUpper];
    return (cfg?.frame ?? 'none') as LabelFrameEffect;
  }, [session.status, session.label, labelSettings]);

  const labelFrameColor = session.label ? LABEL_COLORS[session.label.toUpperCase()] : undefined;

  return (
    <group
      ref={groupRef}
      onClick={handleClick}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Robot3DModel
        neonColor={cliNeonColor}
        state={robotState}
        rotation={nav.current.rotY}
        scale={robotScale}
        modelType={modelType}
        seated={seated}
        cliBadge={cliBadge}
        currentTool={currentTool}
        statusStartTime={statusStartTimeRef.current}
        labelFrame={activeLabelFrame}
        labelFrameColor={labelFrameColor}
      />
      <StatusParticles state={robotState} />
      <RobotLabel
        session={session}
        robotState={robotState}
        isSelected={isSelected}
        isHovered={isHoveredRef.current}
      />
      <RobotDialogue
        text={dialogue?.text ?? null}
        borderColor={dialogue?.borderColor ?? '#00e5ff'}
        persistent={dialogue?.persistent ?? false}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setNavTarget(
  n: NavState,
  target: THREE.Vector3,
  targetZone: number,
  rooms: RoomConfig[],
  doors: DoorWaypoint[],
) {
  const fromZone = getZone(n.posX, n.posZ, rooms);
  const waypoints = computePathWaypoints(n.posX, n.posZ, target, fromZone, targetZone, doors);
  n.waypoints = waypoints;
  n.waypointIdx = 0;
  n.target.copy(waypoints[0]);
}

function seatAt(nav: NavState, workstations: Workstation[]) {
  const ws = workstations[nav.deskIdx];
  if (!ws) return;
  nav.mode = NAV_SIT;
  nav.posX = ws.seatPos.x;
  nav.posY = -0.12;
  nav.posZ = ws.seatPos.z;
  nav.rotY = ws.faceRot;
}

/** Extract a short filename from a tool input string (path or JSON) */
function extractFilename(input: string): string {
  // Try to extract a file path from the input
  const pathMatch = input.match(/(?:\/[\w.-]+)+/);
  if (pathMatch) {
    const parts = pathMatch[0].split('/');
    return parts[parts.length - 1] || pathMatch[0];
  }
  // Fallback: first 20 chars
  return input.length > 20 ? input.slice(0, 20) + '...' : input || 'file';
}

// Memoize SessionRobot to prevent cascading re-renders when many robots exist.
// Granular field comparison prevents re-renders when unrelated session fields change,
// avoiding React Error #185 caused by cascading Html portal updates.
const SessionRobot = memo(SessionRobotInner, (prev, next) =>
  prev.session.sessionId === next.session.sessionId &&
  prev.session.status === next.session.status &&
  prev.session.accentColor === next.session.accentColor &&
  prev.session.colorIndex === next.session.colorIndex &&
  prev.session.model === next.session.model &&
  prev.session.currentPrompt === next.session.currentPrompt &&
  prev.session.pendingTool === next.session.pendingTool &&
  prev.session.label === next.session.label &&
  prev.session.characterModel === next.session.characterModel &&
  prev.session.title === next.session.title &&
  prev.session.projectName === next.session.projectName &&
  (prev.session.toolLog?.length ?? 0) === (next.session.toolLog?.length ?? 0) &&
  (prev.session.events?.length ?? 0) === (next.session.events?.length ?? 0) &&
  prev.sceneBound === next.sceneBound &&
  prev.onSelect === next.onSelect &&
  prev.workstations === next.workstations &&
  prev.wallRects === next.wallRects &&
  prev.rooms === next.rooms &&
  prev.doors === next.doors
);
export default SessionRobot;

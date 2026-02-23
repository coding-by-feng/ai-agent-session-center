/**
 * CyberdromeScene — Main 3D scene component mounted in LiveView.
 * Orchestrates environment, session robots, camera, room labels, and dynamic rooms.
 * Rooms are fully dynamic — created/destroyed based on roomStore.
 *
 * ARCHITECTURE: Zero Zustand subscriptions inside <Canvas>.
 * All store reads happen in this DOM-side wrapper and flow into Canvas
 * via props. This prevents cross-reconciler cascades (React Error #185).
 */
import { useMemo, useCallback, useRef, Suspense, useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCameraStore } from '@/stores/cameraStore';
import { saveRobotPositions, type PersistedRobotState } from '@/lib/robotPositionPersist';
import { getAllNavInfo, robotPositionStore } from './robotPositionStore';
import { getScene3DTheme, type Scene3DTheme } from '@/lib/sceneThemes';
import type { Session } from '@/types';
import CyberdromeEnvironment from './CyberdromeEnvironment';
import SessionRobot from './SessionRobot';
import RoomLabels from './RoomLabels';
import SubagentConnections from './SubagentConnections';
import CameraController from './CameraController';
import SceneOverlay from './SceneOverlay';
import RobotListSidebar from './RobotListSidebar';
import {
  computeRoomConfigs,
  buildDynamicWorkstations,
  buildCorridorWorkstations,
  buildCasualAreas,
  buildCasualWorkstations,
  buildDoorWaypoints,
  computeSceneBounds,
  type RoomConfig,
  type Workstation,
  type WallRect,
  type CasualArea,
  type DoorWaypoint,
} from '@/lib/cyberdromeScene';
import { PALETTE } from '@/lib/robot3DGeometry';

// ---------------------------------------------------------------------------
// Scene Theme Sync — receives theme as props (no store subscription)
// ---------------------------------------------------------------------------

function SceneThemeSync({ background, fogDensity }: { background: string; fogDensity: number }) {
  // useThree must be called inside Canvas — reads scene/gl refs
  const { scene, gl } = useThree();

  // #51: Use useEffect instead of useMemo for side effects (mutations)
  useEffect(() => {
    const fogColor = new THREE.Color(background);
    if (scene.fog instanceof THREE.FogExp2) {
      scene.fog.color.copy(fogColor);
      scene.fog.density = fogDensity;
    } else {
      scene.fog = new THREE.FogExp2(background, fogDensity);
    }
    gl.setClearColor(fogColor);
  }, [background, fogDensity, scene, gl]);

  return null;
}

// ---------------------------------------------------------------------------
// Connection data type for SubagentConnections
// ---------------------------------------------------------------------------

interface ConnectionData {
  parentId: string;
  childId: string;
  color: string;
}

// ---------------------------------------------------------------------------
// Scene Content (inside Canvas) — ZERO Zustand subscriptions
// ---------------------------------------------------------------------------

// Camera fly offset when clicking a robot
const FLY_OFFSET_X = 6;
const FLY_OFFSET_Y = 8;
const FLY_OFFSET_Z = 10;

function SceneContent({
  rooms,
  workstations,
  wallRects,
  sceneBound,
  casualAreas,
  doors,
  sessionArray,
  sessionsMap,
  connections,
  sceneBackground,
  sceneFogDensity,
  storeRooms,
  sceneTheme,
  globalCharacterModel,
  roomAssignments,
  fontSize,
}: {
  rooms: RoomConfig[];
  workstations: Workstation[];
  wallRects: WallRect[];
  sceneBound: number;
  casualAreas: CasualArea[];
  doors: DoorWaypoint[];
  sessionArray: Session[];
  sessionsMap: Map<string, Session>;
  connections: ConnectionData[];
  sceneBackground: string;
  sceneFogDensity: number;
  storeRooms: Room[];
  sceneTheme: Scene3DTheme;
  globalCharacterModel: string;
  roomAssignments: Map<string, number | undefined>;
  fontSize: number;
}) {
  // Robot click → dispatch CustomEvent (handled by DOM wrapper).
  // setTimeout ensures the event fires AFTER R3F's pointer event cycle completes,
  // fully decoupling the store update from the R3F reconciler.
  const handleSelect = useCallback((sessionId: string) => {
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('robot-select', { detail: { sessionId } }),
      );
    }, 0);
  }, []);

  return (
    <>
      <SceneThemeSync background={sceneBackground} fogDensity={sceneFogDensity} />
      <CyberdromeEnvironment rooms={rooms} casualAreas={casualAreas} theme={sceneTheme} />
      <RoomLabels rooms={rooms} casualAreas={casualAreas} storeRooms={storeRooms} sessions={sessionsMap} />
      {sessionArray.map((session) => (
        <SessionRobot
          key={session.sessionId}
          session={session}
          workstations={workstations}
          wallRects={wallRects}
          rooms={rooms}
          doors={doors}
          sceneBound={sceneBound}
          onSelect={handleSelect}
          roomIndex={roomAssignments.get(session.sessionId)}
          globalCharacterModel={globalCharacterModel}
          fontSize={fontSize}
        />
      ))}
      <SubagentConnections connections={connections} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Map Controls (DOM overlay — zoom, reset, top-down)
// ---------------------------------------------------------------------------

const mapCtrlBtn: React.CSSProperties = {
  width: 34,
  height: 34,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid rgba(0,240,255,0.2)',
  borderRadius: 3,
  background: 'rgba(10,6,22,0.7)',
  color: 'rgba(0,240,255,0.6)',
  cursor: 'pointer',
  fontSize: 16,
  fontFamily: "'JetBrains Mono', monospace",
  fontWeight: 700,
  lineHeight: 1,
  padding: 0,
  transition: 'all 0.15s ease',
  backdropFilter: 'blur(8px)',
};

function MapControls({ controlsRef }: { controlsRef: React.RefObject<OrbitControlsImpl | null> }) {
  const flyTo = useCameraStore((s) => s.flyTo);

  const handleZoom = useCallback((factor: number) => {
    const controls = controlsRef.current;
    if (!controls) return;
    const cam = controls.object;
    const t = controls.target;
    const dx = cam.position.x - t.x;
    const dy = cam.position.y - t.y;
    const dz = cam.position.z - t.z;
    flyTo(
      [t.x + dx * factor, t.y + dy * factor, t.z + dz * factor],
      [t.x, t.y, t.z],
    );
  }, [flyTo, controlsRef]);

  const handleResetView = useCallback(() => {
    flyTo([18, 16, 18], [0, 1, 0]);
  }, [flyTo]);

  const handleTopDown = useCallback(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const t = controls.target;
    flyTo([t.x + 0.01, t.y + 30, t.z + 0.01], [t.x, t.y, t.z]);
  }, [flyTo, controlsRef]);

  const hover = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = 'rgba(0,240,255,0.15)';
    e.currentTarget.style.borderColor = 'rgba(0,240,255,0.5)';
    e.currentTarget.style.color = '#00f0ff';
  }, []);
  const unhover = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = 'rgba(10,6,22,0.7)';
    e.currentTarget.style.borderColor = 'rgba(0,240,255,0.2)';
    e.currentTarget.style.color = 'rgba(0,240,255,0.6)';
  }, []);

  return (
    <div style={{
      position: 'absolute',
      bottom: 20,
      left: 20,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      pointerEvents: 'all',
      zIndex: 11,
    }}>
      <button style={mapCtrlBtn} onClick={() => handleZoom(0.65)} onMouseEnter={hover} onMouseLeave={unhover} title="Zoom in">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
      </button>
      <button style={mapCtrlBtn} onClick={() => handleZoom(1.5)} onMouseEnter={hover} onMouseLeave={unhover} title="Zoom out">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
      </button>
      <div style={{ height: 4 }} />
      <button style={mapCtrlBtn} onClick={handleTopDown} onMouseEnter={hover} onMouseLeave={unhover} title="Top-down view">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="6" r="3" stroke="currentColor" strokeWidth="1.2"/><path d="M8 9v4M5 15h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
      </button>
      <button style={mapCtrlBtn} onClick={handleResetView} onMouseEnter={hover} onMouseLeave={unhover} title="Reset view">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 9l5-6 5 6M4 8.5V14h3v-3h2v3h3V8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component (DOM side — ALL Zustand subscriptions live here)
// ---------------------------------------------------------------------------

export default function CyberdromeScene() {
  const sessions = useSessionStore((s) => s.sessions);
  const selectSession = useSessionStore((s) => s.selectSession);
  const flyTo = useCameraStore((s) => s.flyTo);
  const storeRooms = useRoomStore((s) => s.rooms);
  const themeName = useSettingsStore((s) => s.themeName);
  const globalCharacterModel = useSettingsStore((s) => s.characterModel);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const sceneTheme = useMemo(() => getScene3DTheme(themeName), [themeName]);
  const controlsRef = useRef<OrbitControlsImpl>(null);

  // Listen for 'robot-select' CustomEvent dispatched from inside Canvas.
  // This decouples the R3F reconciler from the Zustand store update.
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId } = (e as CustomEvent).detail;
      selectSession(sessionId);
      const pos = robotPositionStore.get(sessionId);
      if (pos) {
        flyTo(
          [pos.x + FLY_OFFSET_X, pos.y + FLY_OFFSET_Y, pos.z + FLY_OFFSET_Z],
          [pos.x, pos.y + 1, pos.z],
        );
      }
    };
    window.addEventListener('robot-select', handler);
    return () => window.removeEventListener('robot-select', handler);
  }, [selectSession, flyTo]);

  // Periodically persist robot positions to sessionStorage every 2 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      const navMap = getAllNavInfo();
      const persistMap = new Map<string, PersistedRobotState>();
      navMap.forEach((info, id) => {
        persistMap.set(id, {
          posX: info.x,
          posZ: info.z,
          rotY: info.rotY,
          mode: info.mode,
          deskIdx: info.deskIdx,
        });
      });
      saveRobotPositions(persistMap);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // Compute dynamic room configs from rooms
  const roomConfigs = useMemo(() => computeRoomConfigs(storeRooms), [storeRooms]);
  const casualAreas = useMemo(() => buildCasualAreas(roomConfigs), [roomConfigs]);
  const workstations = useMemo(() => {
    const roomWs = buildDynamicWorkstations(roomConfigs);
    const corridorWs = buildCorridorWorkstations(roomConfigs, roomWs.length);
    const casualWs = buildCasualWorkstations(casualAreas, roomWs.length + corridorWs.length);
    return [...roomWs, ...corridorWs, ...casualWs];
  }, [roomConfigs, casualAreas]);
  // Walls removed for performance — empty collision rects so robots walk freely
  const wallRects = useMemo<WallRect[]>(() => [], []);
  const doorWaypoints = useMemo(() => buildDoorWaypoints(roomConfigs), [roomConfigs]);
  const sceneBound = useMemo(() => computeSceneBounds(roomConfigs), [roomConfigs]);

  // Pre-compute session array and subagent connections in DOM layer
  const sessionArray = useMemo(
    () => [...sessions.values()].filter(s => s.status !== 'ended'),
    [sessions],
  );

  // Precompute room index per session (eliminates useRoomStore inside Canvas)
  const roomAssignments = useMemo(() => {
    const map = new Map<string, number | undefined>();
    for (const session of sessions.values()) {
      const room = storeRooms.find((r) => r.sessionIds.includes(session.sessionId));
      map.set(session.sessionId, room?.roomIndex);
    }
    return map;
  }, [sessions, storeRooms]);

  const connections = useMemo(() => {
    const result: ConnectionData[] = [];
    for (const session of sessions.values()) {
      if (!session.teamId || session.teamRole !== 'member') continue;
      const parentId = session.teamId.replace(/^team-/, '');
      if (!parentId || parentId === session.sessionId) continue;
      const parentSession = sessions.get(parentId);
      if (!parentSession || parentSession.status === 'ended') continue;
      if (session.status === 'ended') continue;
      const parentColor = parentSession.accentColor ||
        PALETTE[(parentSession.colorIndex ?? 0) % PALETTE.length];
      result.push({ parentId, childId: session.sessionId, color: parentColor });
    }
    return result;
  }, [sessions]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Canvas
        shadows
        camera={{
          position: [18, 16, 18],
          fov: 50,
          near: 0.1,
          far: 150,
        }}
        gl={{
          antialias: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.2,
        }}
        style={{ position: 'absolute', inset: 0, background: sceneTheme.background }}
        onCreated={({ gl }) => {
          gl.shadowMap.enabled = true;
          gl.shadowMap.type = THREE.PCFSoftShadowMap;
        }}
      >
        <fogExp2 attach="fog" args={[sceneTheme.background, sceneTheme.fogDensity]} />
        <OrbitControls
          ref={controlsRef}
          enableDamping
          dampingFactor={0.06}
          maxPolarAngle={Math.PI / 2.1}
          minDistance={6}
          maxDistance={80}
          target={[0, 1, 0]}
        />
        <CameraController controlsRef={controlsRef} />
        <Suspense fallback={null}>
          <SceneContent
            rooms={roomConfigs}
            workstations={workstations}
            wallRects={wallRects}
            sceneBound={sceneBound}
            casualAreas={casualAreas}
            doors={doorWaypoints}
            sessionArray={sessionArray}
            sessionsMap={sessions}
            connections={connections}
            sceneBackground={sceneTheme.background}
            sceneFogDensity={sceneTheme.fogDensity}
            storeRooms={storeRooms}
            sceneTheme={sceneTheme}
            globalCharacterModel={globalCharacterModel}
            roomAssignments={roomAssignments}
            fontSize={fontSize}
          />
        </Suspense>
      </Canvas>

      <MapControls controlsRef={controlsRef} />
      <SceneOverlay sessionCount={sessionArray.length} />
      <RobotListSidebar />
    </div>
  );
}

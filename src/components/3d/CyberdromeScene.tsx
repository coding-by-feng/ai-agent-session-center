/**
 * CyberdromeScene — Main 3D scene component mounted in LiveView.
 * Orchestrates environment, session robots, camera, room labels, and dynamic rooms.
 * Rooms are fully dynamic — created/destroyed based on roomStore.
 */
import { useMemo, useCallback, useRef, Suspense, useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { saveRobotPositions, type PersistedRobotState } from '@/lib/robotPositionPersist';
import { getAllNavInfo } from './robotPositionStore';
import { getScene3DTheme } from '@/lib/sceneThemes';
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
  buildDynamicWallRects,
  buildDoorWaypoints,
  computeSceneBounds,
  type RoomConfig,
  type Workstation,
  type WallRect,
  type CasualArea,
  type DoorWaypoint,
} from '@/lib/cyberdromeScene';

// ---------------------------------------------------------------------------
// Scene Theme Sync (lives inside Canvas — keeps fog + clear color in sync)
// ---------------------------------------------------------------------------

function SceneThemeSync() {
  const themeName = useSettingsStore((s) => s.themeName);
  const sceneTheme = useMemo(() => getScene3DTheme(themeName), [themeName]);
  const { scene, gl } = useThree();

  // Sync fog + renderer clear color when theme changes
  useMemo(() => {
    const fogColor = new THREE.Color(sceneTheme.background);
    if (scene.fog instanceof THREE.FogExp2) {
      scene.fog.color.copy(fogColor);
      scene.fog.density = sceneTheme.fogDensity;
    } else {
      scene.fog = new THREE.FogExp2(sceneTheme.background, sceneTheme.fogDensity);
    }
    gl.setClearColor(fogColor);
  }, [sceneTheme, scene, gl]);

  return null;
}

// ---------------------------------------------------------------------------
// Scene Content (inside Canvas)
// ---------------------------------------------------------------------------

function SceneContent({
  rooms,
  workstations,
  wallRects,
  sceneBound,
  casualAreas,
  doors,
}: {
  rooms: RoomConfig[];
  workstations: Workstation[];
  wallRects: WallRect[];
  sceneBound: number;
  casualAreas: CasualArea[];
  doors: DoorWaypoint[];
}) {
  const sessions = useSessionStore((s) => s.sessions);
  const selectSession = useSessionStore((s) => s.selectSession);

  const handleSelect = useCallback((sessionId: string) => {
    selectSession(sessionId);
  }, [selectSession]);

  const sessionArray = useMemo(
    () => [...sessions.values()].filter(s => s.status !== 'ended'),
    [sessions],
  );

  return (
    <>
      <SceneThemeSync />
      <CyberdromeEnvironment rooms={rooms} casualAreas={casualAreas} />
      <RoomLabels rooms={rooms} casualAreas={casualAreas} />
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
        />
      ))}
      <SubagentConnections />
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function CyberdromeScene() {
  const sessions = useSessionStore((s) => s.sessions);
  const rooms = useRoomStore((s) => s.rooms);
  const themeName = useSettingsStore((s) => s.themeName);
  const sceneTheme = useMemo(() => getScene3DTheme(themeName), [themeName]);
  const controlsRef = useRef<OrbitControlsImpl>(null);

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
  const roomConfigs = useMemo(() => computeRoomConfigs(rooms), [rooms]);
  const casualAreas = useMemo(() => buildCasualAreas(roomConfigs), [roomConfigs]);
  const workstations = useMemo(() => {
    const roomWs = buildDynamicWorkstations(roomConfigs);
    const corridorWs = buildCorridorWorkstations(roomConfigs, roomWs.length);
    const casualWs = buildCasualWorkstations(casualAreas, roomWs.length + corridorWs.length);
    return [...roomWs, ...corridorWs, ...casualWs];
  }, [roomConfigs, casualAreas]);
  const wallRects = useMemo(() => buildDynamicWallRects(roomConfigs), [roomConfigs]);
  const doorWaypoints = useMemo(() => buildDoorWaypoints(roomConfigs), [roomConfigs]);
  const sceneBound = useMemo(() => computeSceneBounds(roomConfigs), [roomConfigs]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
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
        style={{ background: sceneTheme.background }}
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
          />
        </Suspense>
      </Canvas>

      <SceneOverlay sessionCount={sessions.size} />
      <RobotListSidebar />
    </div>
  );
}

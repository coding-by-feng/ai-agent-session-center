/**
 * CyberdromeEnvironment — Dynamic scene elements for the Cyberdrome.
 * Renders floor, walls, desks, particles, stars, lighting.
 * Rooms are created/destroyed dynamically based on RoomConfig[].
 */
import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  WALL_H, WALL_T, ROOM_HALF, DOOR_GAP,
  computeFloorSize, buildDynamicDeskDefs, buildCorridorWorkstations,
  type RoomConfig,
  type CasualArea,
} from '@/lib/cyberdromeScene';
import { PALETTE } from '@/lib/robot3DGeometry';
import type { Scene3DTheme } from '@/lib/sceneThemes';

// ---------------------------------------------------------------------------
// Border Glow (reused for rooms and casual areas)
// ---------------------------------------------------------------------------

function BorderGlow({ center, size, glowColor }: {
  center: [number, number, number]; size: number; glowColor: string;
}) {
  const [cx, , cz] = center;
  const t = 0.06;

  const borderMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: glowColor, emissive: glowColor, emissiveIntensity: 1.5,
    roughness: 0.2, transparent: true, opacity: 0.35,
  }), [glowColor]);

  return (
    <group position={[cx, 0.015, cz]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -size / 2]} material={borderMat}>
        <planeGeometry args={[size, t]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, size / 2]} material={borderMat}>
        <planeGeometry args={[size, t]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-size / 2, 0, 0]} material={borderMat}>
        <planeGeometry args={[t, size]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[size / 2, 0, 0]} material={borderMat}>
        <planeGeometry args={[t, size]} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Shared Desk + Chair
// ---------------------------------------------------------------------------

function DeskWithChair({ x, z, rotation, seatX, seatZ, faceRot, screenColor, deskMat, monFrameMat, chairMat }: {
  x: number; z: number; rotation: number;
  seatX: number; seatZ: number; faceRot: number;
  screenColor: string;
  deskMat: THREE.Material; monFrameMat: THREE.Material; chairMat: THREE.Material;
}) {
  return (
    <group>
      <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
        <mesh position={[0, 0.7, 0]} material={deskMat} castShadow receiveShadow>
          <boxGeometry args={[1.5, 0.05, 0.65]} />
        </mesh>
        <mesh position={[-0.72, 0.35, 0]} material={deskMat} castShadow>
          <boxGeometry args={[0.04, 0.66, 0.58]} />
        </mesh>
        <mesh position={[0.72, 0.35, 0]} material={deskMat} castShadow>
          <boxGeometry args={[0.04, 0.66, 0.58]} />
        </mesh>
        <mesh position={[0, 0.92, -0.2]} material={monFrameMat}>
          <boxGeometry args={[0.48, 0.32, 0.025]} />
        </mesh>
        <mesh position={[0, 0.92, -0.185]}>
          <boxGeometry args={[0.44, 0.28, 0.005]} />
          <meshStandardMaterial color={screenColor} emissive={screenColor} emissiveIntensity={0.6} roughness={0.3} />
        </mesh>
        <mesh position={[0, 0.72, 0.12]} material={deskMat}>
          <boxGeometry args={[0.32, 0.012, 0.1]} />
        </mesh>
      </group>
      <group position={[seatX, 0, seatZ]} rotation={[0, faceRot, 0]}>
        <mesh position={[0, 0.4, 0]} material={chairMat}>
          <boxGeometry args={[0.36, 0.03, 0.36]} />
        </mesh>
        <mesh position={[0, 0.57, -0.155]} material={chairMat}>
          <boxGeometry args={[0.34, 0.28, 0.03]} />
        </mesh>
        <mesh position={[0, 0.19, 0]} material={chairMat}>
          <cylinderGeometry args={[0.025, 0.025, 0.36, 6]} />
        </mesh>
        <mesh position={[0, 0.013, 0]} material={chairMat}>
          <cylinderGeometry args={[0.16, 0.16, 0.025, 6]} />
        </mesh>
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Room — single component for floor panel, border, walls, desks, light
// ---------------------------------------------------------------------------

function Room({ room, deskOffset, theme }: { room: RoomConfig; deskOffset: number; theme: Scene3DTheme }) {
  const [cx, , cz] = room.center;
  const roomSize = ROOM_HALF * 2;

  // Materials
  const wallMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.wall, roughness: 0.2, metalness: 0.7,
    transparent: true, opacity: theme.wallOpacity, side: THREE.DoubleSide,
  }), [theme.wall, theme.wallOpacity]);
  const cyStripMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.stripPrimary, emissive: theme.stripPrimary, emissiveIntensity: 2, roughness: 0.2,
  }), [theme.stripPrimary]);
  const mgStripMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.stripSecondary, emissive: theme.stripSecondary, emissiveIntensity: 2, roughness: 0.2,
  }), [theme.stripSecondary]);
  const deskMat = useMemo(() => new THREE.MeshStandardMaterial({ color: theme.desk, roughness: 0.5, metalness: 0.6 }), [theme.desk]);
  const monFrameMat = useMemo(() => new THREE.MeshStandardMaterial({ color: theme.monitorFrame, roughness: 0.3, metalness: 0.8 }), [theme.monitorFrame]);
  const chairMat = useMemo(() => new THREE.MeshStandardMaterial({ color: theme.chair, roughness: 0.55, metalness: 0.5 }), [theme.chair]);

  // #49: Dispose materials on unmount to prevent WebGL memory leaks
  useEffect(() => {
    return () => {
      wallMat.dispose();
      cyStripMat.dispose();
      mgStripMat.dispose();
      deskMat.dispose();
      monFrameMat.dispose();
      chairMat.dispose();
    };
  }, [wallMat, cyStripMat, mgStripMat, deskMat, monFrameMat, chairMat]);

  const stripMat = room.stripColor === 0 ? cyStripMat : mgStripMat;
  const desks = useMemo(() => buildDynamicDeskDefs([room]), [room]);

  // Wall helpers
  const b = room.bounds;
  const mx = (b.minX + b.maxX) / 2;
  const mz = (b.minZ + b.maxZ) / 2;
  const dg = DOOR_GAP / 2;
  const segLen = (roomSize - DOOR_GAP) / 2;

  function HWall({ x, z, len }: { x: number; z: number; len: number }) {
    return (
      <group>
        <mesh position={[x, WALL_H / 2, z]} material={wallMat} castShadow receiveShadow>
          <boxGeometry args={[len, WALL_H, WALL_T]} />
        </mesh>
        <mesh position={[x, WALL_H, z]} material={stripMat}>
          <boxGeometry args={[len, 0.04, WALL_T + 0.06]} />
        </mesh>
      </group>
    );
  }

  function VWall({ x, z, len }: { x: number; z: number; len: number }) {
    return (
      <group>
        <mesh position={[x, WALL_H / 2, z]} material={wallMat} castShadow receiveShadow>
          <boxGeometry args={[WALL_T, WALL_H, len]} />
        </mesh>
        <mesh position={[x, WALL_H, z]} material={stripMat}>
          <boxGeometry args={[WALL_T + 0.06, 0.04, len]} />
        </mesh>
      </group>
    );
  }

  return (
    <group>
      {/* Floor panel */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.003, cz]} receiveShadow>
        <planeGeometry args={[roomSize, roomSize]} />
        <meshStandardMaterial color={theme.roomFloor} roughness={0.5} metalness={0.2} />
      </mesh>
      <BorderGlow center={room.center} size={roomSize} glowColor={theme.borderGlow} />

      {/* Walls — north/south split by doorway, east/west solid */}
      <HWall x={(b.minX + mx - dg) / 2} z={b.minZ} len={segLen} />
      <HWall x={(mx + dg + b.maxX) / 2} z={b.minZ} len={segLen} />
      <HWall x={(b.minX + mx - dg) / 2} z={b.maxZ} len={segLen} />
      <HWall x={(mx + dg + b.maxX) / 2} z={b.maxZ} len={segLen} />
      <VWall x={b.minX} z={mz} len={roomSize} />
      <VWall x={b.maxX} z={mz} len={roomSize} />

      {/* Desks */}
      {desks.map((def, di) => (
        <DeskWithChair
          key={di}
          x={def.x} z={def.z} rotation={def.rotation}
          seatX={def.x + 0.65 * Math.sin(def.rotation)}
          seatZ={def.z + 0.65 * Math.cos(def.rotation)}
          faceRot={def.rotation + Math.PI}
          screenColor={PALETTE[((deskOffset + di) * 3 + 1) % PALETTE.length]}
          deskMat={deskMat} monFrameMat={monFrameMat} chairMat={chairMat}
        />
      ))}

      {/* Room light */}
      <pointLight
        color={theme.roomLight1} intensity={8} distance={8}
        decay={1.5} position={[cx, WALL_H - 0.2, cz]} castShadow={false}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Corridor Desks (outdoor workstations for unassigned robots)
// ---------------------------------------------------------------------------

function CorridorDesks({ rooms, theme }: { rooms: RoomConfig[]; theme: Scene3DTheme }) {
  const deskMat = useMemo(() => new THREE.MeshStandardMaterial({ color: theme.desk, roughness: 0.5, metalness: 0.6 }), [theme.desk]);
  const monFrameMat = useMemo(() => new THREE.MeshStandardMaterial({ color: theme.monitorFrame, roughness: 0.3, metalness: 0.8 }), [theme.monitorFrame]);
  const chairMat = useMemo(() => new THREE.MeshStandardMaterial({ color: theme.chair, roughness: 0.55, metalness: 0.5 }), [theme.chair]);

  const desks = useMemo(() => {
    const ws = buildCorridorWorkstations(rooms, 0);
    return ws.map((w) => ({
      x: w.seatPos.x - 0.65 * Math.sin(w.faceRot - Math.PI),
      z: w.seatPos.z - 0.65 * Math.cos(w.faceRot - Math.PI),
      rotation: w.faceRot - Math.PI,
      seatX: w.seatPos.x,
      seatZ: w.seatPos.z,
      faceRot: w.faceRot,
    }));
  }, [rooms]);

  return (
    <group>
      {desks.map((def, di) => (
        <DeskWithChair
          key={di}
          x={def.x} z={def.z} rotation={def.rotation}
          seatX={def.seatX} seatZ={def.seatZ} faceRot={def.faceRot}
          screenColor={PALETTE[(di * 3 + 5) % PALETTE.length]}
          deskMat={deskMat} monFrameMat={monFrameMat} chairMat={chairMat}
        />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Coffee Lounge (simplified)
// ---------------------------------------------------------------------------

function CoffeeTable({ x, z, mat }: { x: number; z: number; mat: THREE.Material }) {
  return (
    <group>
      <mesh position={[x, 0.45, z]} material={mat} castShadow>
        <cylinderGeometry args={[0.4, 0.4, 0.04, 10]} />
      </mesh>
      <mesh position={[x, 0.22, z]} material={mat}>
        <cylinderGeometry args={[0.05, 0.05, 0.44, 6]} />
      </mesh>
    </group>
  );
}

function CoffeeLounge({ area, theme }: { area: CasualArea; theme: Scene3DTheme }) {
  const [cx, , cz] = area.center;
  const areaSize = 10;
  const TABLE_SPACING = 3;

  const floorMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.coffeeFloor, roughness: 0.6, metalness: 0.2,
  }), [theme.coffeeFloor]);
  const furnitureMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.coffeeFurniture, roughness: 0.5, metalness: 0.4,
  }), [theme.coffeeFurniture]);

  // 2x2 grid of tables matching the station layout
  const tables: [number, number][] = [];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      tables.push([
        cx + (col - 0.5) * TABLE_SPACING,
        cz + (row - 0.5) * TABLE_SPACING,
      ]);
    }
  }

  return (
    <group>
      {/* Floor pad */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.004, cz]} receiveShadow material={floorMat}>
        <planeGeometry args={[areaSize, areaSize]} />
      </mesh>
      <BorderGlow center={area.center} size={areaSize} glowColor={theme.coffeeAccent} />

      {/* 4 coffee tables in a 2x2 grid */}
      {tables.map(([tx, tz], i) => (
        <CoffeeTable key={i} x={tx} z={tz} mat={furnitureMat} />
      ))}

      {/* Counter bar along north edge */}
      <mesh position={[cx, 0.5, cz - areaSize / 2 + 0.4]} material={furnitureMat} castShadow>
        <boxGeometry args={[5, 0.9, 0.3]} />
      </mesh>
      <mesh position={[cx, 0.96, cz - areaSize / 2 + 0.4]}>
        <boxGeometry args={[5.1, 0.03, 0.35]} />
        <meshStandardMaterial color={theme.coffeeAccent} emissive={theme.coffeeAccent} emissiveIntensity={0.4} roughness={0.3} />
      </mesh>

      {/* Warm amber point light */}
      <pointLight
        color={theme.coffeeAccent} intensity={6} distance={12}
        decay={1.5} position={[cx, 2.5, cz]} castShadow={false}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Data Particle Streams
// ---------------------------------------------------------------------------

function tickStream(
  points: THREE.Points | null, pos: Float32Array, spd: Float32Array,
  n: number, dt: number, size: number,
) {
  if (!points) return;
  for (let i = 0; i < n; i++) {
    pos[i * 3 + 1] += spd[i] * dt;
    if (pos[i * 3 + 1] > 10) {
      pos[i * 3 + 1] = 0;
      pos[i * 3] = (Math.random() - 0.5) * size;
      pos[i * 3 + 2] = (Math.random() - 0.5) * size;
    }
  }
  points.geometry.attributes.position.needsUpdate = true;
}

function DataParticles({ floorSize, theme }: { floorSize: number; theme: Scene3DTheme }) {
  const cyanRef = useRef<THREE.Points>(null);
  const magentaRef = useRef<THREE.Points>(null);

  const { cyanPositions, cyanSpeeds, magentaPositions, magentaSpeeds } = useMemo(() => {
    const cn = 60, mn = 40;
    const cPos = new Float32Array(cn * 3);
    const cSpd = new Float32Array(cn);
    const mPos = new Float32Array(mn * 3);
    const mSpd = new Float32Array(mn);

    for (let i = 0; i < cn; i++) {
      cPos[i * 3] = (Math.random() - 0.5) * floorSize;
      cPos[i * 3 + 1] = Math.random() * 10;
      cPos[i * 3 + 2] = (Math.random() - 0.5) * floorSize;
      cSpd[i] = 0.2 + Math.random() * 0.6;
    }
    for (let i = 0; i < mn; i++) {
      mPos[i * 3] = (Math.random() - 0.5) * floorSize;
      mPos[i * 3 + 1] = Math.random() * 10;
      mPos[i * 3 + 2] = (Math.random() - 0.5) * floorSize;
      mSpd[i] = 0.2 + Math.random() * 0.6;
    }
    return { cyanPositions: cPos, cyanSpeeds: cSpd, magentaPositions: mPos, magentaSpeeds: mSpd };
  }, [floorSize]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    tickStream(cyanRef.current, cyanPositions, cyanSpeeds, 60, dt, floorSize);
    tickStream(magentaRef.current, magentaPositions, magentaSpeeds, 40, dt, floorSize);
  });

  return (
    <group>
      <points ref={cyanRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[cyanPositions, 3]} />
        </bufferGeometry>
        <pointsMaterial color={theme.particle1} size={0.04} transparent opacity={0.4} sizeAttenuation />
      </points>
      <points ref={magentaRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[magentaPositions, 3]} />
        </bufferGeometry>
        <pointsMaterial color={theme.particle2} size={0.04} transparent opacity={0.4} sizeAttenuation />
      </points>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Stars Background
// ---------------------------------------------------------------------------

function Stars({ theme }: { theme: Scene3DTheme }) {
  const positions = useMemo(() => {
    const n = 200;
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      p[i * 3] = (Math.random() - 0.5) * 50;
      p[i * 3 + 1] = Math.random() * 25 + 6;
      p[i * 3 + 2] = (Math.random() - 0.5) * 50;
    }
    return p;
  }, []);

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color={theme.stars} size={0.05} transparent opacity={0.4} sizeAttenuation />
    </points>
  );
}

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

function Lighting({ theme }: { theme: Scene3DTheme }) {
  return (
    <group>
      <ambientLight color={theme.ambientColor} intensity={theme.ambientIntensity} />
      <directionalLight
        color={theme.dirColor}
        intensity={theme.dirIntensity}
        position={[8, 20, 6]}
        castShadow
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={18}
        shadow-camera-bottom={-18}
        shadow-camera-near={1}
        shadow-camera-far={50}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      <directionalLight color={theme.fillColor} intensity={theme.fillIntensity} position={[-6, 15, -8]} />
      <pointLight color={theme.pointLight1} intensity={6} distance={50} decay={1.5} position={[-10, 8, -10]} />
      <pointLight color={theme.pointLight2} intensity={5} distance={50} decay={1.5} position={[10, 7, 10]} />
      <hemisphereLight args={[theme.hemisphereUp, theme.hemisphereDown, theme.hemisphereIntensity]} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

interface EnvironmentProps {
  rooms: RoomConfig[];
  casualAreas?: CasualArea[];
  theme: Scene3DTheme;
}

export default function CyberdromeEnvironment({ rooms, casualAreas, theme }: EnvironmentProps) {
  const floorSize = useMemo(() => computeFloorSize(rooms), [rooms]);

  return (
    <group>
      <Lighting theme={theme} />

      {/* Main floor + grid */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[floorSize, floorSize]} />
        <meshStandardMaterial color={theme.floor} roughness={0.7} metalness={0.3} />
      </mesh>
      <gridHelper args={[floorSize, Math.round(floorSize / 5), theme.grid2, theme.grid2]} position={[0, 0.005, 0]} />

      {/* Rooms (single map — floor, walls, desks, light per room) */}
      {rooms.map((room, ri) => (
        <Room key={room.roomId} room={room} deskOffset={ri * 2} theme={theme} />
      ))}

      <CorridorDesks rooms={rooms} theme={theme} />

      {casualAreas?.map((area) => (
        <CoffeeLounge key={area.type} area={area} theme={theme} />
      ))}

      <DataParticles floorSize={floorSize} theme={theme} />
      <Stars theme={theme} />
    </group>
  );
}

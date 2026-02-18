/**
 * CyberdromeEnvironment — Dynamic scene elements for the Cyberdrome.
 * Renders floor, walls, desks, hologram, particles, stars, lighting.
 * Rooms are created/destroyed dynamically based on RoomConfig[].
 */
import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  WALL_H, WALL_T, ROOM_HALF, DOOR_GAP,
  computeFloorSize, buildDynamicDeskDefs, buildCorridorWorkstations,
  type RoomConfig,
  type CasualArea,
} from '@/lib/cyberdromeScene';
import { PALETTE } from '@/lib/robot3DGeometry';
import { useSettingsStore } from '@/stores/settingsStore';
import { getScene3DTheme, type Scene3DTheme } from '@/lib/sceneThemes';

// ---------------------------------------------------------------------------
// Grid Overlay Helper
// ---------------------------------------------------------------------------

function GridOverlay({ size, divisions, color, opacity, y }: {
  size: number; divisions: number; color: string; opacity: number; y: number;
}) {
  const gridRef = useRef<THREE.GridHelper>(null);

  useFrame(() => {
    if (gridRef.current) {
      const mat = gridRef.current.material as THREE.LineBasicMaterial;
      if (mat.opacity !== opacity) {
        mat.transparent = true;
        mat.opacity = opacity;
      }
    }
  });

  return <gridHelper ref={gridRef} args={[size, divisions, color, color]} position={[0, y, 0]} />;
}

// ---------------------------------------------------------------------------
// Dynamic Floor
// ---------------------------------------------------------------------------

function DynamicFloor({ rooms, theme }: { rooms: RoomConfig[]; theme: Scene3DTheme }) {
  const floorSize = useMemo(() => computeFloorSize(rooms), [rooms]);

  return (
    <group>
      {/* Main floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[floorSize, floorSize]} />
        <meshStandardMaterial color={theme.floor} roughness={0.7} metalness={0.3} />
      </mesh>

      {/* Per-room floor panels — brighter to reflect ceiling lights */}
      {rooms.map((room) => (
        <group key={room.index}>
          <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[room.center[0], 0.003, room.center[2]]}
            receiveShadow
          >
            <planeGeometry args={[ROOM_HALF * 2, ROOM_HALF * 2]} />
            <meshStandardMaterial
              color={theme.roomFloor}
              roughness={0.5}
              metalness={0.2}
            />
          </mesh>
          <RoomBorderGlow center={room.center} glowColor={theme.borderGlow} />
        </group>
      ))}

      {/* Grid overlays */}
      <GridOverlay size={floorSize} divisions={Math.round(floorSize / 1)} color={theme.grid1} opacity={0.04} y={0.005} />
      <GridOverlay size={floorSize} divisions={Math.round(floorSize / 5)} color={theme.grid2} opacity={0.03} y={0.008} />
    </group>
  );
}

/** Glowing border outline on the floor for a room. */
function RoomBorderGlow({ center, glowColor }: { center: [number, number, number]; glowColor: string }) {
  const [cx, , cz] = center;
  const w = ROOM_HALF * 2;
  const t = 0.06;

  const borderMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: glowColor,
    emissive: glowColor,
    emissiveIntensity: 1.5,
    roughness: 0.2,
    transparent: true,
    opacity: 0.35,
  }), [glowColor]);

  return (
    <group position={[cx, 0.015, cz]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -w / 2]} material={borderMat}>
        <planeGeometry args={[w, t]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, w / 2]} material={borderMat}>
        <planeGeometry args={[w, t]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-w / 2, 0, 0]} material={borderMat}>
        <planeGeometry args={[t, w]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[w / 2, 0, 0]} material={borderMat}>
        <planeGeometry args={[t, w]} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Circuit Traces
// ---------------------------------------------------------------------------

function CircuitTraces({ floorSize, theme }: { floorSize: number; theme: Scene3DTheme }) {
  const traces = useMemo(() => {
    const traceColors = [theme.particle1, theme.particle2, theme.trace3];
    const result: { points: THREE.Vector3[]; color: string; opacity: number }[] = [];
    const halfSize = floorSize * 0.35;
    for (let i = 0; i < 14; i++) {
      const pts: THREE.Vector3[] = [];
      let cx = (Math.random() - 0.5) * halfSize * 2;
      let cz = (Math.random() - 0.5) * halfSize * 2;
      pts.push(new THREE.Vector3(cx, 0.011, cz));
      const segs = 3 + Math.floor(Math.random() * 4);
      for (let j = 0; j < segs; j++) {
        const len = 1 + Math.random() * 3;
        if (j % 2 === 0) cx += (Math.random() < 0.5 ? -1 : 1) * len;
        else cz += (Math.random() < 0.5 ? -1 : 1) * len;
        cx = THREE.MathUtils.clamp(cx, -halfSize, halfSize);
        cz = THREE.MathUtils.clamp(cz, -halfSize, halfSize);
        pts.push(new THREE.Vector3(cx, 0.011, cz));
      }
      result.push({
        points: pts,
        color: traceColors[i % 3],
        opacity: 0.08 + Math.random() * 0.08,
      });
    }
    return result;
  }, [floorSize, theme.particle1, theme.particle2, theme.trace3]);

  return (
    <group>
      {traces.map((trace, i) => (
        <line key={i}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[new Float32Array(trace.points.flatMap(p => [p.x, p.y, p.z])), 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color={trace.color} transparent opacity={trace.opacity} />
        </line>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Dynamic Room Walls (4 walls per room, each with doorway gap)
// ---------------------------------------------------------------------------

function RoomWalls({ room, theme }: { room: RoomConfig; theme: Scene3DTheme }) {
  const cyStripMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.stripPrimary, emissive: theme.stripPrimary, emissiveIntensity: 2, roughness: 0.2,
  }), [theme.stripPrimary]);
  const mgStripMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.stripSecondary, emissive: theme.stripSecondary, emissiveIntensity: 2, roughness: 0.2,
  }), [theme.stripSecondary]);
  const wallMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.wall, roughness: 0.2, metalness: 0.7,
    transparent: true, opacity: theme.wallOpacity, side: THREE.DoubleSide,
  }), [theme.wall, theme.wallOpacity]);

  const stripMat = room.stripColor === 0 ? cyStripMat : mgStripMat;
  const b = room.bounds;
  const mx = (b.minX + b.maxX) / 2;
  const mz = (b.minZ + b.maxZ) / 2;
  const dg = DOOR_GAP / 2;
  const w = ROOM_HALF * 2;
  const segLen = (w - DOOR_GAP) / 2; // length of each wall segment

  // Helper: render a horizontal wall segment + strip
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

  // Helper: render a vertical wall segment + strip
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
      {/* North wall (z = minZ) — solid, no door */}
      <HWall x={mx} z={b.minZ} len={w} />
      {/* South wall (z = maxZ) — single door in center */}
      <HWall x={(b.minX + mx - dg) / 2} z={b.maxZ} len={segLen} />
      <HWall x={(mx + dg + b.maxX) / 2} z={b.maxZ} len={segLen} />
      {/* West wall (x = minX) — solid, no door */}
      <VWall x={b.minX} z={mz} len={w} />
      {/* East wall (x = maxX) — solid, no door */}
      <VWall x={b.maxX} z={mz} len={w} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Dynamic Room Desks (7 desks per room)
// ---------------------------------------------------------------------------

function RoomDesks({ room, deskOffset, theme }: { room: RoomConfig; deskOffset: number; theme: Scene3DTheme }) {
  const deskMat = useMemo(() => new THREE.MeshStandardMaterial({ color: theme.desk, roughness: 0.5, metalness: 0.6 }), [theme.desk]);
  const monFrameMat = useMemo(() => new THREE.MeshStandardMaterial({ color: theme.monitorFrame, roughness: 0.3, metalness: 0.8 }), [theme.monitorFrame]);
  const chairMat = useMemo(() => new THREE.MeshStandardMaterial({ color: theme.chair, roughness: 0.55, metalness: 0.5 }), [theme.chair]);

  const desks = useMemo(() => {
    const [cx, , cz] = room.center;
    return [
      // 3 desks along back wall (north), facing south
      { x: cx - 3.5, z: cz - 4.5, rotation: 0 },
      { x: cx,       z: cz - 4.5, rotation: 0 },
      { x: cx + 3.5, z: cz - 4.5, rotation: 0 },
      // 2 desks along west wall, facing east
      { x: cx - 5, z: cz - 1.5, rotation: Math.PI / 2 },
      { x: cx - 5, z: cz + 1.5, rotation: Math.PI / 2 },
      // 2 desks along east wall, facing west
      { x: cx + 5, z: cz, rotation: -Math.PI / 2 },
      { x: cx + 5, z: cz + 1.5, rotation: -Math.PI / 2 },
    ];
  }, [room.center]);

  return (
    <group>
      {desks.map((def, di) => {
        const sColor = PALETTE[((deskOffset + di) * 3 + 1) % PALETTE.length];
        const seatX = def.x + 0.65 * Math.sin(def.rotation);
        const seatZ = def.z + 0.65 * Math.cos(def.rotation);
        const faceRot = def.rotation + Math.PI;

        return (
          <group key={di}>
            {/* Desk */}
            <group position={[def.x, 0, def.z]} rotation={[0, def.rotation, 0]}>
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
                <meshStandardMaterial color={sColor} emissive={sColor} emissiveIntensity={0.6} roughness={0.3} />
              </mesh>
              <mesh position={[0, 0.72, 0.12]} material={deskMat}>
                <boxGeometry args={[0.32, 0.012, 0.1]} />
              </mesh>
            </group>

            {/* Chair */}
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
      })}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Per-Room Interior Lighting (ceiling panels + point lights)
// ---------------------------------------------------------------------------

function RoomLighting({ center, theme }: { center: [number, number, number]; theme: Scene3DTheme }) {
  const [cx, , cz] = center;
  const h = ROOM_HALF;
  const lightY = WALL_H * 0.65;

  const sconceMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.sconceColor,
    emissive: theme.sconceColor,
    emissiveIntensity: 2.5,
    roughness: 0.3,
  }), [theme.sconceColor]);

  const bracketMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: '#333348',
    roughness: 0.4,
    metalness: 0.7,
  }), []);

  // Wall sconce visual fixtures (no individual lights — lit by the 2 room point lights)
  const sconces = useMemo(() => [
    { pos: [cx - 3, lightY, cz - h + 0.15] as [number, number, number], rot: 0 },
    { pos: [cx,     lightY, cz - h + 0.15] as [number, number, number], rot: 0 },
    { pos: [cx + 3, lightY, cz - h + 0.15] as [number, number, number], rot: 0 },
    { pos: [cx - h + 0.15, lightY, cz - 2] as [number, number, number], rot: Math.PI / 2 },
    { pos: [cx - h + 0.15, lightY, cz + 2] as [number, number, number], rot: Math.PI / 2 },
    { pos: [cx + h - 0.15, lightY, cz - 2] as [number, number, number], rot: -Math.PI / 2 },
    { pos: [cx + h - 0.15, lightY, cz + 2] as [number, number, number], rot: -Math.PI / 2 },
    { pos: [cx - 3, lightY, cz + h - 0.15] as [number, number, number], rot: Math.PI },
    { pos: [cx + 3, lightY, cz + h - 0.15] as [number, number, number], rot: Math.PI },
  ], [cx, cz, h, lightY]);

  return (
    <group>
      {/* Sconce fixtures (visual only — emissive material glows without GPU lights) */}
      {sconces.map((s, i) => (
        <group key={i} position={s.pos} rotation={[0, s.rot, 0]}>
          <mesh position={[0, 0, -0.03]} material={bracketMat}>
            <boxGeometry args={[0.8, 0.12, 0.05]} />
          </mesh>
          <mesh position={[0, 0, 0.1]} material={bracketMat}>
            <boxGeometry args={[0.1, 0.08, 0.22]} />
          </mesh>
          <mesh position={[0, 0.03, 0.22]} material={sconceMat}>
            <boxGeometry args={[1.2, 0.25, 0.12]} />
          </mesh>
        </group>
      ))}

      {/* Only 2 point lights per room (GPU-friendly) */}
      <pointLight
        color={theme.roomLight1}
        intensity={10}
        distance={16}
        decay={1.5}
        position={[cx, WALL_H - 0.2, cz]}
        castShadow={false}
      />
      <pointLight
        color={theme.roomLight2}
        intensity={4}
        distance={12}
        decay={2}
        position={[cx, WALL_H * 0.4, cz]}
        castShadow={false}
      />
    </group>
  );
}


// ---------------------------------------------------------------------------
// Data Particle Streams
// ---------------------------------------------------------------------------

function DataParticles({ floorSize, theme }: { floorSize: number; theme: Scene3DTheme }) {
  const cyanRef = useRef<THREE.Points>(null);
  const magentaRef = useRef<THREE.Points>(null);

  const { cyanPositions, cyanSpeeds, magentaPositions, magentaSpeeds } = useMemo(() => {
    const cn = 140, mn = 80;
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
    tickStream(cyanRef.current, cyanPositions, cyanSpeeds, 140, dt, floorSize);
    tickStream(magentaRef.current, magentaPositions, magentaSpeeds, 80, dt, floorSize);
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

function tickStream(
  points: THREE.Points | null,
  pos: Float32Array,
  spd: Float32Array,
  n: number,
  dt: number,
  size: number,
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

// ---------------------------------------------------------------------------
// Stars Background
// ---------------------------------------------------------------------------

function Stars({ theme }: { theme: Scene3DTheme }) {
  const positions = useMemo(() => {
    const n = 400;
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      p[i * 3] = (Math.random() - 0.5) * 100;
      p[i * 3 + 1] = Math.random() * 35 + 8;
      p[i * 3 + 2] = (Math.random() - 0.5) * 100;
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
      <pointLight color={theme.pointLight3} intensity={4} distance={50} decay={1.5} position={[0, 10, 0]} />
      <hemisphereLight args={[theme.hemisphereUp, theme.hemisphereDown, theme.hemisphereIntensity]} />
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
      {desks.map((def, di) => {
        const sColor = PALETTE[(di * 3 + 5) % PALETTE.length];
        return (
          <group key={di}>
            {/* Desk */}
            <group position={[def.x, 0, def.z]} rotation={[0, def.rotation, 0]}>
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
                <meshStandardMaterial color={sColor} emissive={sColor} emissiveIntensity={0.6} roughness={0.3} />
              </mesh>
              <mesh position={[0, 0.72, 0.12]} material={deskMat}>
                <boxGeometry args={[0.32, 0.012, 0.1]} />
              </mesh>
            </group>

            {/* Chair */}
            <group position={[def.seatX, 0, def.seatZ]} rotation={[0, def.faceRot, 0]}>
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
      })}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Area Border Glow (reusable for casual areas)
// ---------------------------------------------------------------------------

function AreaBorderGlow({ center, size, glowColor }: {
  center: [number, number, number]; size: number; glowColor: string;
}) {
  const [cx, , cz] = center;
  const w = size;
  const t = 0.06;

  const borderMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: glowColor,
    emissive: glowColor,
    emissiveIntensity: 1.5,
    roughness: 0.2,
    transparent: true,
    opacity: 0.35,
  }), [glowColor]);

  return (
    <group position={[cx, 0.015, cz]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -w / 2]} material={borderMat}>
        <planeGeometry args={[w, t]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, w / 2]} material={borderMat}>
        <planeGeometry args={[w, t]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-w / 2, 0, 0]} material={borderMat}>
        <planeGeometry args={[t, w]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[w / 2, 0, 0]} material={borderMat}>
        <planeGeometry args={[t, w]} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Coffee Lounge
// ---------------------------------------------------------------------------

function CoffeeLounge({ area, theme }: { area: CasualArea; theme: Scene3DTheme }) {
  const [cx, , cz] = area.center;

  const floorMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.coffeeFloor, roughness: 0.6, metalness: 0.2,
  }), [theme.coffeeFloor]);

  const furnitureMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.coffeeFurniture, roughness: 0.5, metalness: 0.4,
  }), [theme.coffeeFurniture]);

  const counterMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.coffeeFurniture, roughness: 0.4, metalness: 0.5,
  }), [theme.coffeeFurniture]);

  // 6 coffee tables in a 2x3 grid matching station positions
  const tables = useMemo(() => {
    const result: { x: number; z: number }[] = [];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        result.push({ x: cx - 3 + col * 3, z: cz - 2.5 + row * 5 });
      }
    }
    return result;
  }, [cx, cz]);

  return (
    <group>
      {/* Floor pad — expanded to 14x14 to match new CASUAL_AREA_SIZE */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.004, cz]} receiveShadow material={floorMat}>
        <planeGeometry args={[14, 14]} />
      </mesh>

      <AreaBorderGlow center={area.center} size={14} glowColor={theme.coffeeAccent} />

      {/* Coffee tables with stools */}
      {tables.map((t, i) => (
        <group key={i}>
          {/* Table top (round, low) */}
          <mesh position={[t.x, 0.5, t.z]} material={furnitureMat} castShadow>
            <cylinderGeometry args={[0.5, 0.5, 0.04, 12]} />
          </mesh>
          {/* Table leg */}
          <mesh position={[t.x, 0.25, t.z]} material={furnitureMat}>
            <cylinderGeometry args={[0.06, 0.06, 0.5, 6]} />
          </mesh>
          {/* Table base */}
          <mesh position={[t.x, 0.01, t.z]} material={furnitureMat}>
            <cylinderGeometry args={[0.2, 0.2, 0.02, 8]} />
          </mesh>
          {/* Two stools per table */}
          <mesh position={[t.x - 0.6, 0.3, t.z]} material={furnitureMat}>
            <cylinderGeometry args={[0.15, 0.15, 0.03, 8]} />
          </mesh>
          <mesh position={[t.x - 0.6, 0.15, t.z]} material={furnitureMat}>
            <cylinderGeometry args={[0.03, 0.03, 0.3, 6]} />
          </mesh>
          <mesh position={[t.x + 0.6, 0.3, t.z]} material={furnitureMat}>
            <cylinderGeometry args={[0.15, 0.15, 0.03, 8]} />
          </mesh>
          <mesh position={[t.x + 0.6, 0.15, t.z]} material={furnitureMat}>
            <cylinderGeometry args={[0.03, 0.03, 0.3, 6]} />
          </mesh>
        </group>
      ))}

      {/* Counter bar along the north edge */}
      <mesh position={[cx, 0.55, cz - 4.5]} material={counterMat} castShadow>
        <boxGeometry args={[8, 1.1, 0.5]} />
      </mesh>
      {/* Counter top accent */}
      <mesh position={[cx, 1.12, cz - 4.5]}>
        <boxGeometry args={[8.1, 0.03, 0.55]} />
        <meshStandardMaterial color={theme.coffeeAccent} emissive={theme.coffeeAccent} emissiveIntensity={0.4} roughness={0.3} />
      </mesh>

      {/* Coffee machine — box body with cylindrical nozzle */}
      <group position={[cx - 2.5, 1.12, cz - 4.5]}>
        {/* Machine body */}
        <mesh position={[0, 0.25, 0]} material={counterMat} castShadow>
          <boxGeometry args={[0.45, 0.5, 0.35]} />
        </mesh>
        {/* Screen panel */}
        <mesh position={[0, 0.32, -0.18]}>
          <boxGeometry args={[0.25, 0.18, 0.01]} />
          <meshStandardMaterial color={theme.coffeeAccent} emissive={theme.coffeeAccent} emissiveIntensity={0.8} roughness={0.2} />
        </mesh>
        {/* Nozzle */}
        <mesh position={[0, 0.1, -0.2]} rotation={[Math.PI / 2, 0, 0]} material={furnitureMat}>
          <cylinderGeometry args={[0.025, 0.025, 0.06, 6]} />
        </mesh>
        {/* Cup platform */}
        <mesh position={[0, 0.005, -0.15]} material={furnitureMat}>
          <cylinderGeometry args={[0.07, 0.07, 0.01, 8]} />
        </mesh>
      </group>

      {/* Coffee pot — tapered cylinder */}
      <group position={[cx + 1.5, 1.12, cz - 4.5]}>
        <mesh position={[0, 0.12, 0]} material={furnitureMat} castShadow>
          <cylinderGeometry args={[0.06, 0.09, 0.22, 8]} />
        </mesh>
        {/* Handle */}
        <mesh position={[0.09, 0.12, 0]} rotation={[0, 0, 0]} material={furnitureMat}>
          <torusGeometry args={[0.06, 0.012, 6, 8, Math.PI]} />
        </mesh>
      </group>

      {/* Coffee cups scattered on tables */}
      <mesh position={[cx - 3, 0.53, cz - 2.5]} material={furnitureMat}>
        <cylinderGeometry args={[0.055, 0.045, 0.08, 8]} />
      </mesh>
      <mesh position={[cx, 0.53, cz - 2.5]} material={furnitureMat}>
        <cylinderGeometry args={[0.055, 0.045, 0.08, 8]} />
      </mesh>
      <mesh position={[cx + 3, 0.53, cz + 2.5]} material={furnitureMat}>
        <cylinderGeometry args={[0.055, 0.045, 0.08, 8]} />
      </mesh>

      {/* Warm amber point light */}
      <pointLight
        color={theme.coffeeAccent}
        intensity={6}
        distance={14}
        decay={1.5}
        position={[cx, 3, cz]}
        castShadow={false}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Gym Area
// ---------------------------------------------------------------------------

function GymArea({ area, theme }: { area: CasualArea; theme: Scene3DTheme }) {
  const [cx, , cz] = area.center;

  const floorMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.gymFloor, roughness: 0.6, metalness: 0.2,
  }), [theme.gymFloor]);

  const equipMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.gymEquipment, roughness: 0.4, metalness: 0.6,
  }), [theme.gymEquipment]);

  const accentMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.gymAccent, emissive: theme.gymAccent, emissiveIntensity: 0.3, roughness: 0.3, metalness: 0.5,
  }), [theme.gymAccent]);

  return (
    <group>
      {/* Floor pad — expanded to 14x14 to match new CASUAL_AREA_SIZE */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.004, cz]} receiveShadow material={floorMat}>
        <planeGeometry args={[14, 14]} />
      </mesh>

      <AreaBorderGlow center={area.center} size={14} glowColor={theme.gymAccent} />

      {/* 1. Bench press (top-left) */}
      <group position={[cx - 5, 0, cz - 5]}>
        <mesh position={[0, 0.35, 0]} material={equipMat} castShadow>
          <boxGeometry args={[0.4, 0.08, 1.2]} />
        </mesh>
        <mesh position={[0, 0.17, -0.5]} material={equipMat}>
          <boxGeometry args={[0.35, 0.34, 0.06]} />
        </mesh>
        <mesh position={[0, 0.17, 0.5]} material={equipMat}>
          <boxGeometry args={[0.35, 0.34, 0.06]} />
        </mesh>
        <mesh position={[-0.3, 0.65, -0.45]} material={equipMat}>
          <boxGeometry args={[0.05, 0.6, 0.05]} />
        </mesh>
        <mesh position={[0.3, 0.65, -0.45]} material={equipMat}>
          <boxGeometry args={[0.05, 0.6, 0.05]} />
        </mesh>
        <mesh position={[0, 0.9, -0.45]} material={accentMat}>
          <cylinderGeometry args={[0.02, 0.02, 1.0, 8]} />
        </mesh>
        <mesh position={[-0.45, 0.9, -0.45]} rotation={[0, 0, Math.PI / 2]} material={accentMat}>
          <cylinderGeometry args={[0.1, 0.1, 0.06, 8]} />
        </mesh>
        <mesh position={[0.45, 0.9, -0.45]} rotation={[0, 0, Math.PI / 2]} material={accentMat}>
          <cylinderGeometry args={[0.1, 0.1, 0.06, 8]} />
        </mesh>
      </group>

      {/* 2. Treadmill (top-center) */}
      <group position={[cx, 0, cz - 5]}>
        <mesh position={[0, 0.15, 0]} rotation={[-0.08, 0, 0]} material={equipMat} castShadow>
          <boxGeometry args={[0.7, 0.06, 1.4]} />
        </mesh>
        <mesh position={[-0.35, 0.5, -0.2]} material={equipMat}>
          <boxGeometry args={[0.04, 0.7, 0.04]} />
        </mesh>
        <mesh position={[0.35, 0.5, -0.2]} material={equipMat}>
          <boxGeometry args={[0.04, 0.7, 0.04]} />
        </mesh>
        <mesh position={[0, 0.85, -0.5]} material={accentMat}>
          <boxGeometry args={[0.5, 0.25, 0.04]} />
        </mesh>
      </group>

      {/* 3. Rowing machine (top-right) — long low shape */}
      <group position={[cx + 5, 0, cz - 5]}>
        {/* Rail / slide track */}
        <mesh position={[0, 0.1, 0]} material={equipMat} castShadow>
          <boxGeometry args={[0.15, 0.06, 1.5]} />
        </mesh>
        {/* Sliding seat */}
        <mesh position={[0, 0.18, 0.3]} material={accentMat}>
          <boxGeometry args={[0.3, 0.06, 0.25]} />
        </mesh>
        {/* Foot pads */}
        <mesh position={[0, 0.1, -0.6]} material={equipMat}>
          <boxGeometry args={[0.4, 0.04, 0.2]} />
        </mesh>
        {/* Handle / oar */}
        <mesh position={[0, 0.35, -0.55]} rotation={[0.4, 0, 0]} material={accentMat}>
          <cylinderGeometry args={[0.02, 0.02, 0.6, 6]} />
        </mesh>
      </group>

      {/* 4. Stationary bike (middle-left) */}
      <group position={[cx - 5, 0, cz]}>
        {/* Frame body */}
        <mesh position={[0, 0.4, 0]} material={equipMat} castShadow>
          <boxGeometry args={[0.08, 0.5, 0.7]} />
        </mesh>
        {/* Seat */}
        <mesh position={[0, 0.75, 0.25]} material={accentMat}>
          <boxGeometry args={[0.2, 0.04, 0.2]} />
        </mesh>
        {/* Handlebar post */}
        <mesh position={[0, 0.7, -0.25]} material={equipMat}>
          <boxGeometry args={[0.05, 0.5, 0.05]} />
        </mesh>
        {/* Handlebars */}
        <mesh position={[0, 0.92, -0.25]} material={accentMat}>
          <boxGeometry args={[0.5, 0.04, 0.08]} />
        </mesh>
        {/* Wheel */}
        <mesh position={[0, 0.22, -0.25]} rotation={[0, 0, Math.PI / 2]} material={equipMat}>
          <cylinderGeometry args={[0.2, 0.2, 0.06, 12]} />
        </mesh>
      </group>

      {/* 5. Pull-up bar (middle-center) — tall frame with crossbar */}
      <group position={[cx, 0, cz]}>
        {/* Left upright */}
        <mesh position={[-0.55, 1.2, 0]} material={equipMat} castShadow>
          <boxGeometry args={[0.06, 2.4, 0.06]} />
        </mesh>
        {/* Right upright */}
        <mesh position={[0.55, 1.2, 0]} material={equipMat}>
          <boxGeometry args={[0.06, 2.4, 0.06]} />
        </mesh>
        {/* Crossbar */}
        <mesh position={[0, 2.35, 0]} material={accentMat}>
          <cylinderGeometry args={[0.025, 0.025, 1.1, 8]} />
        </mesh>
        {/* Diagonal braces */}
        <mesh position={[-0.45, 0.4, 0]} rotation={[0, 0, -0.5]} material={equipMat}>
          <boxGeometry args={[0.04, 0.9, 0.04]} />
        </mesh>
        <mesh position={[0.45, 0.4, 0]} rotation={[0, 0, 0.5]} material={equipMat}>
          <boxGeometry args={[0.04, 0.9, 0.04]} />
        </mesh>
      </group>

      {/* 6. Leg press (middle-right) — angled platform with seat */}
      <group position={[cx + 5, 0, cz]}>
        {/* Angled platform */}
        <mesh position={[0, 0.35, 0]} rotation={[-0.4, 0, 0]} material={equipMat} castShadow>
          <boxGeometry args={[0.6, 0.06, 1.0]} />
        </mesh>
        {/* Seat base */}
        <mesh position={[0, 0.2, 0.55]} material={accentMat}>
          <boxGeometry args={[0.5, 0.08, 0.35]} />
        </mesh>
        {/* Back rest */}
        <mesh position={[0, 0.55, 0.65]} rotation={[0.5, 0, 0]} material={accentMat}>
          <boxGeometry args={[0.5, 0.6, 0.05]} />
        </mesh>
        {/* Guide rails */}
        <mesh position={[-0.3, 0.6, 0]} material={equipMat}>
          <boxGeometry args={[0.04, 1.2, 0.04]} />
        </mesh>
        <mesh position={[0.3, 0.6, 0]} material={equipMat}>
          <boxGeometry args={[0.04, 1.2, 0.04]} />
        </mesh>
      </group>

      {/* 7. Punching bag (bottom-left) */}
      <group position={[cx - 5, 0, cz + 5]}>
        <mesh position={[0, 1.6, 0]} material={equipMat}>
          <boxGeometry args={[0.06, 0.06, 1.2]} />
        </mesh>
        <mesh position={[0, 0.8, -0.55]} material={equipMat}>
          <boxGeometry args={[0.06, 1.6, 0.06]} />
        </mesh>
        <mesh position={[0, 1.0, 0.15]} material={accentMat} castShadow>
          <cylinderGeometry args={[0.18, 0.15, 0.8, 10]} />
        </mesh>
        <mesh position={[0, 1.45, 0.15]} material={equipMat}>
          <cylinderGeometry args={[0.015, 0.015, 0.3, 4]} />
        </mesh>
      </group>

      {/* 8. Cable machine (bottom-center) — tall rectangular frame with pulley */}
      <group position={[cx, 0, cz + 5]}>
        {/* Frame left */}
        <mesh position={[-0.4, 1.2, 0]} material={equipMat} castShadow>
          <boxGeometry args={[0.06, 2.4, 0.06]} />
        </mesh>
        {/* Frame right */}
        <mesh position={[0.4, 1.2, 0]} material={equipMat}>
          <boxGeometry args={[0.06, 2.4, 0.06]} />
        </mesh>
        {/* Top crossbar */}
        <mesh position={[0, 2.35, 0]} material={equipMat}>
          <boxGeometry args={[0.86, 0.06, 0.06]} />
        </mesh>
        {/* Pulley wheel */}
        <mesh position={[0, 2.3, 0]} rotation={[0, 0, Math.PI / 2]} material={accentMat}>
          <cylinderGeometry args={[0.07, 0.07, 0.06, 8]} />
        </mesh>
        {/* Cable (thin line) */}
        <mesh position={[0, 1.2, 0]} material={equipMat}>
          <boxGeometry args={[0.01, 2.3, 0.01]} />
        </mesh>
        {/* Weight stack */}
        <mesh position={[0, 0.6, 0.3]} material={accentMat}>
          <boxGeometry args={[0.22, 1.0, 0.14]} />
        </mesh>
      </group>

      {/* 9. Kettlebell rack (bottom-right) — low shelf with rounded weights */}
      <group position={[cx + 5, 0, cz + 5]}>
        {/* Shelf frame */}
        <mesh position={[0, 0.3, 0]} material={equipMat} castShadow>
          <boxGeometry args={[1.0, 0.04, 0.3]} />
        </mesh>
        <mesh position={[0, 0.18, 0]} material={equipMat}>
          <boxGeometry args={[1.0, 0.04, 0.3]} />
        </mesh>
        {/* End panels */}
        <mesh position={[-0.5, 0.24, 0]} material={equipMat}>
          <boxGeometry args={[0.04, 0.28, 0.3]} />
        </mesh>
        <mesh position={[0.5, 0.24, 0]} material={equipMat}>
          <boxGeometry args={[0.04, 0.28, 0.3]} />
        </mesh>
        {/* Kettlebells — sphere+handle */}
        {([-0.33, 0, 0.33] as number[]).map((kx, ki) => (
          <group key={ki} position={[kx, 0.22, 0]}>
            <mesh material={accentMat}>
              <sphereGeometry args={[0.09, 8, 8]} />
            </mesh>
            <mesh position={[0, 0.12, 0]} material={accentMat}>
              <torusGeometry args={[0.055, 0.018, 6, 8, Math.PI]} />
            </mesh>
          </group>
        ))}
      </group>

      {/* 10. Dumbbell rack / weight bench (middle area) */}
      <group position={[cx - 2.5, 0, cz + 2.5]}>
        {/* Rack frame */}
        <mesh position={[-0.4, 0.5, 0]} material={equipMat} castShadow>
          <boxGeometry args={[0.05, 1.0, 0.05]} />
        </mesh>
        <mesh position={[0.4, 0.5, 0]} material={equipMat}>
          <boxGeometry args={[0.05, 1.0, 0.05]} />
        </mesh>
        <mesh position={[0, 0.95, 0]} material={equipMat}>
          <boxGeometry args={[0.85, 0.05, 0.05]} />
        </mesh>
        <mesh position={[0, 0.35, 0]} material={equipMat}>
          <boxGeometry args={[0.85, 0.03, 0.15]} />
        </mesh>
        <mesh position={[0, 0.65, 0]} material={equipMat}>
          <boxGeometry args={[0.85, 0.03, 0.15]} />
        </mesh>
        {/* Dumbbells */}
        {([-0.25, 0, 0.25] as number[]).map((dx, di) => (
          <group key={di} position={[dx, 0.42, 0]}>
            <mesh material={accentMat}>
              <sphereGeometry args={[0.07 + di * 0.01, 8, 8]} />
            </mesh>
          </group>
        ))}
        {([-0.25, 0.25] as number[]).map((dx, di) => (
          <group key={di + 3} position={[dx, 0.72, 0]}>
            <mesh material={accentMat}>
              <sphereGeometry args={[0.09, 8, 8]} />
            </mesh>
          </group>
        ))}
      </group>

      {/* 11. Medicine ball (bonus) */}
      <mesh position={[cx + 2.5, 0.13, cz + 2.5]} material={accentMat}>
        <sphereGeometry args={[0.13, 8, 8]} />
      </mesh>

      {/* Cool blue/green point light */}
      <pointLight
        color={theme.gymAccent}
        intensity={8}
        distance={18}
        decay={1.5}
        position={[cx, 3, cz]}
        castShadow={false}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

interface EnvironmentProps {
  rooms: RoomConfig[];
  casualAreas?: CasualArea[];
}

export default function CyberdromeEnvironment({ rooms, casualAreas }: EnvironmentProps) {
  const themeName = useSettingsStore((s) => s.themeName);
  const theme = useMemo(() => getScene3DTheme(themeName), [themeName]);
  const floorSize = useMemo(() => computeFloorSize(rooms), [rooms]);

  return (
    <group>
      <Lighting theme={theme} />
      <DynamicFloor rooms={rooms} theme={theme} />
      <CircuitTraces floorSize={floorSize} theme={theme} />
      {rooms.map((room, ri) => (
        <group key={room.roomId}>
          <RoomLighting center={room.center} theme={theme} />
          <RoomWalls room={room} theme={theme} />
          <RoomDesks room={room} deskOffset={ri * 7} theme={theme} />
        </group>
      ))}
      <CorridorDesks rooms={rooms} theme={theme} />
      {casualAreas?.map((area) => (
        area.type === 'coffee'
          ? <CoffeeLounge key="coffee" area={area} theme={theme} />
          : <GymArea key="gym" area={area} theme={theme} />
      ))}
      <DataParticles floorSize={floorSize} theme={theme} />
      <Stars theme={theme} />
    </group>
  );
}

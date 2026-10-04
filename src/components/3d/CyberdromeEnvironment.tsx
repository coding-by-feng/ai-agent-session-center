/**
 * CyberdromeEnvironment — Dynamic scene elements for the Cyberdrome.
 * Renders floor, walls, desks, particles, stars, lighting.
 * Rooms are created/destroyed dynamically based on RoomConfig[].
 *
 * Two looks (see `sceneStyle.ts`), one component: `cyberdrome` is the original neon scene — metal,
 * emissive strips, a glowing grid, drifting data particles. `diorama` is the soft tabletop model —
 * matte rounded furniture, low ribbed walls, painted lanes and seat bays, a gentler light rig, no
 * particles. The colours come from the theme in both.
 */
import { useRef, useMemo, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  WALL_H, WALL_T, ROOM_HALF, DOOR_GAP,
  computeFloorSize, buildDynamicDeskDefs, buildCorridorWorkstations,
  type RoomConfig,
  type CasualArea,
  type Workstation,
} from '@/lib/cyberdromeScene';
import { PALETTE } from '@/lib/robot3DGeometry';
import { roundedBox } from '@/lib/dioramaGeometry';
import { dioramaLighting, type ClayTone } from '@/lib/dioramaLighting';
import { DIORAMA_WALL_H, DIORAMA_WALL_T, LOUNGE_SIZE, LOUNGE_TABLE_SPACING } from '@/lib/dioramaProps';
import type { SceneStyle } from '@/lib/sceneStyle';
import type { Scene3DTheme } from '@/lib/sceneThemes';
import DoorPosts from './DoorPosts';
import GroundMarkings from './GroundMarkings';
import Plants from './Plants';
import { getRibbedTexture, getSlabTexture } from './sceneDecals';

/** Diorama walls are fence-height, so the desks behind them stay in view from the default camera. */
type Vec3 = [number, number, number];

/** A stable empty list, so an omitted `casualAreas` prop does not rebuild the plant layout every render. */
const NO_AREAS: CasualArea[] = [];

// ---------------------------------------------------------------------------
// Block — a box that is sharp in the cyberdrome and softly rounded in the diorama
// ---------------------------------------------------------------------------

function Block({ args, position, material, diorama, castShadow, receiveShadow, children }: {
  args: Vec3;
  position: Vec3;
  material?: THREE.Material;
  diorama: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  children?: ReactNode;
}) {
  // Distinct keys: the two looks must be different mesh instances, never one mesh switching between a
  // `geometry` prop and a <boxGeometry> child.
  if (diorama) {
    return (
      <mesh
        key="rounded"
        geometry={roundedBox(args[0], args[1], args[2], 1)}
        position={position}
        material={material}
        castShadow={castShadow}
        receiveShadow={receiveShadow}
      >
        {children}
      </mesh>
    );
  }
  return (
    <mesh key="sharp" position={position} material={material} castShadow={castShadow} receiveShadow={receiveShadow}>
      <boxGeometry args={args} />
      {children}
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Border Glow (reused for rooms and casual areas)
// ---------------------------------------------------------------------------

function BorderGlow({ center, size, glowColor, diorama }: {
  center: [number, number, number]; size: number; glowColor: string; diorama: boolean;
}) {
  const [cx, , cz] = center;
  const t = 0.06;

  // The neon style glows; the diorama paints the same outline flat.
  const borderMat = useMemo(() => new THREE.MeshStandardMaterial(
    diorama
      ? { color: glowColor, emissive: glowColor, emissiveIntensity: 0.12, roughness: 0.85, transparent: true, opacity: 0.7 }
      : { color: glowColor, emissive: glowColor, emissiveIntensity: 1.5, roughness: 0.2, transparent: true, opacity: 0.35 },
  ), [glowColor, diorama]);
  useEffect(() => () => borderMat.dispose(), [borderMat]);

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
// Furniture materials — metal in the cyberdrome, matte in the diorama
// ---------------------------------------------------------------------------

interface FurnitureMats { deskMat: THREE.Material; monFrameMat: THREE.Material; chairMat: THREE.Material }

function useFurnitureMaterials(theme: Scene3DTheme, diorama: boolean): FurnitureMats {
  const mats = useMemo(() => (diorama
    ? {
        deskMat: new THREE.MeshStandardMaterial({ color: theme.desk, roughness: 0.75, metalness: 0 }),
        monFrameMat: new THREE.MeshStandardMaterial({ color: theme.monitorFrame, roughness: 0.55, metalness: 0.1 }),
        chairMat: new THREE.MeshStandardMaterial({ color: theme.chair, roughness: 0.8, metalness: 0 }),
      }
    : {
        deskMat: new THREE.MeshStandardMaterial({ color: theme.desk, roughness: 0.5, metalness: 0.6 }),
        monFrameMat: new THREE.MeshStandardMaterial({ color: theme.monitorFrame, roughness: 0.3, metalness: 0.8 }),
        chairMat: new THREE.MeshStandardMaterial({ color: theme.chair, roughness: 0.55, metalness: 0.5 }),
      }), [theme.desk, theme.monitorFrame, theme.chair, diorama]);

  // #49: Dispose materials on unmount to prevent WebGL memory leaks
  useEffect(() => () => {
    mats.deskMat.dispose();
    mats.monFrameMat.dispose();
    mats.chairMat.dispose();
  }, [mats]);
  return mats;
}

// ---------------------------------------------------------------------------
// Shared Desk + Chair
// ---------------------------------------------------------------------------

function DeskWithChair({ x, z, rotation, seatX, seatZ, faceRot, screenColor, deskMat, monFrameMat, chairMat, diorama }: {
  x: number; z: number; rotation: number;
  seatX: number; seatZ: number; faceRot: number;
  screenColor: string;
  deskMat: THREE.Material; monFrameMat: THREE.Material; chairMat: THREE.Material;
  diorama: boolean;
}) {
  return (
    <group>
      <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
        <Block diorama={diorama} args={[1.5, 0.05, 0.65]} position={[0, 0.7, 0]} material={deskMat} castShadow receiveShadow />
        <Block diorama={diorama} args={[0.04, 0.66, 0.58]} position={[-0.72, 0.35, 0]} material={deskMat} castShadow />
        <Block diorama={diorama} args={[0.04, 0.66, 0.58]} position={[0.72, 0.35, 0]} material={deskMat} castShadow />
        <Block diorama={diorama} args={[0.48, 0.32, 0.025]} position={[0, 0.92, -0.2]} material={monFrameMat} />
        <Block diorama={diorama} args={[0.44, 0.28, 0.005]} position={[0, 0.92, -0.185]}>
          <meshStandardMaterial color={screenColor} emissive={screenColor} emissiveIntensity={diorama ? 0.45 : 0.6} roughness={0.3} />
        </Block>
        <Block diorama={diorama} args={[0.32, 0.012, 0.1]} position={[0, 0.72, 0.12]} material={deskMat} />
      </group>
      <group position={[seatX, 0, seatZ]} rotation={[0, faceRot, 0]}>
        <Block diorama={diorama} args={[0.36, 0.03, 0.36]} position={[0, 0.4, 0]} material={chairMat} />
        <Block diorama={diorama} args={[0.34, 0.28, 0.03]} position={[0, 0.57, -0.155]} material={chairMat} />
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

function Room({ room, deskOffset, theme, diorama }: { room: RoomConfig; deskOffset: number; theme: Scene3DTheme; diorama: boolean }) {
  const [cx, , cz] = room.center;
  const roomSize = ROOM_HALF * 2;
  const wallH = diorama ? DIORAMA_WALL_H : WALL_H;
  const wallT = diorama ? DIORAMA_WALL_T : WALL_T;

  // Wall pieces come in two lengths: the doorway halves on the north/south sides, the full sides.
  const b = room.bounds;
  const mx = (b.minX + b.maxX) / 2;
  const mz = (b.minZ + b.maxZ) / 2;
  const dg = DOOR_GAP / 2;
  const segLen = (roomSize - DOOR_GAP) / 2;

  // Materials
  const wallMat = useMemo(() => new THREE.MeshStandardMaterial(
    diorama
      ? { color: theme.wall, roughness: 0.85, metalness: 0 }
      : { color: theme.wall, roughness: 0.2, metalness: 0.7, transparent: true, opacity: theme.wallOpacity, side: THREE.DoubleSide },
  ), [theme.wall, theme.wallOpacity, diorama]);
  // The ribbed stripes are a texture, and a texture's repeat is per texture — so each wall length gets
  // its own copy of the material (cheap: they share the program and the image).
  const ribbedWallMats = useMemo(() => {
    if (!diorama) return null;
    const make = (length: number) => {
      const m = wallMat.clone();
      m.map = getRibbedTexture(length);
      return m;
    };
    return { half: make(segLen), full: make(roomSize) };
  }, [diorama, wallMat, segLen, roomSize]);
  const cyStripMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.stripPrimary, emissive: theme.stripPrimary, emissiveIntensity: diorama ? 0.15 : 2, roughness: diorama ? 0.6 : 0.2,
  }), [theme.stripPrimary, diorama]);
  const mgStripMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.stripSecondary, emissive: theme.stripSecondary, emissiveIntensity: diorama ? 0.15 : 2, roughness: diorama ? 0.6 : 0.2,
  }), [theme.stripSecondary, diorama]);
  const { deskMat, monFrameMat, chairMat } = useFurnitureMaterials(theme, diorama);

  // #49: Dispose materials on unmount to prevent WebGL memory leaks
  useEffect(() => {
    return () => {
      wallMat.dispose();
      ribbedWallMats?.half.dispose();
      ribbedWallMats?.full.dispose();
      cyStripMat.dispose();
      mgStripMat.dispose();
    };
  }, [wallMat, ribbedWallMats, cyStripMat, mgStripMat]);

  const stripMat = room.stripColor === 0 ? cyStripMat : mgStripMat;
  const desks = useMemo(() => buildDynamicDeskDefs([room]), [room]);

  // Wall helpers
  const wallMatFor = (len: number): THREE.Material =>
    ribbedWallMats ? (len === segLen ? ribbedWallMats.half : ribbedWallMats.full) : wallMat;

  function HWall({ x, z, len }: { x: number; z: number; len: number }) {
    return (
      <group>
        <Block diorama={diorama} args={[len, wallH, wallT]} position={[x, wallH / 2, z]} material={wallMatFor(len)} castShadow receiveShadow />
        <Block diorama={diorama} args={[len, 0.04, wallT + 0.06]} position={[x, wallH, z]} material={stripMat} />
      </group>
    );
  }

  function VWall({ x, z, len }: { x: number; z: number; len: number }) {
    return (
      <group>
        <Block diorama={diorama} args={[wallT, wallH, len]} position={[x, wallH / 2, z]} material={wallMatFor(len)} castShadow receiveShadow />
        <Block diorama={diorama} args={[wallT + 0.06, 0.04, len]} position={[x, wallH, z]} material={stripMat} />
      </group>
    );
  }

  return (
    <group>
      {/* Floor panel */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.003, cz]} receiveShadow>
        <planeGeometry args={[roomSize, roomSize]} />
        <meshStandardMaterial
          key={diorama ? 'slab' : 'plain'} // a new material per look: toggling `map` on one needs needsUpdate (see environmentMaterials.test.ts)
          color={theme.roomFloor}
          map={diorama ? getSlabTexture(roomSize) : null}
          roughness={diorama ? 0.9 : 0.5}
          metalness={diorama ? 0 : 0.2}
        />
      </mesh>
      <BorderGlow center={room.center} size={roomSize} glowColor={theme.borderGlow} diorama={diorama} />

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
          diorama={diorama}
        />
      ))}

      {/* Room light */}
      <pointLight
        color={theme.roomLight1} intensity={diorama ? 8 * dioramaLighting(theme).pointScale : 8} distance={8}
        decay={1.5} position={[cx, WALL_H - 0.2, cz]} castShadow={false}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Corridor Desks (outdoor workstations for unassigned robots)
// ---------------------------------------------------------------------------

function CorridorDesks({ rooms, theme, diorama }: { rooms: RoomConfig[]; theme: Scene3DTheme; diorama: boolean }) {
  const { deskMat, monFrameMat, chairMat } = useFurnitureMaterials(theme, diorama);

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
          diorama={diorama}
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

function CoffeeLounge({ area, theme, diorama }: { area: CasualArea; theme: Scene3DTheme; diorama: boolean }) {
  const [cx, , cz] = area.center;
  const areaSize = LOUNGE_SIZE;
  const TABLE_SPACING = LOUNGE_TABLE_SPACING;

  const floorMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.coffeeFloor, map: diorama ? getSlabTexture(areaSize) : null,
    roughness: diorama ? 0.9 : 0.6, metalness: diorama ? 0 : 0.2,
  }), [theme.coffeeFloor, diorama, areaSize]);
  const furnitureMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.coffeeFurniture, roughness: diorama ? 0.8 : 0.5, metalness: diorama ? 0 : 0.4,
  }), [theme.coffeeFurniture, diorama]);
  const counterTopMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.coffeeAccent, emissive: theme.coffeeAccent, emissiveIntensity: diorama ? 0.12 : 0.4, roughness: diorama ? 0.6 : 0.3,
  }), [theme.coffeeAccent, diorama]);
  useEffect(() => () => {
    floorMat.dispose();
    furnitureMat.dispose();
    counterTopMat.dispose();
  }, [floorMat, furnitureMat, counterTopMat]);

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
      <BorderGlow center={area.center} size={areaSize} glowColor={theme.coffeeAccent} diorama={diorama} />

      {/* 4 coffee tables in a 2x2 grid */}
      {tables.map(([tx, tz], i) => (
        <CoffeeTable key={i} x={tx} z={tz} mat={furnitureMat} />
      ))}

      {/* Counter bar along north edge */}
      <Block diorama={diorama} args={[5, 0.9, 0.3]} position={[cx, 0.5, cz - areaSize / 2 + 0.4]} material={furnitureMat} castShadow />
      <Block diorama={diorama} args={[5.1, 0.03, 0.35]} position={[cx, 0.96, cz - areaSize / 2 + 0.4]} material={counterTopMat} />

      {/* Warm amber point light */}
      <pointLight
        color={theme.coffeeAccent} intensity={diorama ? 6 * dioramaLighting(theme).pointScale : 6} distance={12}
        decay={1.5} position={[cx, 2.5, cz]} castShadow={false}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Data Particle Streams (cyberdrome only)
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
// Stars Background (cyberdrome only)
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

function Lighting({ theme, diorama }: { theme: Scene3DTheme; diorama: boolean }) {
  // The diorama keeps the theme's colours and rebalances the intensities: softer key light, stronger
  // sky fill, quieter coloured washes (see dioramaLighting.ts).
  const rig = diorama ? dioramaLighting(theme) : null;
  return (
    <group>
      <ambientLight color={theme.ambientColor} intensity={rig ? rig.ambient : theme.ambientIntensity} />
      <directionalLight
        color={theme.dirColor}
        intensity={rig ? rig.dir : theme.dirIntensity}
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
      <directionalLight color={theme.fillColor} intensity={rig ? rig.fill : theme.fillIntensity} position={[-6, 15, -8]} />
      <pointLight color={theme.pointLight1} intensity={rig ? 6 * rig.pointScale : 6} distance={50} decay={1.5} position={[-10, 8, -10]} />
      <pointLight color={theme.pointLight2} intensity={rig ? 5 * rig.pointScale : 5} distance={50} decay={1.5} position={[10, 7, 10]} />
      <hemisphereLight args={[theme.hemisphereUp, theme.hemisphereDown, rig ? rig.hemisphere : theme.hemisphereIntensity]} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

interface EnvironmentProps {
  rooms: RoomConfig[];
  casualAreas?: CasualArea[];
  /** Every seat in the scene — the diorama outlines each one on the floor. */
  workstations: Workstation[];
  theme: Scene3DTheme;
  sceneStyle: SceneStyle;
  /** The paint tone for this palette (`clayToneFor`) — derived in the DOM layer, like `sceneStyle`. */
  tone: ClayTone;
}

export default function CyberdromeEnvironment({ rooms, casualAreas, workstations, theme, sceneStyle, tone }: EnvironmentProps) {
  const floorSize = useMemo(() => computeFloorSize(rooms), [rooms]);
  const diorama = sceneStyle === 'diorama';

  return (
    <group>
      <Lighting theme={theme} diorama={diorama} />

      {/* Main floor (+ the neon grid in the cyberdrome) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[floorSize, floorSize]} />
        <meshStandardMaterial
          key={diorama ? 'slab' : 'plain'} // as above
          color={theme.floor}
          map={diorama ? getSlabTexture(floorSize) : null}
          roughness={diorama ? 0.9 : 0.7}
          metalness={diorama ? 0 : 0.3}
        />
      </mesh>
      {!diorama && (
        <gridHelper args={[floorSize, Math.round(floorSize / 5), theme.grid2, theme.grid2]} position={[0, 0.005, 0]} />
      )}

      {/* Rooms (single map — floor, walls, desks, light per room) */}
      {rooms.map((room, ri) => (
        <Room key={room.roomId} room={room} deskOffset={ri * 2} theme={theme} diorama={diorama} />
      ))}

      <CorridorDesks rooms={rooms} theme={theme} diorama={diorama} />

      {casualAreas?.map((area) => (
        <CoffeeLounge key={area.type} area={area} theme={theme} diorama={diorama} />
      ))}

      {diorama ? (
        <>
          <GroundMarkings rooms={rooms} workstations={workstations} theme={theme} tone={tone} />
          <DoorPosts rooms={rooms} theme={theme} />
          <Plants rooms={rooms} workstations={workstations} areas={casualAreas ?? NO_AREAS} theme={theme} />
        </>
      ) : (
        <>
          <DataParticles floorSize={floorSize} theme={theme} />
          <Stars theme={theme} />
        </>
      )}
    </group>
  );
}

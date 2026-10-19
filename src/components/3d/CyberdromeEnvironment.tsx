/**
 * CyberdromeEnvironment — Dynamic scene elements for the Cyberdrome.
 * Renders floor, walls, desks, lighting and the painted decals.
 * Rooms are created/destroyed dynamically based on RoomConfig[].
 *
 * The scene is a soft tabletop diorama: matte rounded furniture, low ribbed walls, painted lanes and
 * seat bays, a gentle light rig. The colours come from the theme.
 */
import { useMemo, useEffect } from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import {
  WALL_H, ROOM_HALF, DOOR_GAP,
  computeFloorSize, buildDynamicDeskDefs, buildCorridorWorkstations,
  type RoomConfig,
  type CasualArea,
  type Workstation,
} from '@/lib/cyberdromeScene';
import { PALETTE } from '@/lib/robot3DGeometry';
import { roundedBox } from '@/lib/dioramaGeometry';
import { dioramaLighting, type ClayTone } from '@/lib/dioramaLighting';
import { DIORAMA_WALL_H, DIORAMA_WALL_T, LOUNGE_SIZE, LOUNGE_TABLE_SPACING } from '@/lib/dioramaProps';
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
// Block — a softly rounded box (shared geometry, see dioramaGeometry.ts)
// ---------------------------------------------------------------------------

function Block({ args, position, material, castShadow, receiveShadow, children }: {
  args: Vec3;
  position: Vec3;
  material?: THREE.Material;
  castShadow?: boolean;
  receiveShadow?: boolean;
  children?: ReactNode;
}) {
  return (
    <mesh
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

// ---------------------------------------------------------------------------
// Border Glow (reused for rooms and casual areas)
// ---------------------------------------------------------------------------

function BorderGlow({ center, size, glowColor }: {
  center: [number, number, number]; size: number; glowColor: string;
}) {
  const [cx, , cz] = center;
  const t = 0.06;

  // A flat painted outline, barely lit from within.
  const borderMat = useMemo(() => new THREE.MeshStandardMaterial(
    { color: glowColor, emissive: glowColor, emissiveIntensity: 0.12, roughness: 0.85, transparent: true, opacity: 0.7 },
  ), [glowColor]);
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
// Furniture materials — matte
// ---------------------------------------------------------------------------

interface FurnitureMats { deskMat: THREE.Material; monFrameMat: THREE.Material; chairMat: THREE.Material }

function useFurnitureMaterials(theme: Scene3DTheme): FurnitureMats {
  const mats = useMemo(() => ({
    deskMat: new THREE.MeshStandardMaterial({ color: theme.desk, roughness: 0.75, metalness: 0 }),
    monFrameMat: new THREE.MeshStandardMaterial({ color: theme.monitorFrame, roughness: 0.55, metalness: 0.1 }),
    chairMat: new THREE.MeshStandardMaterial({ color: theme.chair, roughness: 0.8, metalness: 0 }),
  }), [theme.desk, theme.monitorFrame, theme.chair]);

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

function DeskWithChair({ x, z, rotation, seatX, seatZ, faceRot, screenColor, deskMat, monFrameMat, chairMat }: {
  x: number; z: number; rotation: number;
  seatX: number; seatZ: number; faceRot: number;
  screenColor: string;
  deskMat: THREE.Material; monFrameMat: THREE.Material; chairMat: THREE.Material;
}) {
  return (
    <group>
      <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
        <Block args={[1.5, 0.05, 0.65]} position={[0, 0.7, 0]} material={deskMat} castShadow receiveShadow />
        <Block args={[0.04, 0.66, 0.58]} position={[-0.72, 0.35, 0]} material={deskMat} castShadow />
        <Block args={[0.04, 0.66, 0.58]} position={[0.72, 0.35, 0]} material={deskMat} castShadow />
        <Block args={[0.48, 0.32, 0.025]} position={[0, 0.92, -0.2]} material={monFrameMat} />
        <Block args={[0.44, 0.28, 0.005]} position={[0, 0.92, -0.185]}>
          <meshStandardMaterial color={screenColor} emissive={screenColor} emissiveIntensity={0.45} roughness={0.3} />
        </Block>
        <Block args={[0.32, 0.012, 0.1]} position={[0, 0.72, 0.12]} material={deskMat} />
      </group>
      <group position={[seatX, 0, seatZ]} rotation={[0, faceRot, 0]}>
        <Block args={[0.36, 0.03, 0.36]} position={[0, 0.4, 0]} material={chairMat} />
        <Block args={[0.34, 0.28, 0.03]} position={[0, 0.57, -0.155]} material={chairMat} />
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
  const wallH = DIORAMA_WALL_H;
  const wallT = DIORAMA_WALL_T;

  // Wall pieces come in two lengths: the doorway halves on the north/south sides, the full sides.
  const b = room.bounds;
  const mx = (b.minX + b.maxX) / 2;
  const mz = (b.minZ + b.maxZ) / 2;
  const dg = DOOR_GAP / 2;
  const segLen = (roomSize - DOOR_GAP) / 2;

  // Materials
  const wallMat = useMemo(() => new THREE.MeshStandardMaterial(
    { color: theme.wall, roughness: 0.85, metalness: 0 },
  ), [theme.wall]);
  // The ribbed stripes are a texture, and a texture's repeat is per texture — so each wall length gets
  // its own copy of the material (cheap: they share the program and the image).
  const ribbedWallMats = useMemo(() => {
    const make = (length: number) => {
      const m = wallMat.clone();
      m.map = getRibbedTexture(length);
      return m;
    };
    return { half: make(segLen), full: make(roomSize) };
  }, [wallMat, segLen, roomSize]);
  const cyStripMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.stripPrimary, emissive: theme.stripPrimary, emissiveIntensity: 0.15, roughness: 0.6,
  }), [theme.stripPrimary]);
  const mgStripMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.stripSecondary, emissive: theme.stripSecondary, emissiveIntensity: 0.15, roughness: 0.6,
  }), [theme.stripSecondary]);
  const { deskMat, monFrameMat, chairMat } = useFurnitureMaterials(theme);

  // #49: Dispose materials on unmount to prevent WebGL memory leaks
  useEffect(() => {
    return () => {
      wallMat.dispose();
      ribbedWallMats.half.dispose();
      ribbedWallMats.full.dispose();
      cyStripMat.dispose();
      mgStripMat.dispose();
    };
  }, [wallMat, ribbedWallMats, cyStripMat, mgStripMat]);

  const stripMat = room.stripColor === 0 ? cyStripMat : mgStripMat;
  const desks = useMemo(() => buildDynamicDeskDefs([room]), [room]);

  // Wall helpers
  const wallMatFor = (len: number): THREE.Material =>
    (len === segLen ? ribbedWallMats.half : ribbedWallMats.full);

  function HWall({ x, z, len }: { x: number; z: number; len: number }) {
    return (
      <group>
        <Block args={[len, wallH, wallT]} position={[x, wallH / 2, z]} material={wallMatFor(len)} castShadow receiveShadow />
        <Block args={[len, 0.04, wallT + 0.06]} position={[x, wallH, z]} material={stripMat} />
      </group>
    );
  }

  function VWall({ x, z, len }: { x: number; z: number; len: number }) {
    return (
      <group>
        <Block args={[wallT, wallH, len]} position={[x, wallH / 2, z]} material={wallMatFor(len)} castShadow receiveShadow />
        <Block args={[wallT + 0.06, 0.04, len]} position={[x, wallH, z]} material={stripMat} />
      </group>
    );
  }

  return (
    <group>
      {/* Floor panel */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.003, cz]} receiveShadow>
        <planeGeometry args={[roomSize, roomSize]} />
        <meshStandardMaterial color={theme.roomFloor} map={getSlabTexture(roomSize)} roughness={0.9} metalness={0} />
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
        color={theme.roomLight1} intensity={8 * dioramaLighting(theme).pointScale} distance={8}
        decay={1.5} position={[cx, WALL_H - 0.2, cz]} castShadow={false}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Corridor Desks (outdoor workstations for unassigned robots)
// ---------------------------------------------------------------------------

function CorridorDesks({ rooms, theme }: { rooms: RoomConfig[]; theme: Scene3DTheme }) {
  const { deskMat, monFrameMat, chairMat } = useFurnitureMaterials(theme);

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
  const areaSize = LOUNGE_SIZE;
  const TABLE_SPACING = LOUNGE_TABLE_SPACING;

  const floorMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.coffeeFloor, map: getSlabTexture(areaSize), roughness: 0.9, metalness: 0,
  }), [theme.coffeeFloor, areaSize]);
  const furnitureMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.coffeeFurniture, roughness: 0.8, metalness: 0,
  }), [theme.coffeeFurniture]);
  const counterTopMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: theme.coffeeAccent, emissive: theme.coffeeAccent, emissiveIntensity: 0.12, roughness: 0.6,
  }), [theme.coffeeAccent]);
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
      <BorderGlow center={area.center} size={areaSize} glowColor={theme.coffeeAccent} />

      {/* 4 coffee tables in a 2x2 grid */}
      {tables.map(([tx, tz], i) => (
        <CoffeeTable key={i} x={tx} z={tz} mat={furnitureMat} />
      ))}

      {/* Counter bar along north edge */}
      <Block args={[5, 0.9, 0.3]} position={[cx, 0.5, cz - areaSize / 2 + 0.4]} material={furnitureMat} castShadow />
      <Block args={[5.1, 0.03, 0.35]} position={[cx, 0.96, cz - areaSize / 2 + 0.4]} material={counterTopMat} />

      {/* Warm amber point light */}
      <pointLight
        color={theme.coffeeAccent} intensity={6 * dioramaLighting(theme).pointScale} distance={12}
        decay={1.5} position={[cx, 2.5, cz]} castShadow={false}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

function Lighting({ theme }: { theme: Scene3DTheme }) {
  // The theme's colours with rebalanced intensities: softer key light, stronger sky fill, quieter
  // coloured washes (see dioramaLighting.ts).
  const rig = dioramaLighting(theme);
  return (
    <group>
      <ambientLight color={theme.ambientColor} intensity={rig.ambient} />
      <directionalLight
        color={theme.dirColor}
        intensity={rig.dir}
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
      <directionalLight color={theme.fillColor} intensity={rig.fill} position={[-6, 15, -8]} />
      <pointLight color={theme.pointLight1} intensity={6 * rig.pointScale} distance={50} decay={1.5} position={[-10, 8, -10]} />
      <pointLight color={theme.pointLight2} intensity={5 * rig.pointScale} distance={50} decay={1.5} position={[10, 7, 10]} />
      <hemisphereLight args={[theme.hemisphereUp, theme.hemisphereDown, rig.hemisphere]} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

interface EnvironmentProps {
  rooms: RoomConfig[];
  casualAreas?: CasualArea[];
  /** Every seat in the scene — each one is outlined on the floor. */
  workstations: Workstation[];
  theme: Scene3DTheme;
  /** The paint tone for this palette (`clayToneFor`) — derived in the DOM layer. */
  tone: ClayTone;
}

export default function CyberdromeEnvironment({ rooms, casualAreas, workstations, theme, tone }: EnvironmentProps) {
  const floorSize = useMemo(() => computeFloorSize(rooms), [rooms]);

  return (
    <group>
      <Lighting theme={theme} />

      {/* Main floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[floorSize, floorSize]} />
        <meshStandardMaterial color={theme.floor} map={getSlabTexture(floorSize)} roughness={0.9} metalness={0} />
      </mesh>

      {/* Rooms (single map — floor, walls, desks, light per room) */}
      {rooms.map((room, ri) => (
        <Room key={room.roomId} room={room} deskOffset={ri * 2} theme={theme} />
      ))}

      <CorridorDesks rooms={rooms} theme={theme} />

      {casualAreas?.map((area) => (
        <CoffeeLounge key={area.type} area={area} theme={theme} />
      ))}

      <GroundMarkings rooms={rooms} workstations={workstations} theme={theme} tone={tone} />
      <DoorPosts rooms={rooms} theme={theme} />
      <Plants rooms={rooms} workstations={workstations} areas={casualAreas ?? NO_AREAS} theme={theme} />
    </group>
  );
}

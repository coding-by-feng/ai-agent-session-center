/**
 * RoomLabels — 3D Text labels rendered in WebGL at room doorways.
 * Uses drei <Text> (troika-three-text SDF) for proper 3D rendering
 * that never covers DOM overlays and scales naturally with camera zoom.
 */
import { Text } from '@react-three/drei';
import { computeRoomCenter, ROOM_HALF, type RoomConfig, type CasualArea } from '@/lib/cyberdromeScene';
import type { Room } from '@/stores/roomStore';
import type { Session } from '@/types/session';

// Strip color → neon label color (matches wall strip colors in CyberdromeEnvironment)
const STRIP_COLORS = ['#00f0ff', '#ff00aa'] as const;
// Dimmer hex variants for unit count text (drei <Text> doesn't support rgba)
const STRIP_COLORS_DIM = ['#007f88', '#881155'] as const;

interface RoomLabelsProps {
  rooms: RoomConfig[];
  casualAreas?: CasualArea[];
  storeRooms: Room[];
  sessions?: Map<string, Session>;
}

export default function RoomLabels({ rooms: roomConfigs, casualAreas, storeRooms, sessions }: RoomLabelsProps) {
  const rooms = storeRooms;

  return (
    <>
      {roomConfigs.map((roomCfg) => {
        const [cx, , cz] = computeRoomCenter(roomCfg.index);
        const room = rooms.find((r) => r.id === roomCfg.roomId);
        const sessionCount = sessions
          ? (room?.sessionIds.filter(id => {
              const s = sessions.get(id);
              return s && s.status !== 'ended';
            }).length ?? 0)
          : (room?.sessionIds.length ?? 0);
        const color = STRIP_COLORS[roomCfg.stripColor] ?? STRIP_COLORS[0];
        const dimColor = STRIP_COLORS_DIM[roomCfg.stripColor] ?? STRIP_COLORS_DIM[0];

        return (
          <group key={roomCfg.roomId}>
            {/* Room name — floating above room center, billboard-style */}
            <Text
              position={[cx, 2.8, cz]}
              rotation={[-Math.PI / 2, 0, 0]}
              fontSize={0.7}
              color={color}
              anchorX="center"
              anchorY="middle"
              letterSpacing={0.15}
              outlineWidth={0.02}
              outlineColor="#000000"
            >
              {roomCfg.name.toUpperCase()}
            </Text>

            {/* Unit count — just south of room name, still above room */}
            <Text
              position={[cx, 2.8, cz + 1.0]}
              rotation={[-Math.PI / 2, 0, 0]}
              fontSize={0.35}
              color={dimColor}
              anchorX="center"
              anchorY="middle"
              letterSpacing={0.1}
            >
              {`${sessionCount} ${sessionCount === 1 ? 'UNIT' : 'UNITS'}`}
            </Text>
          </group>
        );
      })}

      {/* Casual area name labels — floating above area center */}
      {casualAreas?.map((area) => {
        const [ax, , az] = area.center;
        const labelColor = '#ff9944';
        const labelText = 'COFFEE LOUNGE';

        return (
          <Text
            key={area.type}
            position={[ax, 2.8, az]}
            rotation={[-Math.PI / 2, 0, 0]}
            fontSize={0.8}
            color={labelColor}
            anchorX="center"
            anchorY="middle"
            letterSpacing={0.15}
            outlineWidth={0.02}
            outlineColor="#000000"
          >
            {labelText}
          </Text>
        );
      })}
    </>
  );
}

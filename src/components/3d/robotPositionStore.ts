/**
 * robotPositionStore — Non-reactive position registry for robot world positions.
 * Updated every frame by SessionRobot, read every frame by SubagentConnections.
 * Uses a plain Map (not Zustand) to avoid triggering React re-renders.
 */

interface RobotPosition {
  x: number;
  y: number;
  z: number;
}

const positions = new Map<string, RobotPosition>();

export const robotPositionStore = {
  set(sessionId: string, x: number, y: number, z: number) {
    const existing = positions.get(sessionId);
    if (existing) {
      existing.x = x;
      existing.y = y;
      existing.z = z;
    } else {
      positions.set(sessionId, { x, y, z });
    }
  },

  get(sessionId: string): RobotPosition | undefined {
    return positions.get(sessionId);
  },

  delete(sessionId: string) {
    positions.delete(sessionId);
  },

  has(sessionId: string): boolean {
    return positions.has(sessionId);
  },
};

// ---------------------------------------------------------------------------
// Nav info store — full navigation state for persistence
// ---------------------------------------------------------------------------

export interface StoredNavInfo {
  x: number;
  y: number;
  z: number;
  rotY: number;
  mode: number;
  deskIdx: number;
}

const navInfoMap = new Map<string, StoredNavInfo>();

export function updateNavInfo(sessionId: string, info: StoredNavInfo): void {
  navInfoMap.set(sessionId, info);
}

export function getNavInfo(sessionId: string): StoredNavInfo | undefined {
  return navInfoMap.get(sessionId);
}

export function getAllNavInfo(): Map<string, StoredNavInfo> {
  return navInfoMap;
}

export function removeNavInfo(sessionId: string): void {
  navInfoMap.delete(sessionId);
}

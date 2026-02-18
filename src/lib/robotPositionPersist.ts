/**
 * Persist robot positions to sessionStorage for refresh survival.
 */

const STORAGE_KEY = 'cyberdrome-robot-positions';

export interface PersistedRobotState {
  posX: number;
  posZ: number;
  rotY: number;
  mode: number;       // NAV_WALK=0, NAV_GOTO=1, NAV_SIT=2, NAV_IDLE=3
  deskIdx: number;    // workstation index, or -1
}

/** Save all current positions to sessionStorage */
export function saveRobotPositions(positions: Map<string, PersistedRobotState>): void {
  const obj: Record<string, PersistedRobotState> = {};
  positions.forEach((state, sessionId) => {
    obj[sessionId] = state;
  });
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // Storage full or unavailable — silently fail
  }
}

/** Load persisted positions from sessionStorage */
export function loadRobotPositions(): Map<string, PersistedRobotState> {
  const map = new Map<string, PersistedRobotState>();
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return map;
    const obj = JSON.parse(raw) as Record<string, PersistedRobotState>;
    for (const [id, state] of Object.entries(obj)) {
      map.set(id, state);
    }
  } catch {
    // Corrupted data — return empty
  }
  return map;
}

/** Remove a single session from persistence */
export function clearPersistedPosition(sessionId: string): void {
  const map = loadRobotPositions();
  map.delete(sessionId);
  saveRobotPositions(map);
}

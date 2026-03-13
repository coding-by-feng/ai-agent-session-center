/**
 * workspaceSnapshot.ts — Export/import live workspace state.
 * Captures session configs, project tab layouts, room assignments,
 * and session metadata so the workspace can be recreated later.
 */
import type { Session, SshConfig } from '@/types';
import type { Room } from '@/stores/roomStore';

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------

/** A single project file-view sub-tab (matches ProjectTabContainer's SubTab) */
export interface ProjectSubTab {
  id: string;
  label: string;
  /** User-set name that persists until renamed again or tab is closed */
  customLabel?: string;
  projectPath: string;
  initialPath?: string;
  /** True if initialPath points to a file (not a directory) */
  initialIsFile?: boolean;
}

export interface SessionSnapshot {
  /** Original session ID — used to remap room assignments on import */
  originalSessionId: string;
  title: string;
  label?: string;
  accentColor?: string;
  characterModel?: string;
  pinned?: boolean;
  enableOpsTerminal: boolean;
  sshConfig: SshConfig;
  projectTabs: { tabs: ProjectSubTab[]; active: string } | null;
}

export interface WorkspaceSnapshot {
  version: 1;
  exportedAt: number;
  sessions: SessionSnapshot[];
  rooms: Room[];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function getProjectTabs(sessionId: string): { tabs: ProjectSubTab[]; active: string } | null {
  try {
    const raw = localStorage.getItem(`agent-manager:project-tabs:session:${sessionId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) return parsed;
    }
  } catch { /* ignore */ }
  return null;
}

export function buildSnapshot(
  sessions: Map<string, Session>,
  rooms: Room[],
): WorkspaceSnapshot {
  const sessionSnapshots: SessionSnapshot[] = [];
  const exportedSessionIds = new Set<string>();

  for (const [_id, session] of sessions) {
    // Only export sessions that have SSH config (can be recreated)
    if (!session.sshConfig) continue;
    // Skip ended sessions without reconnect info
    if (session.status === 'ended' && !session.sshConfig) continue;

    exportedSessionIds.add(session.sessionId);
    sessionSnapshots.push({
      originalSessionId: session.sessionId,
      title: session.title,
      label: session.label,
      accentColor: session.accentColor,
      characterModel: session.characterModel,
      pinned: session.pinned,
      enableOpsTerminal: !!session.opsTerminalId,
      sshConfig: { ...session.sshConfig },
      projectTabs: getProjectTabs(session.sessionId),
    });
  }

  // Only include rooms that have at least one exported session, or are empty
  // (user may have created rooms before adding sessions).
  // Keep full sessionIds — only the exported ones will be remappable, but we
  // preserve the list so the structure is intact.
  const snapshotRooms = rooms.map((r) => ({ ...r }));

  return {
    version: 1,
    exportedAt: Date.now(),
    sessions: deduplicateSessions(sessionSnapshots),
    rooms: snapshotRooms,
  };
}

// ---------------------------------------------------------------------------
// Download as JSON file
// ---------------------------------------------------------------------------

export function downloadSnapshot(snapshot: WorkspaceSnapshot): void {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `workspace-snapshot-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Save to AASC config (server-side)
// ---------------------------------------------------------------------------

export async function saveToConfig(snapshot: WorkspaceSnapshot): Promise<void> {
  const res = await fetch('/api/workspace/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(data.error || 'Failed to save workspace');
  }
}

// ---------------------------------------------------------------------------
// Load from AASC config (server-side)
// ---------------------------------------------------------------------------

export async function loadFromConfig(): Promise<WorkspaceSnapshot | null> {
  const res = await fetch('/api/workspace/load');
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.version) return null;
  return data as WorkspaceSnapshot;
}

// ---------------------------------------------------------------------------
// Load from file
// ---------------------------------------------------------------------------

export function loadFromFile(file: File): Promise<WorkspaceSnapshot> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        if (!parsed.version || !Array.isArray(parsed.sessions)) {
          reject(new Error('Invalid workspace snapshot file'));
          return;
        }
        resolve(parsed as WorkspaceSnapshot);
      } catch {
        reject(new Error('Failed to parse snapshot file'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

// ---------------------------------------------------------------------------
// Deduplication — remove duplicate sessions by title + SSH config
// ---------------------------------------------------------------------------

function sessionDedupeKey(snap: SessionSnapshot): string {
  const cfg = snap.sshConfig;
  return [
    snap.title,
    cfg?.host ?? '',
    cfg?.port ?? '',
    cfg?.username ?? '',
    cfg?.workingDir ?? '',
    cfg?.command ?? '',
  ].join('\0');
}

export function deduplicateSessions(sessions: SessionSnapshot[]): SessionSnapshot[] {
  const seen = new Set<string>();
  const result: SessionSnapshot[] = [];
  for (const snap of sessions) {
    const key = sessionDedupeKey(snap);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(snap);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Import — recreate sessions from snapshot
// ---------------------------------------------------------------------------

export async function importSnapshot(
  snapshot: WorkspaceSnapshot,
  callbacks: {
    onSessionCreated: (terminalId: string, snap: SessionSnapshot) => void;
    onComplete: (created: number, failed: number) => void;
  },
): Promise<void> {
  let created = 0;
  let failed = 0;

  // Map old session IDs to new terminal IDs for room remapping
  const idRemap = new Map<string, string>();

  // Deduplicate sessions before importing
  const dedupedSessions = deduplicateSessions(snapshot.sessions);
  const skipped = snapshot.sessions.length - dedupedSessions.length;
  if (skipped > 0) {
    console.warn(`[workspace] Skipped ${skipped} duplicate session(s) during import`);
  }

  for (const sessionSnap of dedupedSessions) {
    const cfg = sessionSnap.sshConfig;
    if (!cfg) { failed++; continue; }

    try {
      const res = await fetch('/api/terminals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: cfg.host || 'localhost',
          port: cfg.port || 22,
          username: cfg.username,
          authMethod: cfg.authMethod,
          privateKeyPath: cfg.privateKeyPath,
          workingDir: cfg.workingDir || '~',
          command: cfg.command || 'claude',
          sessionTitle: sessionSnap.title,
          label: sessionSnap.label || undefined,
          enableOpsTerminal: sessionSnap.enableOpsTerminal || undefined,
        }),
      });
      const data = await res.json();
      if (data.ok && data.terminalId) {
        created++;

        // Track the old -> new ID mapping for room remapping
        if (sessionSnap.originalSessionId) {
          idRemap.set(sessionSnap.originalSessionId, data.terminalId);
        }

        callbacks.onSessionCreated(data.terminalId, sessionSnap);

        // Restore metadata (accent color, character model, pinned)
        if (sessionSnap.accentColor) {
          fetch(`/api/sessions/${encodeURIComponent(data.terminalId)}/accent-color`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ color: sessionSnap.accentColor }),
          }).catch(() => {});
        }
        if (sessionSnap.pinned) {
          fetch(`/api/sessions/${encodeURIComponent(data.terminalId)}/pinned`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned: true }),
          }).catch(() => {});
        }

        // Restore project tabs to localStorage under the new session ID
        // This preserves customLabel, initialPath, initialIsFile, etc.
        if (sessionSnap.projectTabs) {
          try {
            localStorage.setItem(
              `agent-manager:project-tabs:session:${data.terminalId}`,
              JSON.stringify(sessionSnap.projectTabs),
            );
          } catch { /* ignore */ }
        }
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  // Restore rooms with remapped session IDs
  if (snapshot.rooms && snapshot.rooms.length > 0) {
    try {
      const remappedRooms = snapshot.rooms.map((r) => ({
        ...r,
        // Remap old session IDs to new terminal IDs; drop any that weren't recreated
        sessionIds: r.sessionIds
          .map((oldId) => idRemap.get(oldId))
          .filter((newId): newId is string => newId != null),
      }));
      localStorage.setItem('session-rooms', JSON.stringify(remappedRooms));
    } catch { /* ignore */ }
  }

  callbacks.onComplete(created, failed);
}

// ---------------------------------------------------------------------------
// Auto-save — periodically save workspace snapshot to server config
// ---------------------------------------------------------------------------

let _autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_SAVE_DEBOUNCE_MS = 5_000;

/**
 * Schedule a debounced auto-save of the workspace snapshot to the server.
 * Call this whenever sessions or rooms change. Multiple rapid calls are
 * coalesced into a single save after the debounce period.
 */
export function scheduleAutoSave(
  getSessions: () => Map<string, Session>,
  getRooms: () => Room[],
): void {
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(async () => {
    _autoSaveTimer = null;
    try {
      const sessions = getSessions();
      const rooms = getRooms();
      // Only auto-save if there are sessions with SSH config
      const hasExportable = Array.from(sessions.values()).some((s) => !!s.sshConfig);
      if (!hasExportable) return;
      const snapshot = buildSnapshot(sessions, rooms);
      await saveToConfig(snapshot);
    } catch {
      // Silent failure — auto-save is best-effort
    }
  }, AUTO_SAVE_DEBOUNCE_MS);
}

/** Cancel any pending auto-save (e.g. on unmount) */
export function cancelAutoSave(): void {
  if (_autoSaveTimer) {
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = null;
  }
}

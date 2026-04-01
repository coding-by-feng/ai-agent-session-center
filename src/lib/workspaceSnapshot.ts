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
  /** Session status at export time (e.g. 'idle', 'working', 'ended') */
  status?: string;
  label?: string;
  accentColor?: string;
  characterModel?: string;
  pinned?: boolean;
  muted?: boolean;
  alerted?: boolean;
  enableOpsTerminal: boolean;
  sshConfig: SshConfig;
  /** Original startup command with full params (e.g. 'gemini --model pro', 'codex --full-auto') */
  startupCommand?: string;
  /** Permission mode at export time — used to reconstruct CLI flags when startupCommand is absent */
  permissionMode?: string | null;
  projectTabs: { tabs: ProjectSubTab[]; active: string } | null;
  /** Open file tabs per project sub-tab: key = subTabId, value = { tabs, active } */
  fileTabs?: Record<string, { tabs: { path: string; name: string }[]; active: string | null }>;
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

/** Collect open file tabs for each project sub-tab of a session */
function getFileTabs(sessionId: string, projectTabs: { tabs: ProjectSubTab[] } | null): Record<string, { tabs: { path: string; name: string }[]; active: string | null }> | undefined {
  if (!projectTabs) return undefined;
  const result: Record<string, { tabs: { path: string; name: string }[]; active: string | null }> = {};
  let found = false;
  for (const subTab of projectTabs.tabs) {
    try {
      const raw = localStorage.getItem(`agent-manager:file-tabs:${sessionId}:${subTab.id}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
          result[subTab.id] = { tabs: parsed.tabs, active: parsed.active ?? null };
          found = true;
        }
      }
    } catch { /* ignore */ }
  }
  return found ? result : undefined;
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
    // Never recreate sessions that were explicitly killed or archived by the user
    if (session.archived) continue;
    // Skip ended sessions — they can't be meaningfully restored
    if (session.status === 'ended') continue;

    exportedSessionIds.add(session.sessionId);
    const projectTabs = getProjectTabs(session.sessionId);
    sessionSnapshots.push({
      originalSessionId: session.sessionId,
      title: session.title,
      status: session.status,
      label: session.label,
      accentColor: session.accentColor,
      characterModel: session.characterModel,
      pinned: session.pinned,
      muted: session.muted,
      alerted: session.alerted,
      enableOpsTerminal: !!session.opsTerminalId || !!session.hadOpsTerminal,
      sshConfig: { ...session.sshConfig },
      startupCommand: session.startupCommand,
      permissionMode: session.permissionMode,
      projectTabs,
      fileTabs: getFileTabs(session.sessionId, projectTabs),
    });
  }

  // Only include rooms that reference exported sessions.
  // Filter out stale session IDs (hook-only, ended, or excluded sessions)
  // so the snapshot stays clean and importable without orphaned references.
  const snapshotRooms = rooms.map((r) => ({
    ...r,
    sessionIds: [...new Set(r.sessionIds.filter((id) => exportedSessionIds.has(id)))],
  }));

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
    snap.startupCommand ?? '',
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
    onProgress?: (done: number, total: number, currentTitle: string) => void;
    onComplete: (created: number, failed: number) => void;
  },
): Promise<void> {
  let created = 0;
  let failed = 0;

  // Map old session IDs to new terminal IDs for room remapping
  const idRemap = new Map<string, string>();

  // Build a map of dropped (duplicate) session IDs to their canonical session ID,
  // so rooms referencing duplicate sessions can still be remapped correctly.
  const canonicalMap = new Map<string, string>(); // droppedOriginalId -> canonicalOriginalId
  {
    const seenKeys = new Map<string, string>(); // dedupeKey -> first originalSessionId
    for (const snap of snapshot.sessions) {
      const key = sessionDedupeKey(snap);
      if (!seenKeys.has(key)) {
        seenKeys.set(key, snap.originalSessionId);
      } else {
        canonicalMap.set(snap.originalSessionId, seenKeys.get(key)!);
      }
    }
  }

  // Deduplicate sessions before importing
  const dedupedSessions = deduplicateSessions(snapshot.sessions);
  const skipped = snapshot.sessions.length - dedupedSessions.length;
  if (skipped > 0) {
    console.warn(`[workspace] Skipped ${skipped} duplicate session(s) during import`);
  }

  const total = dedupedSessions.length;
  let processedCount = 0;

  for (const sessionSnap of dedupedSessions) {
    callbacks.onProgress?.(processedCount, total, sessionSnap.title);
    const cfg = sessionSnap.sshConfig;
    if (!cfg) { failed++; processedCount++; continue; }

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
          startupCommand: sessionSnap.startupCommand || undefined,
          permissionMode: sessionSnap.permissionMode || undefined,
          originalSessionId: sessionSnap.originalSessionId || undefined,
        }),
      });
      const data = await res.json();
      if (data.ok && data.terminalId) {
        created++;

        // Track the old -> new ID mapping for room remapping
        if (sessionSnap.originalSessionId) {
          idRemap.set(sessionSnap.originalSessionId, data.terminalId);
        }

        processedCount++;
        callbacks.onProgress?.(processedCount, total, sessionSnap.title);
        callbacks.onSessionCreated(data.terminalId, sessionSnap);

        // If the session was deduplicated to an existing session without an active
        // PTY (e.g. after a server restart), trigger a reconnect to establish a
        // fresh SSH connection under the existing session card.
        if (data.deduplicated && !data.hasTerminal) {
          fetch(`/api/sessions/${encodeURIComponent(data.terminalId)}/reconnect-terminal`, {
            method: 'POST',
          }).catch(() => {});
        }

        // Restore metadata (accent color, character model, pinned)
        if (sessionSnap.accentColor) {
          fetch(`/api/sessions/${encodeURIComponent(data.terminalId)}/accent-color`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ color: sessionSnap.accentColor }),
          }).catch(() => {});
        }
        if (sessionSnap.characterModel) {
          fetch(`/api/sessions/${encodeURIComponent(data.terminalId)}/character-model`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: sessionSnap.characterModel }),
          }).catch(() => {});
        }
        if (sessionSnap.pinned) {
          fetch(`/api/sessions/${encodeURIComponent(data.terminalId)}/pinned`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned: true }),
          }).catch(() => {});
        }
        if (sessionSnap.muted) {
          fetch(`/api/sessions/${encodeURIComponent(data.terminalId)}/muted`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ muted: true }),
          }).catch(() => {});
        }
        if (sessionSnap.alerted) {
          fetch(`/api/sessions/${encodeURIComponent(data.terminalId)}/alerted`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alerted: true }),
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

        // Restore file tabs (open files within each project sub-tab)
        if (sessionSnap.fileTabs) {
          for (const [subTabId, fileTabData] of Object.entries(sessionSnap.fileTabs)) {
            try {
              localStorage.setItem(
                `agent-manager:file-tabs:${data.terminalId}:${subTabId}`,
                JSON.stringify(fileTabData),
              );
            } catch { /* ignore */ }
          }
        }
      } else {
        failed++;
        processedCount++;
        callbacks.onProgress?.(processedCount, total, sessionSnap.title);
      }
    } catch {
      failed++;
      processedCount++;
      callbacks.onProgress?.(processedCount, total, sessionSnap.title);
    }
  }

  // Add dropped (deduplicated) session IDs to idRemap, pointing them to the canonical
  // session's new terminal ID. This ensures rooms that referenced a dropped duplicate
  // session are still remapped correctly.
  for (const [droppedId, canonicalId] of canonicalMap) {
    const newId = idRemap.get(canonicalId);
    if (newId) idRemap.set(droppedId, newId);
  }

  // Restore rooms with remapped session IDs.
  // Prefer snapshot rooms as the authoritative source — they contain originalSessionId
  // values that are in idRemap. localStorage rooms may contain stale IDs from a
  // previous session that won't remap correctly (e.g. after server snapshot loss).
  // Merge in any localStorage-only rooms (rooms not present in the snapshot) to
  // preserve hook-only session assignments.
  if (idRemap.size > 0) {
    try {
      let baseRooms: Room[] = snapshot.rooms ?? [];

      // Merge localStorage rooms that aren't in the snapshot (by room ID)
      try {
        const raw = localStorage.getItem('session-rooms');
        if (raw) {
          const parsed = JSON.parse(raw) as Room[];
          if (Array.isArray(parsed)) {
            const snapshotRoomIds = new Set(baseRooms.map((r) => r.id));
            const extraRooms = parsed.filter((r) => !snapshotRoomIds.has(r.id));
            if (extraRooms.length > 0) {
              baseRooms = [...baseRooms, ...extraRooms];
            }
          }
        }
      } catch { /* ignore parse errors */ }

      const remappedRooms = baseRooms.map((r) => ({
        ...r,
        sessionIds: [...new Set(r.sessionIds.map((id) => idRemap.get(id) ?? id))],
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

/**
 * Immediately flush a workspace save (no debounce).
 * Used when the app is about to close and we need to save right now.
 */
export async function flushSave(
  getSessions: () => Map<string, Session>,
  getRooms: () => Room[],
): Promise<void> {
  cancelAutoSave();
  const sessions = getSessions();
  const rooms = getRooms();
  const hasExportable = Array.from(sessions.values()).some((s) => !!s.sshConfig);
  if (!hasExportable) return;
  const snapshot = buildSnapshot(sessions, rooms);
  await saveToConfig(snapshot);
}

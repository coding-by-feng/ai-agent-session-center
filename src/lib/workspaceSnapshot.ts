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

export interface SessionSnapshot {
  title: string;
  label?: string;
  accentColor?: string;
  characterModel?: string;
  pinned?: boolean;
  enableOpsTerminal: boolean;
  sshConfig: SshConfig;
  projectTabs: { tabs: unknown[]; active: string } | null;
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

function getProjectTabs(sessionId: string): { tabs: unknown[]; active: string } | null {
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

  for (const [_id, session] of sessions) {
    // Only export sessions that have SSH config (can be recreated)
    if (!session.sshConfig) continue;
    // Skip ended sessions without reconnect info
    if (session.status === 'ended' && !session.sshConfig) continue;

    sessionSnapshots.push({
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

  return {
    version: 1,
    exportedAt: Date.now(),
    sessions: sessionSnapshots,
    rooms: rooms.map((r) => ({ ...r })),
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

  for (const sessionSnap of snapshot.sessions) {
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

  // Restore rooms — remap session IDs not possible (new IDs), but restore room structure
  if (snapshot.rooms && snapshot.rooms.length > 0) {
    try {
      localStorage.setItem('session-rooms', JSON.stringify(
        snapshot.rooms.map((r) => ({ ...r, sessionIds: [] })),
      ));
    } catch { /* ignore */ }
  }

  callbacks.onComplete(created, failed);
}

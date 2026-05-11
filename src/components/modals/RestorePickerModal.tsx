/**
 * RestorePickerModal — on AASC restart, presents a list of saved sessions
 * (grouped by room) and lets the user pick which to resume.
 *
 * Architecture:
 *   - `requestRestoreSelection(snapshot)` is the entry point. It returns a
 *     promise that resolves to a PickerResult once the user clicks one of the
 *     bottom buttons. The auto-load hook awaits this promise.
 *   - The modal subscribes to a module-level listener set (same pattern as
 *     reportWorkspaceLoadErrors in WorkspaceLoadingOverlay) so we don't have to
 *     stash a Promise resolver inside Zustand state.
 *   - Auto-resume preference + remembered selection live in localStorage.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkspaceSnapshot, SessionSnapshot } from '@/lib/workspaceSnapshot';
import type { Room } from '@/stores/roomStore';
import styles from '@/styles/modules/RestorePickerModal.module.css';

export interface PickerResult {
  /** null = restore everything (legacy behavior). Set = filter by originalSessionId. */
  selectedIds: Set<string> | null;
  /** Cancel — restore nothing this session, keep snapshot intact. */
  cancelled: boolean;
}

const LS_AUTO_RESUME_ALL = 'restore-picker:auto-resume-all';
const LS_LAST_SELECTION = 'restore-picker:last-selection';

export function getAutoResumeAll(): boolean {
  try { return localStorage.getItem(LS_AUTO_RESUME_ALL) === '1'; } catch { return false; }
}
function setAutoResumeAll(v: boolean): void {
  try { localStorage.setItem(LS_AUTO_RESUME_ALL, v ? '1' : '0'); } catch { /* ignore */ }
}
function loadLastSelection(): Set<string> | null {
  try {
    const raw = localStorage.getItem(LS_LAST_SELECTION);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === 'string'));
  } catch { /* ignore */ }
  return null;
}
function saveLastSelection(ids: Set<string>): void {
  try { localStorage.setItem(LS_LAST_SELECTION, JSON.stringify([...ids])); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Module-level resolver — modal subscribes via listener, entry point sets it.
// ---------------------------------------------------------------------------
type OpenListener = (snapshot: WorkspaceSnapshot) => void;
const listeners = new Set<OpenListener>();
let pendingResolve: ((result: PickerResult) => void) | null = null;

export function requestRestoreSelection(snapshot: WorkspaceSnapshot): Promise<PickerResult> {
  return new Promise((resolve) => {
    pendingResolve = resolve;
    for (const l of listeners) l(snapshot);
  });
}

function resolveAndClose(result: PickerResult): void {
  const r = pendingResolve;
  pendingResolve = null;
  if (r) r(result);
}

// ---------------------------------------------------------------------------
// Helpers — derive per-session warnings, no server calls needed.
// ---------------------------------------------------------------------------
function looksLikeRealSessionId(id: string | undefined): boolean {
  if (!id) return false;
  return !id.startsWith('term-') && /^[a-zA-Z0-9_-]+$/.test(id);
}
function isForkCommand(cmd: string | undefined): boolean {
  return !!cmd && /--fork-session\b/.test(cmd);
}
function shortPath(p: string | undefined): string {
  if (!p) return '~';
  return p.replace(/^\/Users\/[^/]+/, '~');
}
function timeAgo(epoch: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - epoch) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)} minute${sec < 120 ? '' : 's'} ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} hour${sec < 7200 ? '' : 's'} ago`;
  return `${Math.floor(sec / 86_400)} day${sec < 172_800 ? '' : 's'} ago`;
}

// Read localStorage rooms so empty rooms (sessionIds:[]) and the user's full
// room set are visible even if the snapshot's rooms array is sparse.
function loadLocalRooms(): Room[] {
  try {
    const raw = localStorage.getItem('session-rooms');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Room[];
    }
  } catch { /* ignore */ }
  return [];
}

interface Group {
  key: string;
  name: string;
  sessions: SessionSnapshot[];
}

function buildGroups(snapshot: WorkspaceSnapshot): Group[] {
  const sessions = snapshot.sessions;
  const byId = new Map<string, SessionSnapshot>();
  for (const s of sessions) byId.set(s.originalSessionId, s);

  // Combine snapshot rooms with localStorage rooms (snapshot takes precedence).
  const snapshotRooms = snapshot.rooms ?? [];
  const localRooms = loadLocalRooms();
  const seen = new Set(snapshotRooms.map((r) => r.id));
  const allRooms = [...snapshotRooms, ...localRooms.filter((r) => !seen.has(r.id))];

  const claimed = new Set<string>();
  const groups: Group[] = [];

  for (const room of allRooms) {
    const inRoom = room.sessionIds
      .map((id) => byId.get(id))
      .filter((s): s is SessionSnapshot => !!s);
    inRoom.forEach((s) => claimed.add(s.originalSessionId));
    // Skip empty rooms unless the room was in the snapshot itself — empty
    // rooms in the snapshot are intentional shells the user wants to keep.
    if (inRoom.length === 0 && !seen.has(room.id)) continue;
    groups.push({ key: room.id, name: room.name, sessions: inRoom });
  }

  const ungrouped = sessions.filter((s) => !claimed.has(s.originalSessionId));
  if (ungrouped.length > 0) {
    groups.push({ key: '__ungrouped__', name: 'Ungrouped', sessions: ungrouped });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function RestorePickerModal() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [dontAsk, setDontAsk] = useState(false);

  useEffect(() => {
    const handler: OpenListener = (snap) => {
      setSnapshot(snap);
      const last = loadLastSelection();
      // If we have a remembered selection, intersect with current snapshot IDs.
      // Otherwise default to all selected.
      const currentIds = new Set(snap.sessions.map((s) => s.originalSessionId));
      if (last) {
        const intersection = new Set([...last].filter((id) => currentIds.has(id)));
        // If the remembered set had nothing in common (e.g. fully new
        // workspace) fall back to all-checked rather than zero.
        setSelected(intersection.size > 0 ? intersection : currentIds);
      } else {
        setSelected(currentIds);
      }
      setSearch('');
      setDontAsk(false);
    };
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  const groups = useMemo(() => (snapshot ? buildGroups(snapshot) : []), [snapshot]);
  const totalSessions = snapshot?.sessions.length ?? 0;

  // Filter visible sessions by search query (matches title + workingDir).
  const filteredGroups = useMemo(() => {
    if (!search.trim()) return groups;
    const q = search.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        sessions: g.sessions.filter(
          (s) =>
            (s.title || '').toLowerCase().includes(q) ||
            (s.sshConfig?.workingDir || '').toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.sessions.length > 0);
  }, [groups, search]);

  // Warning aggregates for the bottom strip.
  const warnings = useMemo(() => {
    if (!snapshot) return { freshCount: 0, forkCount: 0, freshTitles: [] as string[], forkTitles: [] as string[] };
    const freshTitles: string[] = [];
    const forkTitles: string[] = [];
    for (const s of snapshot.sessions) {
      if (!selected.has(s.originalSessionId)) continue;
      if (!looksLikeRealSessionId(s.originalSessionId)) freshTitles.push(s.title || s.originalSessionId);
      if (isForkCommand(s.sshConfig?.command)) forkTitles.push(s.title || s.originalSessionId);
    }
    return {
      freshCount: freshTitles.length,
      forkCount: forkTitles.length,
      freshTitles,
      forkTitles,
    };
  }, [snapshot, selected]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (!snapshot) return;
    setSelected(new Set(snapshot.sessions.map((s) => s.originalSessionId)));
  }, [snapshot]);

  const selectNone = useCallback(() => {
    setSelected(new Set());
  }, []);

  const selectPinned = useCallback(() => {
    if (!snapshot) return;
    setSelected(new Set(snapshot.sessions.filter((s) => s.pinned).map((s) => s.originalSessionId)));
  }, [snapshot]);

  const finish = useCallback(
    (action: 'all' | 'selected' | 'none') => {
      if (!snapshot) return;
      let result: PickerResult;
      if (action === 'all') {
        const all = new Set(snapshot.sessions.map((s) => s.originalSessionId));
        saveLastSelection(all);
        result = { selectedIds: null, cancelled: false };
      } else if (action === 'selected') {
        saveLastSelection(selected);
        result = { selectedIds: new Set(selected), cancelled: false };
      } else {
        // Cancel — don't overwrite remembered selection.
        result = { selectedIds: null, cancelled: true };
      }
      if (dontAsk && action !== 'none') setAutoResumeAll(true);
      setSnapshot(null);
      resolveAndClose(result);
    },
    [snapshot, selected, dontAsk],
  );

  // Escape = cancel; Enter = resume selected.
  useEffect(() => {
    if (!snapshot) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish('none');
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        finish('selected');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snapshot, finish]);

  if (!snapshot) return null;

  const visibleCount = filteredGroups.reduce((n, g) => n + g.sessions.length, 0);

  return (
    <div className={styles.overlay} role="dialog" aria-label="Restore workspace">
      <div className={styles.panel}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>RESUME WORKSPACE</div>
            <div className={styles.subtitle}>
              {totalSessions} saved session{totalSessions === 1 ? '' : 's'}
              {' · Last saved: '}{timeAgo(snapshot.exportedAt)}
            </div>
          </div>
          <button
            type="button"
            className={styles.skipBtn}
            onClick={() => finish('none')}
            title="Restore nothing (Esc)"
          >
            ✕ Skip
          </button>
        </div>

        <div className={styles.toolbar}>
          <input
            type="text"
            className={styles.search}
            placeholder="Search title or workdir…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <button type="button" className={styles.toolBtn} onClick={selectAll}>All</button>
          <button type="button" className={styles.toolBtn} onClick={selectNone}>None</button>
          <button type="button" className={styles.toolBtn} onClick={selectPinned}>★ Pinned</button>
        </div>

        <div className={styles.list}>
          {filteredGroups.length === 0 ? (
            <div className={styles.empty}>No sessions match.</div>
          ) : (
            filteredGroups.map((g) => {
              const groupSelected = g.sessions.filter((s) => selected.has(s.originalSessionId)).length;
              return (
                <div key={g.key} className={styles.group}>
                  <div className={styles.groupHeader}>
                    <span className={styles.groupName}>{g.name}</span>
                    <span className={styles.groupCount}>
                      ({groupSelected}/{g.sessions.length})
                    </span>
                  </div>
                  {g.sessions.length === 0 ? (
                    <div className={styles.groupEmpty}>(empty room — restored without sessions)</div>
                  ) : (
                    g.sessions.map((s) => {
                      const id = s.originalSessionId;
                      const checked = selected.has(id);
                      const fresh = !looksLikeRealSessionId(id);
                      const fork = isForkCommand(s.sshConfig?.command);
                      return (
                        <label key={id} className={`${styles.row} ${checked ? styles.rowOn : ''}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(id)}
                          />
                          {s.pinned && <span className={styles.pinned} title="Pinned">★</span>}
                          <span className={styles.rowTitle}>{s.title || '(untitled)'}</span>
                          <span className={styles.rowCmd} title={s.sshConfig?.command || ''}>
                            {s.sshConfig?.command || ''}
                          </span>
                          <span className={styles.rowDir} title={s.sshConfig?.workingDir || ''}>
                            {shortPath(s.sshConfig?.workingDir)}
                          </span>
                          {fresh && (
                            <span className={`${styles.badge} ${styles.badgeWarn}`} title="Will start a fresh conversation">
                              ⚠ new
                            </span>
                          )}
                          {fork && (
                            <span className={`${styles.badge} ${styles.badgeFork}`} title="Fork session — risk re-forking from ancestor">
                              ⚠ fork
                            </span>
                          )}
                        </label>
                      );
                    })
                  )}
                </div>
              );
            })
          )}
        </div>

        {(warnings.freshCount > 0 || warnings.forkCount > 0) && (
          <div className={styles.warnStrip}>
            <div className={styles.warnTitle}>⚠ Conversation continuity</div>
            {warnings.freshCount > 0 && (
              <div className={styles.warnLine}>
                • {warnings.freshCount} session{warnings.freshCount === 1 ? '' : 's'} will start a fresh conversation
                {warnings.freshTitles.length > 0 && ` (${warnings.freshTitles.slice(0, 3).join(', ')}${warnings.freshTitles.length > 3 ? '…' : ''})`}
              </div>
            )}
            {warnings.forkCount > 0 && (
              <div className={styles.warnLine}>
                • {warnings.forkCount} fork session{warnings.forkCount === 1 ? '' : 's'} — risk losing post-fork history
                {warnings.forkTitles.length > 0 && ` (${warnings.forkTitles.slice(0, 3).join(', ')}${warnings.forkTitles.length > 3 ? '…' : ''})`}
              </div>
            )}
          </div>
        )}

        <label className={styles.rememberRow}>
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
          />
          <span>Don't ask again — auto-resume on every restart</span>
        </label>

        <div className={styles.footer}>
          <button
            type="button"
            className={styles.btnGhost}
            onClick={() => finish('none')}
          >
            Resume nothing
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={() => finish('selected')}
            disabled={selected.size === 0}
            title="⌘/Ctrl+Enter"
          >
            Resume selected ({selected.size}/{visibleCount})
          </button>
          <button
            type="button"
            className={styles.btnAll}
            onClick={() => finish('all')}
          >
            Resume all ({totalSessions})
          </button>
        </div>
      </div>
    </div>
  );
}

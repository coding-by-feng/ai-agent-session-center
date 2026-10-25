/**
 * Carry the docked PROJECT tab's open file into the detached Project window.
 *
 * The docked tab already persists its state (ProjectTabContainer → active
 * sub-tab, ProjectTab → that sub-tab's active file), so the Detach button reads
 * it back from there instead of threading a new store through. A pop-out that
 * is already open never reloads (Electron just focuses it), so the file reaches
 * it over a same-origin BroadcastChannel.
 */

export const PROJECT_POPOUT_CHANNEL = 'aasc-project-popout';

export interface ProjectPopoutOpenFile {
  projectPath: string;
  file: string;
}

const norm = (p: string) => p.replace(/\/+$/, '');

function readJson(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The file open in the docked PROJECT tab of `sessionId`, or undefined when
 *  no file is open or the active sub-tab browses a different project. */
export function activeProjectFile(sessionId: string | undefined, projectPath: string): string | undefined {
  if (!sessionId) return undefined;
  const container = readJson(`agent-manager:project-tabs:session:${sessionId}`);
  // No saved sub-tabs yet means the container is on its 'default' tab.
  const subTabId = typeof container?.active === 'string' ? container.active : 'default';
  const subTabs = Array.isArray(container?.tabs) ? container.tabs : [];
  const subTab = subTabs.find(
    (t): t is { id: string; projectPath?: unknown } => !!t && typeof t === 'object' && (t as { id?: unknown }).id === subTabId,
  );
  if (subTab && typeof subTab.projectPath === 'string' && norm(subTab.projectPath) !== norm(projectPath)) return undefined;

  const fileTabs = readJson(`agent-manager:file-tabs:${sessionId}:${subTabId}`);
  const active = fileTabs?.active;
  if (typeof active !== 'string' || !active) return undefined;
  const tabs = Array.isArray(fileTabs?.tabs) ? fileTabs.tabs : [];
  // A stale `active` (its tab was closed) is not an open file.
  return tabs.some((t) => !!t && typeof t === 'object' && (t as { path?: unknown }).path === active) ? active : undefined;
}

/** Tell an already-open Project window for `projectPath` to show `file`. */
export function postOpenFile(msg: ProjectPopoutOpenFile): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const ch = new BroadcastChannel(PROJECT_POPOUT_CHANNEL);
  ch.postMessage(msg);
  ch.close();
}

/** Subscribe to open-file requests for `projectPath`. Returns the unsubscribe. */
export function onOpenFile(projectPath: string, handler: (file: string) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const ch = new BroadcastChannel(PROJECT_POPOUT_CHANNEL);
  ch.onmessage = (e: MessageEvent<unknown>) => {
    const d = e.data as Partial<ProjectPopoutOpenFile> | null;
    if (d && typeof d.file === 'string' && typeof d.projectPath === 'string' && norm(d.projectPath) === norm(projectPath)) {
      handler(d.file);
    }
  };
  return () => ch.close();
}

/**
 * ProjectTabContainer — manages sub-tabs within the PROJECT tab area.
 * Each sub-tab is an independent ProjectTab instance with its own navigation state.
 * Clicking the "Open project in new tab" icon in any ProjectTab toolbar opens
 * a new sub-tab here rather than a new browser window.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import ProjectTab from './ProjectTab';
import { useUiStore } from '@/stores/uiStore';
import styles from '@/styles/modules/ProjectTab.module.css';

interface SubTab {
  id: string;
  label: string;
  /** User-set name that persists until renamed again or tab is closed */
  customLabel?: string;
  projectPath: string;
  initialPath?: string;
  /** True if initialPath points to a file (not a directory) */
  initialIsFile?: boolean;
}

interface ProjectTabContainerProps {
  projectPath: string;
  /** Session ID — used to persist sub-tabs independently per session */
  sessionId?: string;
}

/** localStorage key for persisting sub-tab state per session (falls back to projectPath) */
function storageKey(projectPath: string, sessionId?: string): string {
  if (sessionId) return `agent-manager:project-tabs:session:${sessionId}`;
  return `agent-manager:project-tabs:${projectPath}`;
}

function loadPersistedTabs(projectPath: string, defaultLabel: string, sessionId?: string): { tabs: SubTab[]; active: string } {
  try {
    const raw = localStorage.getItem(storageKey(projectPath, sessionId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0 && typeof parsed.active === 'string') {
        return { tabs: parsed.tabs, active: parsed.active };
      }
    }
  } catch { /* ignore */ }
  return { tabs: [{ id: 'default', label: defaultLabel, projectPath }], active: 'default' };
}

export default function ProjectTabContainer({ projectPath, sessionId }: ProjectTabContainerProps) {
  const defaultLabel = projectPath.split('/').filter(Boolean).pop() || 'project';

  const [subTabs, setSubTabs] = useState<SubTab[]>(() =>
    loadPersistedTabs(projectPath, defaultLabel, sessionId).tabs,
  );
  const [activeSubTab, setActiveSubTab] = useState(() =>
    loadPersistedTabs(projectPath, defaultLabel, sessionId).active,
  );

  // File open requests from terminal (or elsewhere)
  const pendingFileOpen = useUiStore((s) => s.pendingFileOpen);
  const clearPendingFileOpen = useUiStore((s) => s.clearPendingFileOpen);
  const [navigateToFile, setNavigateToFile] = useState<string | null>(null);

  useEffect(() => {
    if (pendingFileOpen && (pendingFileOpen.projectPath === projectPath || !pendingFileOpen.projectPath)) {
      setNavigateToFile(pendingFileOpen.filePath);
      clearPendingFileOpen();
      // Clear after a tick so the prop change is picked up by ProjectTab
      const id = setTimeout(() => setNavigateToFile(null), 100);
      return () => clearTimeout(id);
    }
  }, [pendingFileOpen, projectPath, clearPendingFileOpen]);

  const handleOpenBrowserTab = useCallback((projPath: string, currentDir: string) => {
    // Use the deepest folder name from the current browsing path as the tab label
    const dirSegments = currentDir.split('/').filter(Boolean);
    const label = dirSegments.length > 0
      ? dirSegments[dirSegments.length - 1]
      : projPath.split('/').filter(Boolean).pop() || 'project';
    const tabId = `sub-${Date.now()}`;
    setSubTabs((prev) => [...prev, {
      id: tabId,
      label,
      projectPath: projPath,
      initialPath: currentDir,
    }]);
    setActiveSubTab(tabId);
  }, []);

  const handleCloseSubTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSubTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) {
        // Last tab closed — recreate a fresh default tab at project root
        const fresh: SubTab = { id: `sub-${Date.now()}`, label: defaultLabel, projectPath };
        setActiveSubTab(fresh.id);
        return [fresh];
      }
      if (activeSubTab === tabId) {
        setActiveSubTab(next[next.length - 1].id);
      }
      return next;
    });
  }, [activeSubTab, defaultLabel, projectPath]);

  const handlePathChange = useCallback((tabId: string, currentPath: string, isFile: boolean) => {
    // Derive label from the deepest segment; for files use the file name, for dirs the folder name
    const segments = currentPath.split('/').filter(Boolean);
    const baseName = segments.length > 0
      ? segments[segments.length - 1]
      : projectPath.split('/').filter(Boolean).pop() || 'project';
    setSubTabs((prev) => {
      // If another tab already has the same baseName, disambiguate by prepending the parent dir
      const conflict = prev.some((t) => t.id !== tabId && !t.customLabel && t.label === baseName);
      const label = conflict && segments.length >= 2
        ? `${segments[segments.length - 2]}/${baseName}`
        : baseName;
      // Also fix the conflicting tab's label to include its parent dir
      return prev.map((t) => {
        if (t.id === tabId) {
          return { ...t, ...(!t.customLabel ? { label } : {}), initialPath: currentPath, initialIsFile: isFile };
        }
        if (!t.customLabel && t.label === baseName && t.initialPath) {
          const otherSegs = t.initialPath.split('/').filter(Boolean);
          const disambig = otherSegs.length >= 2
            ? `${otherSegs[otherSegs.length - 2]}/${otherSegs[otherSegs.length - 1]}`
            : t.label;
          return { ...t, label: disambig };
        }
        return t;
      });
    });
  }, [projectPath]);

  // --- Rename state ---
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const startRename = useCallback((tab: SubTab, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingTabId(tab.id);
    setRenameValue(tab.customLabel || tab.label);
  }, []);

  const commitRename = useCallback(() => {
    if (!renamingTabId) return;
    const trimmed = renameValue.trim();
    if (trimmed) {
      setSubTabs((prev) => prev.map((t) =>
        t.id === renamingTabId ? { ...t, customLabel: trimmed } : t,
      ));
    }
    setRenamingTabId(null);
  }, [renamingTabId, renameValue]);

  const cancelRename = useCallback(() => {
    setRenamingTabId(null);
  }, []);

  // Focus the rename input when it appears
  useEffect(() => {
    if (renamingTabId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingTabId]);

  // Persist sub-tab state to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(projectPath, sessionId), JSON.stringify({ tabs: subTabs, active: activeSubTab }));
    } catch { /* ignore */ }
  }, [subTabs, activeSubTab, projectPath, sessionId]);

  // Only show the sub-tab bar when there are multiple tabs
  const showSubTabs = subTabs.length > 1;

  return (
    <div className={styles.subTabContainer}>
      {showSubTabs && (
        <div className={styles.subTabBar}>
          {subTabs.map((tab) => (
            <button
              key={tab.id}
              className={`${styles.subTab} ${activeSubTab === tab.id ? styles.subTabActive : ''}`}
              onClick={() => setActiveSubTab(tab.id)}
              onDoubleClick={(e) => startRename(tab, e)}
              title="Double-click to rename"
            >
              {renamingTabId === tab.id ? (
                <input
                  ref={renameInputRef}
                  className={styles.subTabRenameInput}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') cancelRename();
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className={styles.subTabLabel}>{tab.customLabel || tab.label}</span>
              )}
              <span
                className={styles.subTabClose}
                onClick={(e) => handleCloseSubTab(tab.id, e)}
                title="Close tab"
              >
                &times;
              </span>
            </button>
          ))}
        </div>
      )}
      <div className={styles.subTabContent}>
        {subTabs.map((tab) => (
          <div
            key={tab.id}
            className={styles.subTabPanel}
            style={{ display: activeSubTab === tab.id ? 'flex' : 'none' }}
          >
            <ProjectTab
              projectPath={tab.projectPath}
              initialPath={tab.initialPath}
              initialIsFile={tab.initialIsFile}
              navigateToFile={activeSubTab === tab.id ? navigateToFile : null}
              onOpenBrowserTab={handleOpenBrowserTab}
              onPathChange={(path, isFile) => handlePathChange(tab.id, path, isFile)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

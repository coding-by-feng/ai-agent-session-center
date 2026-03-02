/**
 * ProjectTabContainer — manages sub-tabs within the PROJECT tab area.
 * Each sub-tab is an independent ProjectTab instance with its own navigation state.
 * Clicking the "Open project in new tab" icon in any ProjectTab toolbar opens
 * a new sub-tab here rather than a new browser window.
 */
import { useState, useCallback, useEffect } from 'react';
import ProjectTab from './ProjectTab';
import { useUiStore } from '@/stores/uiStore';
import styles from '@/styles/modules/ProjectTab.module.css';

interface SubTab {
  id: string;
  label: string;
  projectPath: string;
  initialPath?: string;
  /** True if initialPath points to a file (not a directory) */
  initialIsFile?: boolean;
}

interface ProjectTabContainerProps {
  projectPath: string;
}

/** localStorage key for persisting sub-tab state per project */
function storageKey(projectPath: string): string {
  return `agent-manager:project-tabs:${projectPath}`;
}

function loadPersistedTabs(projectPath: string, defaultLabel: string): { tabs: SubTab[]; active: string } {
  try {
    const raw = localStorage.getItem(storageKey(projectPath));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0 && typeof parsed.active === 'string') {
        return { tabs: parsed.tabs, active: parsed.active };
      }
    }
  } catch { /* ignore */ }
  return { tabs: [{ id: 'default', label: defaultLabel, projectPath }], active: 'default' };
}

export default function ProjectTabContainer({ projectPath }: ProjectTabContainerProps) {
  const defaultLabel = projectPath.split('/').filter(Boolean).pop() || 'project';

  const [subTabs, setSubTabs] = useState<SubTab[]>(() =>
    loadPersistedTabs(projectPath, defaultLabel).tabs,
  );
  const [activeSubTab, setActiveSubTab] = useState(() =>
    loadPersistedTabs(projectPath, defaultLabel).active,
  );

  // File open requests from terminal (or elsewhere)
  const pendingFileOpen = useUiStore((s) => s.pendingFileOpen);
  const clearPendingFileOpen = useUiStore((s) => s.clearPendingFileOpen);
  const [navigateToFile, setNavigateToFile] = useState<string | null>(null);

  useEffect(() => {
    if (pendingFileOpen && pendingFileOpen.projectPath === projectPath) {
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
    const label = segments.length > 0
      ? segments[segments.length - 1]
      : projectPath.split('/').filter(Boolean).pop() || 'project';
    setSubTabs((prev) => prev.map((t) =>
      t.id === tabId ? { ...t, label, initialPath: currentPath, initialIsFile: isFile } : t,
    ));
  }, [projectPath]);

  // Persist sub-tab state to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(projectPath), JSON.stringify({ tabs: subTabs, active: activeSubTab }));
    } catch { /* ignore */ }
  }, [subTabs, activeSubTab, projectPath]);

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
            >
              <span className={styles.subTabLabel}>{tab.label}</span>
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

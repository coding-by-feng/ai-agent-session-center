/**
 * ProjectTabContainer — manages sub-tabs within the PROJECT tab area.
 * Each sub-tab is an independent ProjectTab instance with its own navigation state.
 * Clicking the "Open project in new tab" icon in any ProjectTab toolbar opens
 * a new sub-tab here rather than a new browser window.
 */
import { useState, useCallback } from 'react';
import ProjectTab from './ProjectTab';
import styles from '@/styles/modules/ProjectTab.module.css';

interface SubTab {
  id: string;
  label: string;
  projectPath: string;
}

interface ProjectTabContainerProps {
  projectPath: string;
}

export default function ProjectTabContainer({ projectPath }: ProjectTabContainerProps) {
  const defaultLabel = projectPath.split('/').filter(Boolean).pop() || 'project';

  const [subTabs, setSubTabs] = useState<SubTab[]>(() => [
    { id: 'default', label: defaultLabel, projectPath },
  ]);
  const [activeSubTab, setActiveSubTab] = useState('default');

  const handleOpenBrowserTab = useCallback((projPath: string) => {
    const name = projPath.split('/').filter(Boolean).pop() || projPath;
    const tabId = `sub-${Date.now()}`;
    setSubTabs((prev) => [...prev, { id: tabId, label: name, projectPath: projPath }]);
    setActiveSubTab(tabId);
  }, []);

  const handleCloseSubTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSubTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      // If closing the active tab, switch to the last remaining tab
      if (activeSubTab === tabId && next.length > 0) {
        setActiveSubTab(next[next.length - 1].id);
      }
      return next;
    });
  }, [activeSubTab]);

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
              {tab.id !== 'default' && (
                <span
                  className={styles.subTabClose}
                  onClick={(e) => handleCloseSubTab(tab.id, e)}
                  title="Close tab"
                >
                  &times;
                </span>
              )}
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
              onOpenBrowserTab={handleOpenBrowserTab}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

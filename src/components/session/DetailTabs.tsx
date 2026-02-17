/**
 * DetailTabs manages the tab bar and content switching for the detail panel.
 * Tabs: Terminal | Prompts | Notes | Activity | Summary
 * Ported from the tab switching logic in public/js/detailPanel.js.
 */
import { useState, useCallback, type ReactNode } from 'react';
import styles from '@/styles/modules/DetailPanel.module.css';

const STORAGE_KEY = 'active-tab';

interface DetailTabsProps {
  terminalContent: ReactNode;
  promptsContent: ReactNode;
  notesContent: ReactNode;
  activityContent: ReactNode;
  summaryContent: ReactNode;
  queueContent: ReactNode;
  onTabChange?: (tabId: string) => void;
}

const TABS = [
  { id: 'terminal', label: 'TERMINAL' },
  { id: 'conversation', label: 'PROMPTS' },
  { id: 'queue', label: 'QUEUE' },
  { id: 'notes', label: 'NOTES' },
  { id: 'activity', label: 'ACTIVITY' },
  { id: 'summary', label: 'SUMMARY' },
] as const;

export default function DetailTabs({
  terminalContent,
  promptsContent,
  notesContent,
  activityContent,
  summaryContent,
  queueContent,
  onTabChange,
}: DetailTabsProps) {
  const [activeTab, setActiveTab] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'terminal';
    } catch {
      return 'terminal';
    }
  });

  const handleTabClick = useCallback(
    (tabId: string) => {
      setActiveTab(tabId);
      try {
        localStorage.setItem(STORAGE_KEY, tabId);
      } catch {
        // ignore
      }
      onTabChange?.(tabId);
    },
    [onTabChange],
  );

  const contentMap: Record<string, ReactNode> = {
    terminal: terminalContent,
    conversation: promptsContent,
    queue: queueContent,
    notes: notesContent,
    activity: activityContent,
    summary: summaryContent,
  };

  return (
    <>
      <div className={styles.tabs}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`${styles.tab}${activeTab === tab.id ? ` ${styles.active}` : ''}`}
            onClick={() => handleTabClick(tab.id)}
            data-tab={tab.id}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {TABS.map((tab) => (
        <div
          key={tab.id}
          className={`${styles.tabContent}${activeTab === tab.id ? ` ${styles.active}` : ''}`}
        >
          {contentMap[tab.id]}
        </div>
      ))}
    </>
  );
}

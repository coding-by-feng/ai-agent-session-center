/**
 * DetailTabs manages the tab bar and content switching for the detail panel.
 * Tabs: Terminal | Prompts | Notes | Activity | Summary
 *
 * Split-view: On wide screens the PROJECT tab has a merge icon that shows
 * Terminal (left) + Project (right) side-by-side with a draggable divider.
 */
import { useState, useCallback, useRef, type ReactNode } from 'react';
import styles from '@/styles/modules/DetailPanel.module.css';

const STORAGE_KEY = 'active-tab';
const SPLIT_KEY = 'split-terminal-project';
const SPLIT_RATIO_KEY = 'split-ratio';

/** Minimum panel width (px) at which the split icon is shown. */
const SPLIT_MIN_WIDTH = 700;

interface DetailTabsProps {
  terminalContent: ReactNode;
  promptsContent: ReactNode;
  notesContent: ReactNode;
  activityContent: ReactNode;
  summaryContent: ReactNode;
  queueContent: ReactNode;
  projectContent: ReactNode;
  onTabChange?: (tabId: string) => void;
}

const TABS = [
  { id: 'terminal', label: 'TERMINAL' },
  { id: 'conversation', label: 'PROMPTS' },
  { id: 'project', label: 'PROJECT' },
  { id: 'queue', label: 'QUEUE' },
  { id: 'notes', label: 'NOTES' },
  { id: 'activity', label: 'ACTIVITY' },
  { id: 'summary', label: 'SUMMARY' },
] as const;

// ---------------------------------------------------------------------------
// Split / merge SVG icons (inline to avoid extra asset files)
// ---------------------------------------------------------------------------

/** Two-columns icon – shown when tabs are separate; click to merge */
function MergeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8" y="1" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** Single-column icon – shown when merged; click to split back */
function SplitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="12" height="12" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 1.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Draggable split view
// ---------------------------------------------------------------------------

function DraggableSplitView({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(SPLIT_RATIO_KEY);
      return stored ? parseFloat(stored) : 0.5;
    } catch {
      return 0.5;
    }
  });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const startX = e.clientX;
    const startRatio = ratio;
    const containerWidth = container.offsetWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newRatio = Math.max(0.15, Math.min(0.85, startRatio + delta / containerWidth));
      setRatio(newRatio);
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Persist ratio
      try {
        localStorage.setItem(SPLIT_RATIO_KEY, String(ratio));
      } catch { /* ignore */ }
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [ratio]);

  return (
    <div className={styles.splitView} ref={containerRef}>
      <div className={styles.splitLeft} style={{ flex: `0 0 ${ratio * 100}%` }}>
        {left}
      </div>
      <div
        className={styles.splitDivider}
        onMouseDown={handleMouseDown}
      />
      <div className={styles.splitRight} style={{ flex: 1 }}>
        {right}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function DetailTabs({
  terminalContent,
  promptsContent,
  notesContent,
  activityContent,
  summaryContent,
  queueContent,
  projectContent,
  onTabChange,
}: DetailTabsProps) {
  const [activeTab, setActiveTab] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'terminal';
    } catch {
      return 'terminal';
    }
  });

  const [splitView, setSplitView] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SPLIT_KEY) === '1';
    } catch {
      return false;
    }
  });

  // Only offer split on wide panels (uses CSS too, but this prevents stale state)
  const panelWideEnough =
    typeof window !== 'undefined' && window.innerWidth >= SPLIT_MIN_WIDTH;

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

  const toggleSplit = useCallback(() => {
    setSplitView((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SPLIT_KEY, next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const isSplit = splitView && panelWideEnough;

  // When split-view is active on the project or terminal tab, show the
  // combined view instead of the individual tab content.
  const effectiveTab =
    isSplit && (activeTab === 'terminal' || activeTab === 'project')
      ? 'split'
      : activeTab;

  const contentMap: Record<string, ReactNode> = {
    terminal: terminalContent,
    conversation: promptsContent,
    project: projectContent,
    queue: queueContent,
    notes: notesContent,
    activity: activityContent,
    summary: summaryContent,
    split: (
      <DraggableSplitView
        left={terminalContent}
        right={projectContent}
      />
    ),
  };

  return (
    <>
      <div className={styles.tabs}>
        {TABS.map((tab) => {
          const isActive =
            isSplit && (tab.id === 'terminal' || tab.id === 'project')
              ? activeTab === 'terminal' || activeTab === 'project'
              : activeTab === tab.id;

          return (
            <button
              key={tab.id}
              className={`${styles.tab}${isActive ? ` ${styles.active}` : ''}${
                isSplit && (tab.id === 'terminal' || tab.id === 'project')
                  ? ` ${styles.tabSplit}`
                  : ''
              }`}
              onClick={() => handleTabClick(tab.id)}
              data-tab={tab.id}
            >
              {tab.label}
              {/* Show merge/split toggle icon on PROJECT tab (wide screens only) */}
              {tab.id === 'project' && panelWideEnough && (
                <span
                  className={styles.splitToggle}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSplit();
                    // If activating split and not on terminal/project, jump to project
                    if (!splitView && activeTab !== 'terminal' && activeTab !== 'project') {
                      handleTabClick('project');
                    }
                  }}
                  title={splitView ? 'Separate tabs' : 'Merge Terminal + Project'}
                >
                  {splitView ? <SplitIcon /> : <MergeIcon />}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {/* #15: Only mount the active tab content */}
      <div className={styles.tabContent}>
        {contentMap[effectiveTab]}
      </div>
    </>
  );
}

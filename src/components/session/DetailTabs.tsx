/**
 * DetailTabs manages the tab bar and content switching for the detail panel.
 * Tabs: Project | Terminal | Commands | Prompts | Notes | Queue
 *
 * Split-view: On wide screens the PROJECT tab has a merge icon that shows
 * Terminal (left) + Project (right) side-by-side with a draggable divider.
 */
import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from '@/styles/modules/DetailPanel.module.css';
import FloatingProjectPanel from './FloatingProjectPanel';
import Tooltip from '@/components/ui/Tooltip';
import { tooltips } from '@/lib/tooltips';

const STORAGE_KEY = 'active-tab';
const SPLIT_KEY = 'split-terminal-project';
const SPLIT_RATIO_KEY = 'split-ratio';
const FLOAT_KEY = 'float-project';

/** Minimum panel width (px) at which the split icon is shown. */
const SPLIT_MIN_WIDTH = 700;

interface DetailTabsProps {
  terminalContent: ReactNode;
  promptsContent: ReactNode;
  notesContent: ReactNode;
  queueContent: ReactNode;
  projectContent: ReactNode;
  commandsContent?: ReactNode;
  onTabChange?: (tabId: string) => void;
  /** Session ID used to persist split-ratio per session */
  sessionId?: string;
  /** When set, programmatically switches to this tab */
  externalActiveTab?: string | null;
  /** Search bar props */
  searchQuery?: string;
  searchOpen?: boolean;
  searchMatchCount?: number;
  searchMatchIndex?: number;
  onSearchChange?: (query: string) => void;
  onSearchClose?: () => void;
  onSearchPrev?: () => void;
  onSearchNext?: () => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
}

const BASE_TABS = [
  { id: 'project', label: 'PROJECT' },
  { id: 'terminal', label: 'TERMINAL' },
  { id: 'commands', label: 'COMMANDS' },
  { id: 'conversation', label: 'PROMPTS' },
  { id: 'notes', label: 'NOTES' },
  { id: 'queue', label: 'QUEUE' },
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

/** Picture-in-picture icon – click to float Project panel over Terminal */
function FloatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="12" height="12" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="6.5" y="6.5" width="6" height="5" rx="0.5" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Draggable split view
// ---------------------------------------------------------------------------

function DraggableSplitView({
  left,
  right,
  ratioKey,
}: {
  left: ReactNode;
  right: ReactNode;
  /** localStorage key for persisting the split ratio */
  ratioKey: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ratioKeyRef = useRef(ratioKey);
  ratioKeyRef.current = ratioKey;

  const [ratio, setRatio] = useState<number>(() => {
    try {
      // Try session-specific key first, then fall back to global
      const stored = localStorage.getItem(ratioKey) ?? localStorage.getItem(SPLIT_RATIO_KEY);
      return stored ? parseFloat(stored) : 0.5;
    } catch {
      return 0.5;
    }
  });

  // Restore ratio when the session (ratioKey) changes
  useEffect(() => {
    try {
      const stored = localStorage.getItem(ratioKey);
      setRatio(stored ? parseFloat(stored) : 0.5);
    } catch { /* ignore */ }
  }, [ratioKey]);

  // Track latest ratio in a ref so onMouseUp always reads the current value
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const startX = e.clientX;
    const startRatio = ratioRef.current;
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
      // Persist ratio (both session-specific and global fallback)
      const finalRatio = ratioRef.current;
      try {
        localStorage.setItem(ratioKeyRef.current, String(finalRatio));
        localStorage.setItem(SPLIT_RATIO_KEY, String(finalRatio));
      } catch { /* ignore */ }
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

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
  queueContent,
  projectContent,
  commandsContent,
  onTabChange,
  sessionId,
  externalActiveTab,
  searchQuery,
  searchOpen,
  searchMatchCount,
  searchMatchIndex,
  onSearchChange,
  onSearchClose,
  onSearchPrev,
  onSearchNext,
  searchInputRef,
}: DetailTabsProps) {
  const [activeTab, setActiveTab] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'terminal';
    } catch {
      return 'terminal';
    }
  });

  // Allow external callers to switch tabs programmatically
  useEffect(() => {
    if (externalActiveTab) {
      setActiveTab(externalActiveTab);
      try { localStorage.setItem(STORAGE_KEY, externalActiveTab); } catch { /* ignore */ }
    }
  }, [externalActiveTab]);

  const [splitView, setSplitView] = useState<boolean>(() => {
    try {
      // Per-session key first, then global fallback
      const key = sessionId ? `${SPLIT_KEY}:${sessionId}` : SPLIT_KEY;
      const stored = localStorage.getItem(key);
      if (stored !== null) return stored === '1';
      return localStorage.getItem(SPLIT_KEY) === '1';
    } catch {
      return false;
    }
  });

  const [floatProject, setFloatProject] = useState<boolean>(() => {
    try {
      const key = sessionId ? `${FLOAT_KEY}:${sessionId}` : FLOAT_KEY;
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });

  // Restore per-session split state when switching sessions.
  // If the session has no stored preference, default to off so the previous
  // session's state doesn't leak.
  useEffect(() => {
    if (!sessionId) return;
    try {
      const key = `${SPLIT_KEY}:${sessionId}`;
      const stored = localStorage.getItem(key);
      setSplitView(stored === '1');
    } catch { /* ignore */ }
  }, [sessionId]);

  // Restore per-session float state when switching sessions.
  useEffect(() => {
    if (!sessionId) return;
    try {
      const key = `${FLOAT_KEY}:${sessionId}`;
      setFloatProject(localStorage.getItem(key) === '1');
    } catch { /* ignore */ }
  }, [sessionId]);

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
        if (sessionId) {
          localStorage.setItem(`${SPLIT_KEY}:${sessionId}`, next ? '1' : '0');
        }
      } catch { /* ignore */ }
      return next;
    });
    // Mutual exclusivity: turning split on disables float.
    setFloatProject((prev) => {
      if (!prev) return prev;
      try {
        if (sessionId) localStorage.setItem(`${FLOAT_KEY}:${sessionId}`, '0');
      } catch { /* ignore */ }
      return false;
    });
  }, [sessionId]);

  const toggleFloat = useCallback(() => {
    setFloatProject((prev) => {
      const next = !prev;
      try {
        if (sessionId) localStorage.setItem(`${FLOAT_KEY}:${sessionId}`, next ? '1' : '0');
      } catch { /* ignore */ }
      return next;
    });
    // Mutual exclusivity: turning float on disables split.
    setSplitView((prev) => {
      if (!prev) return prev;
      try {
        if (sessionId) localStorage.setItem(`${SPLIT_KEY}:${sessionId}`, '0');
      } catch { /* ignore */ }
      return false;
    });
  }, [sessionId]);

  const isSplit = splitView && panelWideEnough && !floatProject;
  const isFloat = floatProject && panelWideEnough;

  // When split-view is active on the project or terminal tab, show the
  // combined view instead of the individual tab content.
  // When float mode is active, redirect PROJECT tab → TERMINAL so the
  // terminal owns the screen while Project lives in the floating overlay.
  let effectiveTab: string;
  if (isSplit && (activeTab === 'terminal' || activeTab === 'project')) {
    effectiveTab = 'split';
  } else if (isFloat && activeTab === 'project') {
    effectiveTab = 'terminal';
  } else {
    effectiveTab = activeTab;
  }

  const tabs = BASE_TABS;

  // Float mode: portal projectContent between a stable always-mounted host and
  // the floating panel's body. createPortal preserves component state across
  // target swaps so the file tree, open files, and edit mode survive toggling.
  const [floatBodyEl, setFloatBodyEl] = useState<HTMLDivElement | null>(null);
  const [projectHostEl, setProjectHostEl] = useState<HTMLDivElement | null>(null);
  const setFloatBodyRef = useCallback((el: HTMLDivElement | null) => {
    setFloatBodyEl(el);
  }, []);
  const setProjectHostRef = useCallback((el: HTMLDivElement | null) => {
    setProjectHostEl(el);
  }, []);

  // Each scrollable tab gets a unique key so React creates a separate DOM node per tab.
  // Without this, all text tabs share the same div.tabScroll DOM node, meaning scroll
  // position bleeds across tabs (e.g. scrolled-down activity bleeds into conversation).
  // NOTE: terminal, commands, and project are NOT in this map — they're always-mounted above.
  // In split view, projectContent must NOT also be portaled into the float host;
  // when split is on, isFloat is false so the portal target is projectHostEl,
  // which is hidden by class — DraggableSplitView renders its own copy of projectContent.
  const contentMap: Record<string, ReactNode> = {
    conversation: <div key="scroll-conversation" className={styles.tabScroll}>{promptsContent}</div>,
    queue: <div key="scroll-queue" className={styles.tabScroll}>{queueContent}</div>,
    notes: <div key="scroll-notes" className={styles.tabScroll}>{notesContent}</div>,
    split: (
      <DraggableSplitView
        left={terminalContent}
        right={projectContent}
        ratioKey={sessionId ? `${SPLIT_RATIO_KEY}:${sessionId}` : SPLIT_RATIO_KEY}
      />
    ),
  };

  // Resolve the portal target for projectContent. Float-expanded → float body.
  // Otherwise → the always-mounted host (visible only when project tab is active).
  // Skipped during split view since DraggableSplitView renders projectContent inline.
  const portalTarget: HTMLDivElement | null =
    isFloat && floatBodyEl ? floatBodyEl : projectHostEl;
  const shouldPortalProject = !isSplit && portalTarget !== null;

  const hasMatches = (searchMatchCount ?? 0) > 0;
  const countLabel = searchQuery
    ? hasMatches
      ? `${(searchMatchIndex ?? 0) + 1}/${searchMatchCount}`
      : '0 results'
    : '';

  return (
    <>
      <div className={styles.tabs}>
        {tabs.map((tab) => {
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
              {/* Show merge/split + float toggle icons on PROJECT tab (wide screens only) */}
              {tab.id === 'project' && panelWideEnough && (
                <>
                  <Tooltip {...(splitView ? tooltips.splitProjectTerminal : tooltips.mergeProjectTerminal)}>
                    <span
                      className={styles.splitToggle}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSplit();
                        if (!splitView && activeTab !== 'terminal' && activeTab !== 'project') {
                          handleTabClick('project');
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={(splitView ? tooltips.splitProjectTerminal : tooltips.mergeProjectTerminal).label}
                    >
                      {splitView ? <SplitIcon /> : <MergeIcon />}
                    </span>
                  </Tooltip>
                  <Tooltip {...(floatProject ? tooltips.unfloatProject : tooltips.floatProject)}>
                    <span
                      className={styles.splitToggle}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFloat();
                        if (!floatProject && activeTab !== 'terminal') {
                          handleTabClick('terminal');
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={(floatProject ? tooltips.unfloatProject : tooltips.floatProject).label}
                    >
                      <FloatIcon />
                    </span>
                  </Tooltip>
                </>
              )}
            </button>
          );
        })}
      </div>
      {/* Search bar — appears between tabs and content */}
      <div className={`${styles.searchBar}${searchOpen ? '' : ` ${styles.hidden}`}`}>
        <span className={styles.searchIcon}>⌕</span>
        <input
          ref={searchInputRef}
          className={styles.searchInput}
          type="text"
          placeholder="Search session…"
          value={searchQuery ?? ''}
          onChange={(e) => onSearchChange?.(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); onSearchClose?.(); }
            if (e.key === 'Enter') { e.shiftKey ? onSearchPrev?.() : onSearchNext?.(); }
          }}
        />
        <span className={`${styles.searchCount}${hasMatches ? ` ${styles.hasMatches}` : ''}`}>
          {countLabel}
        </span>
        <Tooltip {...tooltips.searchPrev} disabled={!hasMatches}>
          <button className={styles.searchNavBtn} onClick={onSearchPrev} disabled={!hasMatches} aria-label={tooltips.searchPrev.label}>▲</button>
        </Tooltip>
        <Tooltip {...tooltips.searchNext} disabled={!hasMatches}>
          <button className={styles.searchNavBtn} onClick={onSearchNext} disabled={!hasMatches} aria-label={tooltips.searchNext.label}>▼</button>
        </Tooltip>
        <Tooltip {...tooltips.searchClose}>
          <button className={styles.searchCloseBtn} onClick={onSearchClose} aria-label={tooltips.searchClose.label}>✕</button>
        </Tooltip>
      </div>

      {/* Always-mount TERMINAL/COMMANDS (preserves xterm scroll) and PROJECT (preserves file state).
          Other tabs mount on demand. Hidden tabs use display:none to preserve DOM state. */}
      <div className={styles.tabContent}>
        {/* TERMINAL: always mounted to preserve xterm instance + scroll position.
            Unmounted during split view (split view renders its own terminal instance). */}
        <div className={
          effectiveTab === 'terminal' ? styles.alwaysTabActive : styles.alwaysTabHidden
        }>
          {/* Don't render terminal inside wrapper when split view is active
              to avoid duplicate xterm subscriptions */}
          {effectiveTab !== 'split' && terminalContent}
        </div>
        {/* COMMANDS (ops terminal): always mounted if exists */}
        {commandsContent && (
          <div className={
            effectiveTab === 'commands' ? styles.alwaysTabActive : styles.alwaysTabHidden
          }>
            {commandsContent}
          </div>
        )}
        {/* PROJECT: always mounted as an empty stable host. The actual
            projectContent is portaled into either this host or the floating
            panel's body, so file tree + open files + edit-mode state survive
            mode toggles. Hidden during split view (split renders its own copy)
            and during float mode (panel renders the visible copy). */}
        <div
          ref={setProjectHostRef}
          className={
            effectiveTab === 'project' && !isFloat
              ? styles.alwaysTabActive
              : styles.alwaysTabHidden
          }
        />
        {/* Floating Project panel — only rendered when float mode is active */}
        {isFloat && (
          <FloatingProjectPanel
            sessionId={sessionId}
            bodyRef={setFloatBodyRef}
            onClose={toggleFloat}
          />
        )}
        {/* Portal projectContent into the resolved host. Single fiber position
            preserves component state when the DOM target switches. */}
        {shouldPortalProject && createPortal(projectContent, portalTarget!)}
        {/* Other tabs (incl. split view): mounted on demand */}
        {effectiveTab !== 'terminal' && effectiveTab !== 'commands' && effectiveTab !== 'project' &&
          contentMap[effectiveTab]}
      </div>
    </>
  );
}

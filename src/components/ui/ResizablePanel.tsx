import { useRef, useState, useCallback, useEffect, type ReactNode } from 'react';
import styles from '@/styles/modules/DetailPanel.module.css';

const STORAGE_KEY = 'detail-panel-width';

function loadSavedWidth(fallback: number, min: number, max: number, tabKey?: string): number {
  try {
    // Try tab-specific width first
    if (tabKey) {
      const tabRaw = localStorage.getItem(`${STORAGE_KEY}:${tabKey}`);
      if (tabRaw) {
        const w = Number(tabRaw);
        if (Number.isFinite(w)) return Math.min(max, Math.max(min, w));
      }
    }
    // Fall back to global width
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const w = Number(raw);
      if (Number.isFinite(w)) return Math.min(max, Math.max(min, w));
    }
  } catch { /* ignore */ }
  return fallback;
}

interface ResizablePanelProps {
  children: ReactNode;
  initialWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  side?: 'left' | 'right';
  className?: string;
  /** When provided, panel width is persisted per-tab (e.g. "terminal", "project") */
  activeTab?: string;
  /** When true, the panel fills the entire viewport */
  fullscreen?: boolean;
}

export default function ResizablePanel({
  children,
  initialWidth = 400,
  minWidth = 280,
  maxWidth = 800,
  side = 'right',
  className,
  activeTab,
  fullscreen = false,
}: ResizablePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  const savedWidth = useRef(loadSavedWidth(initialWidth, minWidth, maxWidth, activeTab));
  const activeTabRef = useRef(activeTab);

  // When activeTab changes, restore saved width for that tab
  useEffect(() => {
    if (activeTab === activeTabRef.current) return;
    activeTabRef.current = activeTab;
    const panel = panelRef.current;
    if (!panel) return;
    const w = loadSavedWidth(initialWidth, minWidth, maxWidth, activeTab);
    savedWidth.current = w;
    panel.style.width = `${w}px`;
  }, [activeTab, initialWidth, minWidth, maxWidth]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const panel = panelRef.current;
      if (!panel) return;

      setResizing(true);
      const startX = e.clientX;
      const startWidth = panel.getBoundingClientRect().width;

      function onMouseMove(moveEvent: MouseEvent) {
        if (!panel) return;
        const delta = side === 'right'
          ? startX - moveEvent.clientX
          : moveEvent.clientX - startX;
        const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
        panel.style.width = `${newWidth}px`;
      }

      function onMouseUp() {
        setResizing(false);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // Persist final width (global + per-tab if activeTab is set)
        if (panel) {
          const finalWidth = panel.getBoundingClientRect().width;
          savedWidth.current = finalWidth;
          const rounded = String(Math.round(finalWidth));
          try {
            localStorage.setItem(STORAGE_KEY, rounded);
            if (activeTabRef.current) {
              localStorage.setItem(`${STORAGE_KEY}:${activeTabRef.current}`, rounded);
            }
          } catch { /* ignore */ }
        }
      }

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [minWidth, maxWidth, side],
  );

  return (
    <div
      ref={panelRef}
      className={`${styles.panel} ${resizing ? styles.resizing : ''} ${fullscreen ? styles.panelFullscreen : ''} ${className ?? ''}`}
      style={fullscreen ? undefined : { width: `${savedWidth.current}px` }}
    >
      {!fullscreen && (
        <div
          onMouseDown={handleMouseDown}
          className={`${styles.resizeHandle} ${resizing ? styles.active : ''}`}
          style={{ [side === 'right' ? 'left' : 'right']: '-3px' }}
        />
      )}
      {children}
    </div>
  );
}

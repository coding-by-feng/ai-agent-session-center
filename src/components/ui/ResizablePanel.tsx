import { useRef, useState, useCallback, type ReactNode } from 'react';
import styles from '@/styles/modules/DetailPanel.module.css';

interface ResizablePanelProps {
  children: ReactNode;
  initialWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  side?: 'left' | 'right';
  className?: string;
}

export default function ResizablePanel({
  children,
  initialWidth = 400,
  minWidth = 280,
  maxWidth = 800,
  side = 'right',
  className,
}: ResizablePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);

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
      className={`${styles.panel} ${resizing ? styles.resizing : ''} ${className ?? ''}`}
      style={{ width: `${initialWidth}px` }}
    >
      <div
        onMouseDown={handleMouseDown}
        className={`${styles.resizeHandle} ${resizing ? styles.active : ''}`}
        style={{ [side === 'right' ? 'left' : 'right']: '-3px' }}
      />
      {children}
    </div>
  );
}

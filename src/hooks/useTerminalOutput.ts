/**
 * useTerminalOutput — React hook for DOM-based read-only terminal output viewer.
 * Subscribes to WebSocket terminal_output messages, processes ANSI codes,
 * and provides lines + auto-scroll state for rendering.
 */
import { useRef, useCallback, useEffect, useState } from 'react';
import { base64ToUtf8, stripNonSgrEscapes, processTerminalChunk } from '@/lib/ansiProcessor';

const MAX_LINES = 10_000;

interface UseTerminalOutputOptions {
  ws: WebSocket | null;
  terminalId: string | null;
}

interface UseTerminalOutputReturn {
  /** Accumulated output lines (ANSI codes intact for rendering) */
  lines: string[];
  /** Ref to attach to the scrollable container div */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Whether auto-scrolling to bottom is active */
  isAutoScrolling: boolean;
  /** Manually scroll to the bottom and re-enable auto-scroll */
  scrollToBottom: () => void;
  /** Clear all output lines */
  clearOutput: () => void;
  /** Handle terminal_output WS message */
  handleTerminalOutput: (terminalId: string, base64Data: string) => void;
  /** Handle terminal_closed WS message */
  handleTerminalClosed: (terminalId: string, reason?: string) => void;
  /** Get the current selected text (for bookmarks) */
  getSelectedText: () => string;
  /** Scroll to a specific pixel offset (for bookmarks) */
  scrollToOffset: (offset: number) => void;
  /** Get current scrollTop (for bookmarks) */
  getScrollOffset: () => number;
}

export function useTerminalOutput({ ws, terminalId }: UseTerminalOutputOptions): UseTerminalOutputReturn {
  const [lines, setLines] = useState<string[]>([]);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const partialLineRef = useRef('');
  const autoScrollRef = useRef(true);
  const [isAutoScrolling, setIsAutoScrolling] = useState(true);
  const wsRef = useRef(ws);
  const terminalIdRef = useRef(terminalId);
  const subscribedRef = useRef<string | null>(null);

  // Pending chunks for RAF batching
  const pendingChunksRef = useRef<string[]>([]);
  const rafRef = useRef<number | null>(null);

  // Keep refs in sync
  useEffect(() => { wsRef.current = ws; }, [ws]);
  useEffect(() => { terminalIdRef.current = terminalId; }, [terminalId]);

  // Subscribe/unsubscribe when terminalId or ws changes
  useEffect(() => {
    if (!ws || ws.readyState !== 1) return;

    // Unsubscribe previous
    if (subscribedRef.current && subscribedRef.current !== terminalId) {
      ws.send(JSON.stringify({ type: 'terminal_disconnect', terminalId: subscribedRef.current }));
      subscribedRef.current = null;
    }

    if (terminalId) {
      ws.send(JSON.stringify({ type: 'terminal_subscribe', terminalId }));
      subscribedRef.current = terminalId;
    }

    return () => {
      if (subscribedRef.current && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'terminal_disconnect', terminalId: subscribedRef.current }));
        subscribedRef.current = null;
      }
    };
  }, [ws, terminalId]);

  // Reset state when terminalId changes
  useEffect(() => {
    setLines([]);
    partialLineRef.current = '';
    autoScrollRef.current = true;
    setIsAutoScrolling(true);
    pendingChunksRef.current = [];
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, [terminalId]);

  // Scroll tracking: detect if user scrolled up
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const atBottom = scrollHeight - scrollTop - clientHeight < 30;
      autoScrollRef.current = atBottom;
      setIsAutoScrolling(atBottom);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [terminalId]); // re-bind when terminal changes

  // Flush pending chunks via RAF
  const flushPending = useCallback(() => {
    const chunks = pendingChunksRef.current;
    if (chunks.length === 0) return;
    pendingChunksRef.current = [];

    // Combine all pending chunks into one string
    const combined = chunks.join('');
    const cleaned = stripNonSgrEscapes(combined);
    const { lines: newLines, partial } = processTerminalChunk(cleaned, partialLineRef.current);
    partialLineRef.current = partial;

    if (newLines.length === 0 && partial === partialLineRef.current) return;

    setLines((prev) => {
      // Include partial as last visible line if non-empty
      const updated = [...prev, ...newLines];
      // Enforce max lines
      if (updated.length > MAX_LINES) {
        return updated.slice(updated.length - MAX_LINES);
      }
      return updated;
    });

    // Auto-scroll after DOM update
    if (autoScrollRef.current) {
      requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
      });
    }
  }, []);

  const handleTerminalOutput = useCallback((tid: string, base64Data: string) => {
    if (tid !== terminalIdRef.current) return;

    const text = base64ToUtf8(base64Data);
    if (!text) return;

    pendingChunksRef.current.push(text);

    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        flushPending();
      });
    }
  }, [flushPending]);

  const handleTerminalClosed = useCallback((tid: string, reason?: string) => {
    if (tid !== terminalIdRef.current) return;
    setLines((prev) => [...prev, `\x1b[31m--- Terminal ${reason || 'closed'} ---\x1b[0m`]);
  }, []);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
      autoScrollRef.current = true;
      setIsAutoScrolling(true);
    }
  }, []);

  // Listen for global shortcut event to scroll terminal output to bottom
  useEffect(() => {
    const handler = () => scrollToBottom();
    document.addEventListener('terminal:scrollToBottom', handler);
    return () => document.removeEventListener('terminal:scrollToBottom', handler);
  }, [scrollToBottom]);

  const clearOutput = useCallback(() => {
    setLines([]);
    partialLineRef.current = '';
  }, []);

  const getSelectedText = useCallback((): string => {
    const selection = window.getSelection();
    return selection?.toString() ?? '';
  }, []);

  const scrollToOffset = useCallback((offset: number) => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTo({ top: offset, behavior: 'smooth' });
    }
  }, []);

  const getScrollOffset = useCallback((): number => {
    return scrollContainerRef.current?.scrollTop ?? 0;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  return {
    lines,
    scrollContainerRef,
    isAutoScrolling,
    scrollToBottom,
    clearOutput,
    handleTerminalOutput,
    handleTerminalClosed,
    getSelectedText,
    scrollToOffset,
    getScrollOffset,
  };
}

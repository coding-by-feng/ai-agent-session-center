/**
 * useOutputCapture — listens to WS terminal_output messages without subscribing.
 * Used by OutputTab to accumulate plain-text terminal output for post-compaction review.
 * Does NOT send terminal_subscribe/terminal_disconnect — relies on TerminalContainer's subscription.
 */
import { useRef, useCallback, useEffect, useState } from 'react';
import { base64ToUtf8, stripNonSgrEscapes, processTerminalChunk } from '@/lib/ansiProcessor';

const MAX_LINES = 10_000;

// Strip all remaining SGR (color/style) ANSI codes for plain-text output
const SGR_RE = /\x1b\[[\d;]*m/g;

interface UseOutputCaptureOptions {
  ws: WebSocket | null;
  terminalId: string | null;
}

export interface UseOutputCaptureReturn {
  lines: string[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  isAutoScrolling: boolean;
  scrollToBottom: () => void;
  clearOutput: () => void;
}

export function useOutputCapture({ ws, terminalId }: UseOutputCaptureOptions): UseOutputCaptureReturn {
  const [lines, setLines] = useState<string[]>([]);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const partialLineRef = useRef('');
  const autoScrollRef = useRef(true);
  const [isAutoScrolling, setIsAutoScrolling] = useState(true);
  const terminalIdRef = useRef(terminalId);
  const pendingChunksRef = useRef<string[]>([]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => { terminalIdRef.current = terminalId; }, [terminalId]);

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

  const flushPending = useCallback(() => {
    const chunks = pendingChunksRef.current;
    if (chunks.length === 0) return;
    pendingChunksRef.current = [];

    const combined = chunks.join('');
    // Strip all escape sequences for plain-text output
    const cleaned = stripNonSgrEscapes(combined).replace(SGR_RE, '');
    const { lines: newLines, partial } = processTerminalChunk(cleaned, partialLineRef.current);
    partialLineRef.current = partial;

    if (newLines.length === 0) return;

    setLines((prev) => {
      const updated = [...prev, ...newLines];
      return updated.length > MAX_LINES ? updated.slice(updated.length - MAX_LINES) : updated;
    });

    if (autoScrollRef.current) {
      requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        if (container) container.scrollTop = container.scrollHeight;
      });
    }
  }, []);

  // Listen to WS messages without subscribing.
  // IMPORTANT: terminalId must be in the dependency array so the handler is
  // re-registered when switching sessions. Without it the old handler lingers
  // and filters messages by a stale terminalIdRef, causing missed output.
  useEffect(() => {
    if (!ws || !terminalId) return;

    const tid = terminalId; // capture for closure
    const handler = (event: MessageEvent) => {
      let msg: { type: string; terminalId?: string; data?: string };
      try { msg = JSON.parse(event.data as string); } catch { return; }
      if (msg.type !== 'terminal_output' || msg.terminalId !== tid || !msg.data) return;

      const text = base64ToUtf8(msg.data);
      if (!text) return;

      pendingChunksRef.current.push(text);
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          flushPending();
        });
      }
    };

    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, terminalId, flushPending]);

  // Scroll tracking
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
  }, [terminalId]);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
      autoScrollRef.current = true;
      setIsAutoScrolling(true);
    }
  }, []);

  const clearOutput = useCallback(() => {
    setLines([]);
    partialLineRef.current = '';
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return { lines, scrollContainerRef, isAutoScrolling, scrollToBottom, clearOutput };
}

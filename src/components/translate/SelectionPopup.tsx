/**
 * SelectionPopup — the floating two-icon toolbar that appears at a text
 * selection. Two modes:
 *   🔎 Explain in learning language
 *   🌐 Explain in native language
 *
 * Surface-agnostic: works on terminals (via xterm extractor) and DOM viewers
 * (via DOM extractor). The parent supplies the originSessionId + extracted
 * selection; this component only handles UI + the spawn API call.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Tooltip from '@/components/ui/Tooltip';
import { tooltips } from '@/lib/tooltips';
import { useSettingsStore } from '@/stores/settingsStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { createLog } from '@/lib/translationLog';
import type { ExtractedSelection } from '@/lib/selectionExtractors';
import styles from '@/styles/modules/SelectionPopup.module.css';

interface SelectionPopupProps {
  selection: ExtractedSelection;
  originSessionId: string;
  onClose: () => void;
}

const POPUP_W = 230;
const POPUP_H = 40;
const VIEWPORT_MARGIN = 12;

function clampToViewport(x: number, y: number): { x: number; y: number } {
  if (typeof window === 'undefined') return { x, y };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(VIEWPORT_MARGIN, Math.min(vw - POPUP_W - VIEWPORT_MARGIN, x)),
    y: Math.max(VIEWPORT_MARGIN, Math.min(vh - POPUP_H - VIEWPORT_MARGIN, y)),
  };
}

function ExplainEnIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="7" cy="7" r="4.5" />
      <line x1="14" y1="14" x2="10.5" y2="10.5" />
    </svg>
  );
}

function ExplainNativeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8 H14" />
      <path d="M8 2 C5.5 4.5, 5.5 11.5, 8 14" />
      <path d="M8 2 C10.5 4.5, 10.5 11.5, 8 14" />
    </svg>
  );
}

export default function SelectionPopup({
  selection,
  originSessionId,
  onClose,
}: SelectionPopupProps) {
  const nativeLanguage = useSettingsStore((s) => s.translationNativeLanguage);
  const learningLanguage = useSettingsStore((s) => s.translationLearningLanguage);
  const inheritContext = useSettingsStore((s) => s.translationInheritContext);
  const openFloat = useFloatingSessionsStore((s) => s.open);
  const sessions = useSessionStore((s) => s.sessions);

  const [busy, setBusy] = useState<null | 'learning' | 'native'>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Position the popup just below the selection's anchor point.
  const pos = clampToViewport(
    selection.anchor.x,
    selection.anchor.bottom + 6,
  );

  const spawn = useCallback(async (mode: 'explain-learning' | 'explain-native') => {
    if (busy) return;
    setBusy(mode === 'explain-learning' ? 'learning' : 'native');
    setError(null);
    try {
      const resp = await fetch('/api/sessions/spawn-floating', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originSessionId,
          mode,
          selection: selection.selection,
          contextLine: selection.contextLine,
          nativeLanguage,
          learningLanguage,
          inheritContext,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to spawn session');
      const origin = sessions.get(originSessionId);
      await createLog({
        mode,
        nativeLanguage,
        learningLanguage,
        selection: selection.selection,
        contextLine: selection.contextLine,
        filePath: '',
        fileContent: '',
        prompt: '',
        originSessionId,
        originProjectName: origin?.projectName ?? '',
        originSessionTitle: origin?.title ?? '',
        floatTerminalId: data.terminalId,
      }).catch(() => { /* persistence failure is non-fatal */ });
      openFloat({
        terminalId: data.terminalId,
        label: data.label,
        originSessionId,
      });
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(null);
    }
  }, [busy, originSessionId, selection, nativeLanguage, learningLanguage, openFloat, onClose]);

  // Auto-dismiss errors after 3s
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 3000);
    return () => clearTimeout(t);
  }, [error]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={rootRef}
      className={styles.popup}
      data-selection-popup="true"
      style={{ left: pos.x, top: pos.y }}
      role="toolbar"
      aria-label="Selection actions"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Tooltip
        label={`Explain (${learningLanguage})`}
        description={tooltips.selExplainLearning.description}
        placement="bottom"
      >
        <button
          type="button"
          className={styles.btn}
          disabled={busy !== null}
          onClick={() => spawn('explain-learning')}
          aria-label={`Explain in ${learningLanguage}`}
        >
          <ExplainEnIcon />
          <span className={styles.label}>{learningLanguage}</span>
        </button>
      </Tooltip>
      <Tooltip
        label={`Explain (${nativeLanguage})`}
        description={tooltips.selExplainNative.description}
        placement="bottom"
      >
        <button
          type="button"
          className={styles.btn}
          disabled={busy !== null}
          onClick={() => spawn('explain-native')}
          aria-label={`Explain in ${nativeLanguage}`}
        >
          <ExplainNativeIcon />
          <span className={styles.label}>{nativeLanguage}</span>
        </button>
      </Tooltip>
      {error && <span className={styles.error} role="alert">{error}</span>}
    </div>,
    document.body,
  );
}

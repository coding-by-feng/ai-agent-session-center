/**
 * SelectionPopup — the floating action toolbar that appears at a text
 * selection. Two rows × two modes each:
 *   Row 1 — Explain:
 *     🔎 Explain in learning language
 *     🌐 Explain in native language
 *   Row 2 — Translate:
 *     A→ Translate to learning language
 *     A→ Translate to native language
 *
 * All modes fork the origin Claude/Codex session to inherit its conversation
 * context when the "Inherit conversation context" setting is on (default).
 *
 * Surface-agnostic: works on terminals (via xterm extractor) and DOM viewers
 * (via DOM extractor). The parent supplies the originSessionId + extracted
 * selection; this component only handles UI + the spawn API call.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Tooltip from '@/components/ui/Tooltip';
import AutocompleteTextarea from '@/components/ui/AutocompleteTextarea';
import Combobox from '@/components/ui/Combobox';
import Select from '@/components/ui/Select';
import { tooltips } from '@/lib/tooltips';
import { useSettingsStore } from '@/stores/settingsStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { createLog } from '@/lib/translationLog';
import { openFloatWindow, preopenTerminalPopup } from '@/lib/popoutTerminalWindow';
import { showToast } from '@/components/ui/ToastContainer';
import { detectCli } from '@/lib/cliDetect';
import { EFFORT_LEVELS, MODEL_OPTIONS } from '@/lib/remoteControlName';
import type { ExtractedSelection } from '@/lib/selectionExtractors';
import type { CodexModelOption, ListCodexModelsResponse } from '@/types/api';
import styles from '@/styles/modules/SelectionPopup.module.css';

interface SelectionPopupProps {
  selection: ExtractedSelection;
  originSessionId: string;
  /**
   * The terminal this popup is hosted in, if any. Sent to the server so a popup
   * spawned from inside a floating terminal forks recursively from that
   * terminal's session. Unset on the project-tab markdown viewer (forks from the
   * origin). The main terminal passes its own id → the main session forks itself.
   */
  spawnTerminalId?: string;
  onClose: () => void;
  /**
   * Path of the file the selection came from, when one is known (the project
   * file viewer). Absent for terminal selections. Only the Explain modes use
   * it — they may offer to attach it to the prompt.
   */
  currentFilePath?: string;
}

const POPUP_W = 260;
// Two icon rows + the selection preview + the quick-settings row + the
// custom-prompt row; used only for viewport clamping. Bumped from 184 when
// the Model/Effort row was added.
const POPUP_H = 224;
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

function TranslateIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {/* Stylized "A" on the left */}
      <path d="M2 8 L4 3 L6 8" />
      <path d="M2.7 6.5 H5.3" />
      {/* Arrow */}
      <path d="M7 8 H11" />
      <path d="M9.5 6.5 L11 8 L9.5 9.5" />
      {/* CJK-like glyph on the right */}
      <rect x="11.5" y="3" width="3.5" height="3.5" />
      <path d="M11.5 9.5 H15" />
      <path d="M13.25 9.5 V13" />
    </svg>
  );
}

function VocabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {/* Open book / dictionary */}
      <path d="M8 4 C6.5 3, 4 3, 2.5 3.5 V12.5 C4 12, 6.5 12, 8 13" />
      <path d="M8 4 C9.5 3, 12 3, 13.5 3.5 V12.5 C12 12, 9.5 12, 8 13" />
      <line x1="8" y1="4" x2="8" y2="13" />
    </svg>
  );
}

type SpawnMode =
  | 'explain-learning'
  | 'explain-native'
  | 'vocab-native'
  | 'translate-selection-learning'
  | 'translate-selection-native'
  | 'custom';

export default function SelectionPopup({
  selection,
  originSessionId,
  spawnTerminalId,
  onClose,
  currentFilePath,
}: SelectionPopupProps) {
  const nativeLanguage = useSettingsStore((s) => s.translationNativeLanguage);
  const learningLanguage = useSettingsStore((s) => s.translationLearningLanguage);
  const inheritContext = useSettingsStore((s) => s.translationInheritContext);
  // Quick-settings override (Model + Effort row). Blank means "inherit from
  // the origin session" — kept as separate Claude/Codex fields so a Claude
  // alias never lands in a Codex id field or vice versa (see settingsStore.ts).
  const spawnModel = useSettingsStore((s) => s.selectionSpawnModel);
  const spawnCodexModel = useSettingsStore((s) => s.selectionSpawnCodexModel);
  const spawnEffort = useSettingsStore((s) => s.selectionSpawnEffort);
  const spawnTarget = useSettingsStore((s) => s.selectionSpawnTarget);
  const openFloat = useFloatingSessionsStore((s) => s.open);
  const setPoppedOut = useFloatingSessionsStore((s) => s.setPoppedOut);
  const sessions = useSessionStore((s) => s.sessions);

  const [busy, setBusy] = useState<SpawnMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Free-form instruction for the `custom` mode — combined with the selection.
  const [customPrompt, setCustomPrompt] = useState('');
  // When an Explain mode is clicked with a file open and the preference is
  // "ask", we pause to confirm attaching the file path. Holds the pending mode.
  const [pendingExplain, setPendingExplain] = useState<SpawnMode | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Which CLI the origin runs — drives the quick-settings row (Claude gets
  // Model + Effort, Codex gets Model only) and AutocompleteTextarea's `/`
  // vs `$` behavior. Same precedence as the server's resolveOriginCli.
  const origin = sessions.get(originSessionId);
  const cli = origin ? (detectCli(origin) ?? 'claude') : 'claude';

  const [codexModels, setCodexModels] = useState<CodexModelOption[]>([]);
  const [codexModelStatus, setCodexModelStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  // Fetch the live Codex model catalog once per popup, only for Codex origins
  // (mirrors NewSessionModal's fetch — same endpoint, same shape).
  useEffect(() => {
    if (cli !== 'codex') return;
    const controller = new AbortController();
    setCodexModelStatus('loading');
    void fetch('/api/codex/models', { signal: controller.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Codex model catalog returned ${res.status}`);
        return res.json() as Promise<ListCodexModelsResponse>;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setCodexModels(data.models);
        setCodexModelStatus('ready');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setCodexModels([]);
        setCodexModelStatus('error');
      });
    return () => controller.abort();
  }, [cli]);

  const codexModelOptions = useMemo(() => {
    const recommended = codexModels.find((item) => item.isDefault);
    return [
      {
        value: '',
        label: recommended ? `Default (${recommended.displayName})` : 'Default (Codex recommended)',
      },
      ...codexModels.map((item) => ({ value: item.id, label: item.displayName })),
    ];
  }, [codexModels]);

  // Position the popup just below the selection's anchor point.
  const pos = clampToViewport(
    selection.anchor.x,
    selection.anchor.bottom + 6,
  );

  const spawn = useCallback(async (mode: SpawnMode, opts?: { attachFile?: boolean }) => {
    if (busy) return;
    // The custom mode requires the user's own instruction.
    const trimmedCustom = customPrompt.trim();
    if (mode === 'custom' && !trimmedCustom) return;
    // Only the Explain modes opt into attaching the file path, and only when a
    // file is actually known (the project viewer).
    const attachedPath = opts?.attachFile && currentFilePath ? currentFilePath : undefined;

    // Open the eventual popup window's tab RIGHT NOW, synchronously, while
    // this click's transient activation is still fresh — see
    // preopenTerminalPopup's docblock. `spawn` is only ever called directly
    // from a real click (or the Attach-file confirm's Yes/No, itself a real
    // click), so this line still runs inside that same synchronous dispatch
    // even though `spawn` is async — everything below this point is async
    // (the fetch below), and window.open() called AFTER an await reliably
    // gets popup-blocked by Chrome, since forking a session is a real network
    // round trip, not instant. Skipped when the user has chosen to always
    // dock — nothing to preopen a window for.
    const preopened = spawnTarget === 'docked' ? null : preopenTerminalPopup();

    setBusy(mode);
    setError(null);
    try {
      const resp = await fetch('/api/sessions/spawn-floating', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originSessionId,
          spawnTerminalId,
          mode,
          selection: selection.selection,
          contextLine: selection.contextLine,
          customPrompt: mode === 'custom' ? trimmedCustom : undefined,
          filePath: attachedPath,
          nativeLanguage,
          learningLanguage,
          inheritContext,
          // Quick-settings override — blank/absent inherits the origin
          // session's own model/effort (spawnFloatingSession's default).
          // Codex has no effort concept, so effortLevel never applies to it.
          model: (cli === 'codex' ? spawnCodexModel : spawnModel) || undefined,
          effortLevel: cli === 'claude' ? (spawnEffort || undefined) : undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to spawn session');
      await createLog({
        mode,
        nativeLanguage,
        learningLanguage,
        selection: selection.selection,
        contextLine: selection.contextLine,
        filePath: attachedPath ?? '',
        // Always record where the selection came from (when known) so favorited
        // selections can be highlighted back in their file — independent of
        // whether the path was attached to the prompt.
        sourceFilePath: currentFilePath ?? '',
        fileContent: '',
        prompt: mode === 'custom' ? trimmedCustom : '',
        originSessionId,
        originProjectName: origin?.projectName ?? '',
        originSessionTitle: origin?.title ?? '',
        floatTerminalId: data.terminalId,
      }).catch(() => { /* persistence failure is non-fatal */ });
      // Land the new session directly in a real OS window (the default), so it
      // can be dragged to another monitor without first docking it in-app and
      // then clicking detach. `openFloatWindow` owns the Electron / stale-preload
      // / browser branching.
      //
      // A `docked` outcome MUST still open the in-app panel: the session already
      // exists server-side and holds a WS subscription, so dropping it here would
      // leave a live forked CLI session with no UI attached — invisible and
      // unclosable. `setPoppedOut` is what makes the popout the sole subscriber,
      // and has to be set even though no panel ever mounted in the window case.
      const openDocked = (): void => {
        openFloat({ terminalId: data.terminalId, label: data.label, originSessionId });
      };
      if (spawnTarget === 'docked') {
        openDocked();
      } else {
        const outcome = await openFloatWindow({
          terminalId: data.terminalId,
          originSessionId,
          label: data.label,
          preopened,
        });
        if (outcome.placed === 'window') {
          setPoppedOut(data.terminalId, true);
        } else {
          openDocked();
          if (outcome.reason === 'stale-preload') {
            showToast('Opened in-app — restart the app to enable separate windows', 'info', 4000);
          } else if (outcome.reason === 'popup-blocked') {
            showToast('Popup blocked — opened in-app instead. Allow popups for a separate window.', 'info', 5000);
          }
        }
      }
      onClose();
    } catch (err: unknown) {
      // The spawn API call failed (or threw before openFloatWindow ever got to
      // consume/close it) — the placeholder window must still be closed here,
      // or a failed spawn leaves a stray "Starting session…" tab open forever.
      preopened?.close();
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(null);
    }
  }, [busy, customPrompt, originSessionId, spawnTerminalId, selection, currentFilePath, nativeLanguage, learningLanguage, inheritContext, origin, cli, spawnModel, spawnCodexModel, spawnEffort, spawnTarget, openFloat, setPoppedOut, onClose]);

  // Explain buttons: with a file open and the preference "ask", pause to confirm
  // attaching the file path; otherwise honor the remembered choice. In the
  // terminal (no current file) Explain always spawns immediately.
  const onExplainClick = useCallback((mode: SpawnMode) => {
    if (!currentFilePath) { void spawn(mode); return; }
    // Read the preference lazily — it only matters at click time, so subscribing
    // would re-render every mounted popup whenever the preference changes.
    const pref = useSettingsStore.getState().explainAttachFilePath;
    if (pref === 'always') { void spawn(mode, { attachFile: true }); return; }
    if (pref === 'never') { void spawn(mode, { attachFile: false }); return; }
    setPendingExplain(mode);
  }, [currentFilePath, spawn]);

  // Resolve the inline "Attach file path?" confirm: remember the choice and spawn.
  const resolveExplain = useCallback((attach: boolean) => {
    if (!pendingExplain) return;
    const mode = pendingExplain;
    setPendingExplain(null);
    useSettingsStore.getState().setExplainAttachFilePath(attach ? 'always' : 'never');
    void spawn(mode, { attachFile: attach });
  }, [pendingExplain, spawn]);

  // Auto-dismiss errors after 3s
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 3000);
    return () => clearTimeout(t);
  }, [error]);

  if (typeof document === 'undefined') return null;

  // All four mode buttons freeze while a spawn is in flight or the file-path
  // confirm is open.
  const actionsDisabled = busy !== null || pendingExplain !== null;

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
      <div className={styles.row}>
        <Tooltip
          label={`Explain (${learningLanguage})`}
          description={tooltips.selExplainLearning.description}
          placement="bottom"
        >
          <button
            type="button"
            className={styles.btn}
            disabled={actionsDisabled}
            onClick={() => onExplainClick('explain-learning')}
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
            disabled={actionsDisabled}
            onClick={() => onExplainClick('explain-native')}
            aria-label={`Explain in ${nativeLanguage}`}
          >
            <ExplainNativeIcon />
            <span className={styles.label}>{nativeLanguage}</span>
          </button>
        </Tooltip>
      </div>
      <div className={styles.row}>
        <Tooltip
          label={`Translate → ${learningLanguage}`}
          description={tooltips.selTranslateLearning.description}
          placement="bottom"
        >
          <button
            type="button"
            className={styles.btn}
            disabled={actionsDisabled}
            onClick={() => spawn('translate-selection-learning')}
            aria-label={`Translate to ${learningLanguage}`}
          >
            <TranslateIcon />
            <span className={styles.label}>{learningLanguage}</span>
          </button>
        </Tooltip>
        <Tooltip
          label={`Translate → ${nativeLanguage}`}
          description={tooltips.selTranslateNative.description}
          placement="bottom"
        >
          <button
            type="button"
            className={styles.btn}
            disabled={actionsDisabled}
            onClick={() => spawn('translate-selection-native')}
            aria-label={`Translate to ${nativeLanguage}`}
          >
            <TranslateIcon />
            <span className={styles.label}>{nativeLanguage}</span>
          </button>
        </Tooltip>
      </div>
      <div className={styles.row}>
        <Tooltip
          label={`Vocabulary (${nativeLanguage})`}
          description={tooltips.selVocabNative.description}
          placement="bottom"
        >
          <button
            type="button"
            className={styles.btn}
            disabled={actionsDisabled}
            onClick={() => spawn('vocab-native')}
            aria-label={`Explain vocabulary in ${nativeLanguage}`}
          >
            <VocabIcon />
            <span className={styles.label}>Vocabulary</span>
          </button>
        </Tooltip>
      </div>
      {/* Mirror the captured selection. Focusing the textarea below collapses
          the browser's native selection highlight, so this read-only preview
          is what tells the user the selected text is still attached. */}
      <div
        className={styles.selectionPreview}
        data-testid="selection-preview"
        title={selection.selection}
        aria-label="Captured selection"
      >
        <span className={styles.selectionQuote} aria-hidden>“</span>
        <span className={styles.selectionText}>{selection.selection}</span>
      </div>
      {/* Quick-settings override for whatever spawns next (any icon button or
          the custom Run▶ below) — blank stays on today's inherit-from-origin
          behavior. Hidden during the attach-file confirm, like the custom row. */}
      {!pendingExplain && (
        <div className={styles.quickSettingsRow}>
          {cli === 'codex' ? (
            codexModelStatus === 'ready' ? (
              <Select
                value={spawnCodexModel}
                onChange={(v) => useSettingsStore.getState().setSelectionSpawnCodexModel(v)}
                options={codexModelOptions}
                placeholder="Default (Codex recommended)"
                className={styles.quickSettingsModel}
                title="Model"
              />
            ) : (
              <input
                disabled
                readOnly
                className={styles.quickSettingsModel}
                value={codexModelStatus === 'error' ? 'Default (catalog unavailable)' : 'Loading Codex models…'}
              />
            )
          ) : (
            <>
              <Combobox
                value={spawnModel}
                onChange={(v) => useSettingsStore.getState().setSelectionSpawnModel(v)}
                items={[...MODEL_OPTIONS]}
                placeholder="Model"
                className={styles.quickSettingsModel}
              />
              <Combobox
                value={spawnEffort}
                onChange={(v) => useSettingsStore.getState().setSelectionSpawnEffort(v)}
                items={[...EFFORT_LEVELS]}
                placeholder="Effort"
                className={styles.quickSettingsEffort}
              />
            </>
          )}
        </div>
      )}
      {pendingExplain && (
        <div className={styles.attachConfirm} data-testid="attach-file-confirm">
          <div className={styles.attachConfirmText}>
            <span className={styles.attachConfirmLabel}>Attach file path?</span>
            <span className={styles.attachConfirmPath} title={currentFilePath}>{currentFilePath}</span>
          </div>
          <div className={styles.attachConfirmBtns}>
            <button
              type="button"
              className={styles.attachNo}
              disabled={busy !== null}
              onClick={() => resolveExplain(false)}
            >
              No
            </button>
            <button
              type="button"
              className={styles.attachYes}
              disabled={busy !== null}
              onClick={() => resolveExplain(true)}
            >
              Yes
            </button>
          </div>
        </div>
      )}
      {!pendingExplain && (
      <div className={styles.customRow}>
        <AutocompleteTextarea
          className={styles.customInput}
          value={customPrompt}
          onChange={setCustomPrompt}
          onKeyDown={(e) => {
            // Enter runs; Shift+Enter inserts a newline; ⌘/Ctrl+Enter also runs.
            // (AutocompleteTextarea intercepts ArrowUp/Down/Enter/Escape itself
            // while its own dropdown is open, so this only fires otherwise.)
            if (e.key === 'Enter' && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void spawn('custom');
            }
          }}
          placeholder="Custom prompt + selection → new session…"
          rows={1}
          sessionId={originSessionId}
          projectPath={origin?.projectPath}
          ariaLabel={tooltips.selCustomPrompt.label}
          disabled={busy !== null}
        />
        <Tooltip
          label={tooltips.selCustomPrompt.label}
          description={tooltips.selCustomPrompt.description}
          placement="bottom"
        >
          <button
            type="button"
            className={styles.customRun}
            disabled={busy !== null || !customPrompt.trim()}
            onClick={() => void spawn('custom')}
            aria-label="Run custom prompt"
          >
            Run ▶
          </button>
        </Tooltip>
      </div>
      )}
      {error && <span className={styles.error} role="alert">{error}</span>}
    </div>,
    document.body,
  );
}

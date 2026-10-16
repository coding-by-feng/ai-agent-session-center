/**
 * PhoneAiPopupSheet — the AI popup's choices on a phone (AASC-20, AASC-57): the
 * desktop popup's modes as 48px rows in a sheet instead of a 260px toolbar at the
 * cursor.
 *
 *   “the baton”                                   the selection, when there is one
 *   EXPLAIN          In English · In 简体中文
 *   TRANSLATE        To English · To 简体中文
 *   VOCABULARY       Words, in 简体中文
 *   THE LAST ANSWER  Translate → 简体中文         Chat and Terminal (Claude Code)
 *   THIS FILE        Translate → 简体中文         a project file with text
 *   YOUR OWN PROMPT  [ … ]  Ask
 *
 * Which rows show is aiActionsFor (lib/floatingSpawn), the request is
 * buildFloatingSpawnRequest: the same payload the desktop's SelectionPopup sends.
 * An explanation of text from a file asks once whether to name the file, as the
 * desktop does, and remembers the answer (explainAttachFilePath).
 *
 * Each action starts a floating fork (POST spawn-floating), which exists before
 * anything shows it. On a phone the only place to show it is the full-height sheet
 * (PhoneFloatingSheet): it is added to the floats store under the ROOT session and
 * shown at once. There is no window to open, so no branch can leave the fork
 * without a UI.
 */
import { useCallback, useId, useState } from 'react';
import BottomSheet from '@/components/ui/BottomSheet';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import type { PhoneAiSelection } from '@/stores/phoneAiStore';
import { detectCli } from '@/lib/cliDetect';
import {
  aiActionsFor,
  buildFloatingSpawnRequest,
  logFloatingSpawn,
  requestFloatingSpawn,
  type AiSource,
  type FloatingSpawnMode,
} from '@/lib/floatingSpawn';
import { SparkIcon } from './phoneIcons';
import styles from '@/styles/modules/PhoneExtras.module.css';

export type PhoneSelection = PhoneAiSelection;

export interface PhoneAiPopupSheetProps {
  open: boolean;
  /** The selected text, or null for the whole-content choices only. */
  selection: PhoneSelection | null;
  /** The ROOT session: the popup shows under it and starts in its folder. */
  originSessionId: string;
  source: AiSource;
  onClose: () => void;
  /** After a popup started (its sheet is showing it). */
  onSpawned?: () => void;
}

const NO_SELECTION_HINT: Record<AiSource['kind'], string> = {
  chat: 'Select text in the chat to explain or translate it.',
  terminal: 'Select text in the terminal to explain or translate it.',
  file: 'Select text in the file to explain or translate a part of it.',
  popup: 'Select text in the answer to explain or translate it.',
};

export default function PhoneAiPopupSheet({ open, selection, originSessionId, source, onClose, onSpawned }: PhoneAiPopupSheetProps) {
  const nativeLanguage = useSettingsStore((s) => s.translationNativeLanguage);
  const learningLanguage = useSettingsStore((s) => s.translationLearningLanguage);
  const inheritContext = useSettingsStore((s) => s.translationInheritContext);
  const spawnModel = useSettingsStore((s) => s.selectionSpawnModel);
  const spawnCodexModel = useSettingsStore((s) => s.selectionSpawnCodexModel);
  const spawnEffort = useSettingsStore((s) => s.selectionSpawnEffort);
  const origin = useSessionStore((s) => s.sessions.get(originSessionId));
  const openFloat = useFloatingSessionsStore((s) => s.open);
  const setPhoneShown = useFloatingSessionsStore((s) => s.setPhoneShown);
  const noteId = useId();

  const [busy, setBusy] = useState<FloatingSpawnMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');
  // An explanation of text from a file, waiting on "name the file?" (preference "ask").
  const [pendingExplain, setPendingExplain] = useState<FloatingSpawnMode | null>(null);

  const detected = origin ? detectCli(origin) : null;
  const cli = detected ?? 'claude';
  const actions = aiActionsFor({ source, cli, hasSelection: !!selection });

  const close = useCallback(() => {
    setError(null);
    setCustomPrompt('');
    setPendingExplain(null);
    onClose();
  }, [onClose]);

  const spawn = useCallback(async (mode: FloatingSpawnMode, attachFilePath = false) => {
    if (busy) return;
    const custom = customPrompt.trim();
    if (mode === 'custom' && !custom) return;
    const req = buildFloatingSpawnRequest({
      originSessionId,
      cli,
      mode,
      source,
      selection,
      customPrompt: custom,
      attachFilePath,
      settings: { nativeLanguage, learningLanguage, inheritContext, model: spawnModel, codexModel: spawnCodexModel, effort: spawnEffort },
    });
    setBusy(mode);
    setError(null);
    try {
      const result = await requestFloatingSpawn(req);
      void logFloatingSpawn(req, result, origin, source.kind === 'file' ? source.filePath ?? '' : '');
      openFloat({ terminalId: result.terminalId, label: result.label, originSessionId });
      setPhoneShown(result.terminalId);
      close();
      onSpawned?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [busy, customPrompt, originSessionId, cli, source, selection, nativeLanguage, learningLanguage, inheritContext, spawnModel, spawnCodexModel, spawnEffort, origin, openFloat, setPhoneShown, close, onSpawned]);

  // From a file, an explanation may name the file (the desktop's "Attach file path?").
  const explain = useCallback((mode: FloatingSpawnMode) => {
    if (source.kind !== 'file' || !source.filePath) { void spawn(mode); return; }
    const pref = useSettingsStore.getState().explainAttachFilePath;
    if (pref === 'always') { void spawn(mode, true); return; }
    if (pref === 'never') { void spawn(mode, false); return; }
    setPendingExplain(mode);
  }, [source, spawn]);

  const resolveExplain = useCallback((attach: boolean) => {
    if (!pendingExplain) return;
    const mode = pendingExplain;
    setPendingExplain(null);
    useSettingsStore.getState().setExplainAttachFilePath(attach ? 'always' : 'never');
    void spawn(mode, attach);
  }, [pendingExplain, spawn]);

  const frozen = busy !== null || pendingExplain !== null;

  const action = (mode: FloatingSpawnMode, label: string, onClick: () => void = () => void spawn(mode), ariaLabel?: string) => {
    const reason = actions[mode].disabledReason;
    return (
      <button
        type="button"
        className={styles.modeBtn}
        disabled={frozen || !!reason}
        aria-busy={busy === mode || undefined}
        aria-label={busy === mode ? undefined : ariaLabel}
        aria-describedby={reason ? `${noteId}-${mode}` : undefined}
        onClick={onClick}
      >
        {busy === mode ? 'Starting…' : label}
      </button>
    );
  };
  const reasonOf = (mode: FloatingSpawnMode) => {
    const reason = actions[mode].disabledReason;
    return reason ? <p id={`${noteId}-${mode}`} className={styles.aiNote}>{reason}</p> : null;
  };

  const title = selection
    ? 'Ask AI about the selection'
    : source.kind === 'file' ? 'Ask AI about this file' : 'Ask AI';

  return (
    <BottomSheet open={open} onClose={close} title={title}>
      {open && (
        <div className={styles.aiSheet}>
          {selection
            ? <blockquote className={styles.aiQuote} aria-label="Selected text">{selection.text}</blockquote>
            : <p className={styles.aiHint}>{NO_SELECTION_HINT[source.kind]}</p>}
          {selection && (
            <>
              <section className={styles.aiGroup} aria-label="Explain">
                <h3 className={styles.aiHeading}>Explain</h3>
                <div className={styles.aiGrid}>
                  {action('explain-learning', `In ${learningLanguage}`, () => explain('explain-learning'))}
                  {action('explain-native', `In ${nativeLanguage}`, () => explain('explain-native'))}
                </div>
                {pendingExplain && (
                  <div className={styles.aiConfirm} role="group" aria-label="Name the file in the prompt?">
                    <p className={styles.aiConfirmText}>Name this file in the prompt, so the agent knows where the text is from?</p>
                    <div className={styles.aiGrid}>
                      <button type="button" className={styles.modeBtn} onClick={() => resolveExplain(true)}>Name the file</button>
                      <button type="button" className={styles.modeBtn} onClick={() => resolveExplain(false)}>Don’t</button>
                    </div>
                  </div>
                )}
              </section>
              <section className={styles.aiGroup} aria-label="Translate">
                <h3 className={styles.aiHeading}>Translate</h3>
                <div className={styles.aiGrid}>
                  {action('translate-selection-learning', `To ${learningLanguage}`)}
                  {action('translate-selection-native', `To ${nativeLanguage}`)}
                </div>
              </section>
              <section className={styles.aiGroup} aria-label="Vocabulary">
                <h3 className={styles.aiHeading}>Vocabulary</h3>
                <div className={styles.aiGrid}>{action('vocab-native', `Words, in ${nativeLanguage}`)}</div>
              </section>
            </>
          )}
          {actions['translate-answer'].offered && (
            <section className={styles.aiGroup} aria-label="The last answer">
              <h3 className={styles.aiHeading}>The last answer</h3>
              <div className={styles.aiGrid}>
                {action('translate-answer', `Translate → ${nativeLanguage}`, undefined, `Translate the last answer to ${nativeLanguage}`)}
              </div>
              {reasonOf('translate-answer')}
            </section>
          )}
          {actions['translate-file'].offered && (
            <section className={styles.aiGroup} aria-label="This file">
              <h3 className={styles.aiHeading}>This file</h3>
              <div className={styles.aiGrid}>
                {action('translate-file', `Translate → ${nativeLanguage}`, undefined, `Translate the whole file to ${nativeLanguage}`)}
              </div>
              {reasonOf('translate-file')}
            </section>
          )}
          {selection && (
            <section className={styles.aiGroup} aria-label="Your own prompt">
              <h3 className={styles.aiHeading}>Your own prompt</h3>
              <textarea
                className={styles.aiCustom}
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="e.g. Is this safe to run?"
                rows={2}
                disabled={frozen}
                aria-label="Your own prompt, sent with the selection"
                enterKeyHint="send"
              />
              <button
                type="button"
                className={`${styles.modeBtn} ${styles.aiRun}`}
                disabled={frozen || !customPrompt.trim()}
                aria-busy={busy === 'custom' || undefined}
                onClick={() => void spawn('custom')}
              >
                <SparkIcon />
                {busy === 'custom' ? 'Starting…' : 'Ask'}
              </button>
            </section>
          )}
          {error && <p className={styles.aiError} role="alert">{error}</p>}
        </div>
      )}
    </BottomSheet>
  );
}

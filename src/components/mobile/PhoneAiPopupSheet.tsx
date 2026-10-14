/**
 * PhoneAiPopupSheet — the AI popup's actions for text selected on a phone
 * (AASC-20): explain, translate, vocabulary or your own prompt, as 48px rows in
 * a sheet instead of the desktop's 260px toolbar at the cursor.
 *
 * Each action starts a floating fork of the session (POST spawn-floating), which
 * exists before anything shows it. On a phone the only place to show it is the
 * full-height sheet (PhoneFloatingSheet): it is added to the floats store and
 * shown at once. There is no window to open, so there is no branch that could
 * leave the fork without a UI.
 */
import { useCallback, useState } from 'react';
import BottomSheet from '@/components/ui/BottomSheet';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { detectCli } from '@/lib/cliDetect';
import {
  logFloatingSpawn,
  requestFloatingSpawn,
  type FloatingSpawnRequest,
  type SelectionSpawnMode,
} from '@/lib/floatingSpawn';
import { SparkIcon } from './phoneIcons';
import styles from '@/styles/modules/PhoneExtras.module.css';

export interface PhoneSelection {
  text: string;
  /** The passage the text was selected from, for context. */
  contextLine?: string;
}

export interface PhoneAiPopupSheetProps {
  selection: PhoneSelection | null;
  originSessionId: string;
  onClose: () => void;
}

export default function PhoneAiPopupSheet({ selection, originSessionId, onClose }: PhoneAiPopupSheetProps) {
  const nativeLanguage = useSettingsStore((s) => s.translationNativeLanguage);
  const learningLanguage = useSettingsStore((s) => s.translationLearningLanguage);
  const inheritContext = useSettingsStore((s) => s.translationInheritContext);
  const spawnModel = useSettingsStore((s) => s.selectionSpawnModel);
  const spawnCodexModel = useSettingsStore((s) => s.selectionSpawnCodexModel);
  const spawnEffort = useSettingsStore((s) => s.selectionSpawnEffort);
  const origin = useSessionStore((s) => s.sessions.get(originSessionId));
  const openFloat = useFloatingSessionsStore((s) => s.open);
  const setPhoneShown = useFloatingSessionsStore((s) => s.setPhoneShown);

  const [busy, setBusy] = useState<SelectionSpawnMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');

  const cli = origin ? (detectCli(origin) ?? 'claude') : 'claude';

  const close = useCallback(() => {
    setError(null);
    setCustomPrompt('');
    onClose();
  }, [onClose]);

  const spawn = useCallback(async (mode: SelectionSpawnMode) => {
    if (!selection || busy) return;
    const custom = customPrompt.trim();
    if (mode === 'custom' && !custom) return;
    const req: FloatingSpawnRequest = {
      originSessionId,
      mode,
      selection: selection.text,
      contextLine: selection.contextLine,
      customPrompt: mode === 'custom' ? custom : undefined,
      nativeLanguage,
      learningLanguage,
      inheritContext,
      // Blank inherits the origin's own model/effort, as on the desktop.
      model: (cli === 'codex' ? spawnCodexModel : spawnModel) || undefined,
      effortLevel: cli === 'claude' ? spawnEffort || undefined : undefined,
    };
    setBusy(mode);
    setError(null);
    try {
      const result = await requestFloatingSpawn(req);
      void logFloatingSpawn(req, result, origin);
      openFloat({ terminalId: result.terminalId, label: result.label, originSessionId });
      setPhoneShown(result.terminalId);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [selection, busy, customPrompt, originSessionId, nativeLanguage, learningLanguage, inheritContext, cli, spawnModel, spawnCodexModel, spawnEffort, origin, openFloat, setPhoneShown, close]);

  const action = (mode: SelectionSpawnMode, label: string) => (
    <button
      type="button"
      className={styles.modeBtn}
      disabled={busy !== null}
      aria-busy={busy === mode || undefined}
      onClick={() => void spawn(mode)}
    >
      {busy === mode ? 'Starting…' : label}
    </button>
  );

  return (
    <BottomSheet open={!!selection} onClose={close} title="Ask AI about the selection">
      {selection && (
        <div className={styles.aiSheet}>
          <blockquote className={styles.aiQuote} aria-label="Selected text">{selection.text}</blockquote>
          <section className={styles.aiGroup} aria-label="Explain">
            <h3 className={styles.aiHeading}>Explain</h3>
            <div className={styles.aiGrid}>
              {action('explain-learning', `In ${learningLanguage}`)}
              {action('explain-native', `In ${nativeLanguage}`)}
            </div>
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
          <section className={styles.aiGroup} aria-label="Your own prompt">
            <h3 className={styles.aiHeading}>Your own prompt</h3>
            <textarea
              className={styles.aiCustom}
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="e.g. Is this safe to run?"
              rows={2}
              disabled={busy !== null}
              aria-label="Your own prompt, sent with the selection"
              enterKeyHint="send"
            />
            <button
              type="button"
              className={`${styles.modeBtn} ${styles.aiRun}`}
              disabled={busy !== null || !customPrompt.trim()}
              aria-busy={busy === 'custom' || undefined}
              onClick={() => void spawn('custom')}
            >
              <SparkIcon />
              {busy === 'custom' ? 'Starting…' : 'Ask'}
            </button>
          </section>
          {error && <p className={styles.aiError} role="alert">{error}</p>}
        </div>
      )}
    </BottomSheet>
  );
}

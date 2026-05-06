/**
 * TranslationSettings — settings tab for the select-to-translate feature.
 *
 * Configures:
 *   - Native language (target for translations / explanations)
 *   - Learning language (deeper-explain target — usually English)
 *   - Trigger mode (auto on selection / hold Alt / disabled)
 *
 * No API keys live here — translation reuses the user's existing CLI auth.
 */
import { useSettingsStore } from '@/stores/settingsStore';
import styles from '@/styles/modules/Settings.module.css';

const LANGUAGE_OPTIONS = [
  '简体中文',
  '繁體中文',
  'English',
  '日本語',
  '한국어',
  'Español',
  'Français',
  'Deutsch',
  'Português',
  'Русский',
  'Italiano',
  'العربية',
  'हिन्दी',
  'Tiếng Việt',
];

export default function TranslationSettings() {
  const enabled = useSettingsStore((s) => s.translationEnabled);
  const native = useSettingsStore((s) => s.translationNativeLanguage);
  const learning = useSettingsStore((s) => s.translationLearningLanguage);
  const trigger = useSettingsStore((s) => s.translationTrigger);
  const inheritContext = useSettingsStore((s) => s.translationInheritContext);
  const setEnabled = useSettingsStore((s) => s.setTranslationEnabled);
  const setNative = useSettingsStore((s) => s.setTranslationNativeLanguage);
  const setLearning = useSettingsStore((s) => s.setTranslationLearningLanguage);
  const setTrigger = useSettingsStore((s) => s.setTranslationTrigger);
  const setInheritContext = useSettingsStore((s) => s.setTranslationInheritContext);

  return (
    <div>
      <div className={styles.section}>
        <h4>Select-to-Translate</h4>
        <p className={styles.settingsHint}>
          Select text in the terminal or in a markdown file to open a small popup that forks a new
          AI session pre-loaded with an &ldquo;explain in&rdquo; prompt. No extra API key is required —
          translation reuses your existing CLI authentication.
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Enable translation popup</span>
        </label>
      </div>

      <div className={styles.section}>
        <h4>Languages</h4>
        <p className={styles.settingsHint}>
          The native language is what the AI will translate or explain into. The learning language
          is what the AI will use when explaining the selection &ldquo;deeper&rdquo; in the same language.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', rowGap: '10px', columnGap: '12px', alignItems: 'center', maxWidth: 480 }}>
          <label htmlFor="trans-native">Native language</label>
          <select
            id="trans-native"
            value={native}
            onChange={(e) => setNative(e.target.value)}
            className={styles.fontBtn}
            style={{ width: '100%' }}
          >
            {LANGUAGE_OPTIONS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>

          <label htmlFor="trans-learning">Learning language</label>
          <select
            id="trans-learning"
            value={learning}
            onChange={(e) => setLearning(e.target.value)}
            className={styles.fontBtn}
            style={{ width: '100%' }}
          >
            {LANGUAGE_OPTIONS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
      </div>

      <div className={styles.section}>
        <h4>Conversation context</h4>
        <p className={styles.settingsHint}>
          When enabled, &ldquo;Explain&rdquo; modes fork the origin Claude session
          (<code>claude --resume &lt;id&gt; --fork-session</code>) so the AI can ground
          the explanation in the prior conversation. Translate modes are unaffected
          because the source text is already in the prompt. Has no effect for
          Codex / Gemini origins.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input
            type="checkbox"
            checked={inheritContext}
            onChange={(e) => setInheritContext(e.target.checked)}
          />
          <span>Inherit conversation context for explain modes</span>
        </label>
      </div>

      <div className={styles.section}>
        <h4>Trigger</h4>
        <p className={styles.settingsHint}>
          When the popup should appear. &ldquo;Auto&rdquo; shows it on every selection;
          &ldquo;Hold ⌥&rdquo; only shows the popup if the Alt/Option key was held.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {([
            { id: 'auto', label: 'Auto — show on every selection' },
            { id: 'alt', label: 'Hold ⌥ + select' },
            { id: 'off', label: 'Disabled' },
          ] as const).map((opt) => (
            <label key={opt.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="radio"
                name="trans-trigger"
                value={opt.id}
                checked={trigger === opt.id}
                onChange={() => setTrigger(opt.id)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

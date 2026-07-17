import { useState, useRef, useEffect } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import Modal from '@/components/ui/Modal';
import ThemeSettings from './ThemeSettings';
import SoundSettings from './SoundSettings';
import HookSettings from './HookSettings';
import ApiKeySettings from './ApiKeySettings';
import TranslationSettings from './TranslationSettings';

import ShortcutSettings from './ShortcutSettings';
import headerStyles from '@/styles/modules/Header.module.css';
import styles from '@/styles/modules/Settings.module.css';

type SettingsTab = 'appearance' | 'sound' | 'hooks' | 'apikeys' | 'translation' | 'shortcuts' | 'advanced';

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'appearance', label: 'APPEARANCE' },
  { id: 'sound', label: 'SOUND' },
  { id: 'hooks', label: 'HOOKS' },
  { id: 'apikeys', label: 'API KEYS' },
  { id: 'translation', label: 'TRANSLATION' },
  { id: 'shortcuts', label: 'SHORTCUTS' },
  { id: 'advanced', label: 'ADVANCED' },
];

export default function SettingsPanel() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');
  const autosaveVisible = useSettingsStore((s) => s.autosaveVisible);
  const resetDefaults = useSettingsStore((s) => s.resetDefaults);
  const importFileRef = useRef<HTMLInputElement>(null);

  function handleExport() {
    const state = useSettingsStore.getState();
    const exportData: Record<string, unknown> = {};
    const skipKeys = new Set([
      'loadFromDb', 'saveToDb', 'updateSoundSettings', 'updateLabelAlarms',
      'setThemeName', 'setTheme', 'setFontSize', 'setScanlineEnabled',
      'setAnimationIntensity', 'setAnimationSpeed', 'setCharacterModel',
      'setHookDensity', 'setCompactMode', 'setShowArchived', 'setGroupBy',
      'setSortBy', 'setToastEnabled',
      'setAutoSendQueue', 'setDefaultTerminalTheme', 'setSoundAction',
      'setMovementAction', 'setApiKey', 'persistSetting',
      'flashAutosave', 'resetDefaults', 'autosaveVisible',
    ]);
    for (const [key, value] of Object.entries(state)) {
      if (!skipKeys.has(key) && typeof value !== 'function') {
        exportData[key] = value;
      }
    }
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'claude-dashboard-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(file: File) {
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      const state = useSettingsStore.getState();
      state.loadFromDb(imported);
      // Persist each imported setting
      for (const [key, value] of Object.entries(imported)) {
        if (typeof value !== 'function') {
          await state.persistSetting(
            key,
            typeof value === 'object' ? JSON.stringify(value) : value,
          );
        }
      }
    } catch {
      // Import failed silently
    }
  }

  return (
    <Modal modalId="settings" title="Settings" panelClassName={styles.settingsModal}>
      <div className={styles.panel}>
        {/* Autosave indicator */}
        <div
          className={`${styles.autosaveIndicator}${autosaveVisible ? ` ${styles.visible}` : ''}`}
          style={{ marginBottom: '8px' }}
        >
          SAVED
        </div>

        {/* Tab Navigation */}
        <div className={styles.tabs}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`${styles.tab}${activeTab === tab.id ? ` ${styles.active}` : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div style={{ padding: '16px 0', overflowY: 'auto', maxHeight: '72vh' }}>
          {activeTab === 'appearance' && <ThemeSettings />}
          {activeTab === 'sound' && <SoundSettings />}
          {activeTab === 'hooks' && <HookSettings />}
          {activeTab === 'apikeys' && <ApiKeySettings />}
          {activeTab === 'translation' && <TranslationSettings />}
          {activeTab === 'shortcuts' && <ShortcutSettings />}
          {activeTab === 'advanced' && (
            <AdvancedSettings
              onExport={handleExport}
              onImportClick={() => importFileRef.current?.click()}
              onReset={resetDefaults}
            />
          )}
        </div>

        {/* Hidden file input for import */}
        <input
          ref={importFileRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImport(file);
            e.target.value = '';
          }}
        />
      </div>
    </Modal>
  );
}

// Settings gear button to trigger the modal
export function SettingsButton() {
  const openModal = useUiStore((s) => s.openModal);

  return (
    <button
      onClick={() => openModal('settings')}
      title="Settings"
      className={headerStyles.headerIconBtn}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button>
  );
}

// ── Terminal scrollback replay buffer control ──
const BYTES_PER_MB = 1024 * 1024;
const BUFFER_PRESETS_MB = [1, 2, 5, 10, 20];
const BUFFER_MIN_MB = 0.25;
const BUFFER_MAX_MB = 32;

/** Format an MB value without trailing zeros: 2 → "2", 0.25 → "0.25". */
function formatMb(mb: number): string {
  return String(Math.round(mb * 100) / 100);
}

function TerminalBufferControl() {
  const bytes = useSettingsStore((s) => s.terminalReplayBufferBytes);
  const setBytes = useSettingsStore((s) => s.setTerminalReplayBufferBytes);
  const currentMb = bytes / BYTES_PER_MB;

  // Local draft so the user can type freely; commit (with clamp) on blur/Enter.
  const [draft, setDraft] = useState(() => formatMb(currentMb));
  // Re-sync the draft whenever the stored (clamped) value changes — covers
  // preset clicks, Reset to Defaults, and clamp-on-commit.
  useEffect(() => {
    setDraft(formatMb(bytes / BYTES_PER_MB));
  }, [bytes]);

  const commitDraft = (value: string) => {
    const mb = parseFloat(value);
    if (!Number.isFinite(mb)) {
      setDraft(formatMb(bytes / BYTES_PER_MB)); // revert non-numeric
      return;
    }
    setBytes(mb * BYTES_PER_MB); // store clamps; effect re-syncs the draft
  };

  return (
    <div className={styles.section}>
      <h4>Terminal</h4>
      <p className={styles.settingsHint}>
        Scrollback replay buffer — how much history is restored when a terminal
        reconnects, the app reloads, or a session resumes. Larger means deeper
        scroll-up, but more memory per terminal.
      </p>
      <div className={styles.bufferRow}>
        <input
          className={styles.bufferInput}
          type="number"
          min={BUFFER_MIN_MB}
          max={BUFFER_MAX_MB}
          step={0.25}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commitDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          aria-label="Terminal scrollback replay buffer size in megabytes"
        />
        <span className={styles.bufferUnit}>MB</span>
      </div>
      <div className={styles.bufferPresets}>
        {BUFFER_PRESETS_MB.map((mb) => {
          const active = Math.abs(currentMb - mb) < 0.001;
          return (
            <button
              key={mb}
              type="button"
              className={`${styles.bufferPreset}${active ? ` ${styles.bufferPresetActive}` : ''}`}
              onClick={() => setBytes(mb * BYTES_PER_MB)}
            >
              {mb} MB
            </button>
          );
        })}
      </div>
      <p className={styles.settingsHint}>
        Applies to newly created terminals. Range {BUFFER_MIN_MB}–{BUFFER_MAX_MB} MB.
      </p>
    </div>
  );
}

// Advanced settings sub-tab
function AdvancedSettings({
  onExport,
  onImportClick,
  onReset,
}: {
  onExport: () => void;
  onImportClick: () => void;
  onReset: () => void;
}) {
  return (
    <div>
      <TerminalBufferControl />

      <div className={styles.section}>
        <h4>Import / Export</h4>
        <p className={styles.settingsHint}>
          Export all settings to a JSON file, or import settings from a previously exported file.
        </p>
        <div className={styles.advancedActions}>
          <button className={styles.fontBtn} onClick={onExport}>
            Export Settings
          </button>
          <button className={styles.fontBtn} onClick={onImportClick}>
            Import Settings
          </button>
        </div>
      </div>

      <div className={styles.section}>
        <h4>Reset</h4>
        <p className={styles.settingsHint}>
          Reset all settings to their default values. This cannot be undone.
        </p>
        <button
          className={styles.fontBtn}
          style={{ color: 'var(--accent-red)', borderColor: 'var(--accent-red)' }}
          onClick={onReset}
        >
          Reset to Defaults
        </button>
      </div>
    </div>
  );
}

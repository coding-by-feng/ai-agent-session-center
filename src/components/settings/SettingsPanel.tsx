import { useState, useRef } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import Modal from '@/components/ui/Modal';
import ThemeSettings from './ThemeSettings';
import SoundSettings from './SoundSettings';
import HookSettings from './HookSettings';
import ApiKeySettings from './ApiKeySettings';
import SummaryPromptSettings from './SummaryPromptSettings';
import styles from '@/styles/modules/Settings.module.css';

type SettingsTab = 'appearance' | 'sound' | 'hooks' | 'apikeys' | 'advanced';

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'appearance', label: 'APPEARANCE' },
  { id: 'sound', label: 'SOUND' },
  { id: 'hooks', label: 'HOOKS' },
  { id: 'apikeys', label: 'API KEYS' },
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
      'setSortBy', 'setActivityFeedVisible', 'setToastEnabled',
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
    <Modal modalId="settings" title="Settings">
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
        <div style={{ padding: '16px 0', overflowY: 'auto', maxHeight: '55vh' }}>
          {activeTab === 'appearance' && <ThemeSettings />}
          {activeTab === 'sound' && <SoundSettings />}
          {activeTab === 'hooks' && <HookSettings />}
          {activeTab === 'apikeys' && <ApiKeySettings />}
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
      style={{
        background: 'none',
        border: '1px solid var(--border-subtle)',
        color: 'var(--text-secondary)',
        fontSize: '18px',
        cursor: 'pointer',
        padding: '4px 10px',
        borderRadius: '4px',
        transition: 'all 0.2s',
        marginLeft: '8px',
      }}
    >
      &#9881;
    </button>
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
      <div className={styles.section}>
        <h4>Summary Prompts</h4>
        <SummaryPromptSettings />
      </div>

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

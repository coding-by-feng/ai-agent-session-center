import { useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import styles from '@/styles/modules/Settings.module.css';

interface ApiKeyFieldProps {
  label: string;
  provider: 'anthropic' | 'openai' | 'gemini';
  placeholder: string;
}

function ApiKeyField({ label, provider, placeholder }: ApiKeyFieldProps) {
  const fieldMap = {
    anthropic: 'anthropicApiKey',
    openai: 'openaiApiKey',
    gemini: 'geminiApiKey',
  } as const;

  const value = useSettingsStore((s) => s[fieldMap[provider]]);
  const setApiKey = useSettingsStore((s) => s.setApiKey);

  const [showKey, setShowKey] = useState(false);
  const [localValue, setLocalValue] = useState(value);
  const [statusText, setStatusText] = useState(value ? 'Key saved in browser' : '');
  const [statusColor, setStatusColor] = useState('');

  function handleSave() {
    const trimmed = localValue.trim();
    setApiKey(provider, trimmed);
    if (trimmed) {
      setStatusText('Saved');
      setStatusColor('var(--accent-green, #4caf50)');
    } else {
      setStatusText('Cleared');
      setStatusColor('var(--text-dim)');
    }
    setTimeout(() => {
      setStatusText(trimmed ? 'Key saved in browser' : '');
      setStatusColor('');
    }, 2000);
  }

  return (
    <div className={styles.section}>
      <h4>{label}</h4>
      <div className={styles.apiKeyRow}>
        <input
          type={showKey ? 'text' : 'password'}
          className={styles.apiKeyInput}
          placeholder={placeholder}
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
        />
        <button
          className={styles.apiKeyToggle}
          onClick={() => setShowKey(!showKey)}
        >
          {showKey ? 'HIDE' : 'SHOW'}
        </button>
        <button className={styles.fontBtn} onClick={handleSave}>
          Save
        </button>
      </div>
      {statusText && (
        <div
          style={{
            fontSize: '10px',
            color: statusColor || 'var(--text-dim)',
            marginTop: '4px',
          }}
        >
          {statusText}
        </div>
      )}
    </div>
  );
}

export default function ApiKeySettings() {
  return (
    <div>
      <p className={styles.settingsHint}>
        API keys are stored in your browser only (IndexedDB). They are never sent to the server
        except when explicitly used for summarization or AI features.
      </p>
      <ApiKeyField
        label="Anthropic API Key"
        provider="anthropic"
        placeholder="sk-ant-..."
      />
      <ApiKeyField
        label="OpenAI API Key"
        provider="openai"
        placeholder="sk-..."
      />
      <ApiKeyField
        label="Google (Gemini) API Key"
        provider="gemini"
        placeholder="AI..."
      />
    </div>
  );
}

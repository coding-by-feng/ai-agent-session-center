/**
 * LabelChips renders quick-select label chips (ONEOFF, HEAVY, IMPORTANT)
 * in the detail panel. Clicking a chip assigns/toggles the label.
 * Ported from populateDetailLabelChips in public/js/sessionControls.js.
 */
import { useState, useCallback } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { showToast } from '@/components/ui/ToastContainer';

const BUILTIN_LABELS = ['ONEOFF', 'HEAVY', 'IMPORTANT'] as const;

const LABEL_COLORS: Record<string, string> = {
  ONEOFF: '#ff9100',
  HEAVY: '#ff3355',
  IMPORTANT: '#aa66ff',
};

const LABELS_STORAGE_KEY = 'session-labels';

function loadCustomLabels(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(LABELS_STORAGE_KEY) || '[]') as string[];
    return saved.filter((l) => !BUILTIN_LABELS.includes(l as typeof BUILTIN_LABELS[number])).slice(0, 5);
  } catch {
    return [];
  }
}

function saveLabel(label: string): void {
  try {
    const labels = JSON.parse(localStorage.getItem(LABELS_STORAGE_KEY) || '[]') as string[];
    const idx = labels.indexOf(label);
    if (idx !== -1) labels.splice(idx, 1);
    labels.unshift(label);
    localStorage.setItem(LABELS_STORAGE_KEY, JSON.stringify(labels.slice(0, 30)));
  } catch {
    // ignore
  }
}

interface LabelChipsProps {
  sessionId: string;
  currentLabel: string;
}

export default function LabelChips({ sessionId, currentLabel }: LabelChipsProps) {
  const updateSession = useSessionStore((s) => s.updateSession);
  const sessions = useSessionStore((s) => s.sessions);
  const [activeLabel, setActiveLabel] = useState(currentLabel);

  const customLabels = loadCustomLabels();
  const allLabels: string[] = [...BUILTIN_LABELS, ...customLabels];

  const handleChipClick = useCallback(
    async (label: string) => {
      const newLabel = activeLabel === label ? '' : label;
      setActiveLabel(newLabel);

      // Update session in store
      const session = sessions.get(sessionId);
      if (session) {
        updateSession({ ...session, label: newLabel });
      }

      // Persist to server — #7: rollback on failure
      try {
        const resp = await fetch(`/api/sessions/${sessionId}/label`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newLabel }),
        });
        if (!resp.ok) throw new Error('Server error');
      } catch {
        // Rollback local state on server error
        setActiveLabel(activeLabel === label ? label : activeLabel);
        const session = sessions.get(sessionId);
        if (session) {
          updateSession({ ...session, label: activeLabel === label ? label : activeLabel });
        }
        showToast('Failed to save label', 'error');
      }

      // Track label usage
      if (newLabel) {
        saveLabel(newLabel);
      }
    },
    [sessionId, activeLabel, sessions, updateSession],
  );

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
      {allLabels.map((label) => {
        const isActive = label === activeLabel;
        const color = LABEL_COLORS[label] || 'var(--text-secondary)';
        return (
          <button
            key={label}
            onClick={() => handleChipClick(label)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              background: isActive ? `${color}1a` : 'transparent',
              border: `1px solid ${isActive ? color : 'var(--border-subtle)'}`,
              color: isActive ? color : 'var(--text-dim)',
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              fontWeight: 600,
              letterSpacing: '0.5px',
              padding: '3px 8px',
              borderRadius: '10px',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

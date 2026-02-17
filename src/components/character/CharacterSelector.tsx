/**
 * CharacterSelector shows a grid picker for choosing a character model.
 * Used in settings and per-session character selection.
 * Ported from the character selector logic in public/js/robotManager.js.
 */
import { useCallback } from 'react';
import CharacterModel, {
  CHARACTER_MODEL_NAMES,
  type CharacterModelName,
} from './CharacterModel';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface CharacterSelectorProps {
  selected: CharacterModelName;
  onSelect: (model: CharacterModelName) => void;
  /** Show a compact grid (smaller previews) */
  compact?: boolean;
}

export default function CharacterSelector({
  selected,
  onSelect,
  compact = false,
}: CharacterSelectorProps) {
  const handleSelect = useCallback(
    (model: CharacterModelName) => {
      onSelect(model);
    },
    [onSelect],
  );

  const size = compact ? 60 : 90;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${size + 20}px, 1fr))`,
        gap: '8px',
        padding: '8px',
      }}
    >
      {CHARACTER_MODEL_NAMES.map((model) => (
        <button
          key={model}
          onClick={() => handleSelect(model)}
          title={model.charAt(0).toUpperCase() + model.slice(1)}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '4px',
            padding: '8px',
            border:
              selected === model
                ? '2px solid var(--accent-cyan, #00e5ff)'
                : '1px solid var(--border-subtle, #222)',
            borderRadius: '8px',
            background:
              selected === model
                ? 'rgba(0, 229, 255, 0.08)'
                : 'var(--bg-card, #12122a)',
            cursor: 'pointer',
            transition: 'border-color 0.2s, background 0.2s',
          }}
        >
          <div
            style={{
              width: `${size}px`,
              height: `${size}px`,
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transform: compact ? 'scale(0.5)' : 'scale(0.6)',
              transformOrigin: 'center center',
            }}
          >
            <CharacterModel model={model} status="idle" />
          </div>
          <span
            style={{
              fontSize: '10px',
              fontFamily: 'var(--font-mono, monospace)',
              color:
                selected === model
                  ? 'var(--accent-cyan, #00e5ff)'
                  : 'var(--text-dim, #666)',
              textTransform: 'capitalize',
            }}
          >
            {model}
          </span>
        </button>
      ))}
    </div>
  );
}

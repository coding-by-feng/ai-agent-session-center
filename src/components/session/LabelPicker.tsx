/**
 * LabelPicker — anchored popover for assigning a single label to a session.
 *
 * Client-only: reads/writes `useLabelStore` (localStorage-backed). Shows
 * built-in + custom labels as clickable colored chips (clicking sets the
 * session's label; clicking the active one clears it), a "Clear label"
 * action, and an "add custom" row (name input + preset color swatches).
 *
 * Mirrors FileOpenChooser for the portal / click-outside / Esc /
 * viewport-clamp pattern.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from '@/hooks/useClickOutside';
import {
  useLabelStore,
  BUILTIN_LABELS,
  DEFAULT_LABEL_COLOR,
  type CustomLabel,
} from '@/stores/labelStore';
import styles from '@/styles/modules/LabelPicker.module.css';

const POPUP_W = 248;
const POPUP_H = 320; // approximate; used only for viewport clamping
const VIEWPORT_MARGIN = 12;

/** Preset swatches offered when creating a custom label. */
const SWATCHES: ReadonlyArray<string> = [
  '#ff9100',
  '#ff3355',
  '#aa66ff',
  '#00e5ff',
  '#36d399',
  '#ffd166',
  '#ff69b4',
  '#7aa2ff',
];

function clampToViewport(x: number, y: number): { x: number; y: number } {
  if (typeof window === 'undefined') return { x, y };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(VIEWPORT_MARGIN, Math.min(vw - POPUP_W - VIEWPORT_MARGIN, x)),
    y: Math.max(VIEWPORT_MARGIN, Math.min(vh - POPUP_H - VIEWPORT_MARGIN, y)),
  };
}

/** Convert a hex color to an rgba() string with the given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(122, 162, 255, ${alpha})`;
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface LabelChipProps {
  name: string;
  color: string;
  /** Small read-only variant used in the strip session chips. */
  small?: boolean;
  className?: string;
}

/** Renders a label name with its color (colored text + faint colored bg/border). */
export function LabelChip({ name, color, small, className }: LabelChipProps) {
  return (
    <span
      className={`${styles.chip}${small ? ` ${styles.chipSmall}` : ''}${className ? ` ${className}` : ''}`}
      style={{
        color,
        borderColor: hexToRgba(color, 0.55),
        background: hexToRgba(color, 0.14),
      }}
      title={name}
    >
      {name}
    </span>
  );
}

export interface LabelPickerProps {
  sessionId: string;
  /** Screen-space anchor point (e.g. the tag button's bottom-left). */
  anchor: { x: number; y: number };
  onClose: () => void;
}

export default function LabelPicker({ sessionId, anchor, onClose }: LabelPickerProps) {
  const labels = useLabelStore((s) => s.labels);
  const custom = useLabelStore((s) => s.custom);
  const setLabel = useLabelStore((s) => s.setLabel);
  const addCustom = useLabelStore((s) => s.addCustom);
  const removeCustom = useLabelStore((s) => s.removeCustom);

  const active = labels[sessionId];
  const popupRef = useRef<HTMLDivElement>(null);

  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>(SWATCHES[0]);

  useClickOutside(popupRef, onClose, true);

  // Esc closes; focus the popup on open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    popupRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const handlePick = useCallback(
    (name: string) => {
      setLabel(sessionId, active === name ? null : name);
    },
    [setLabel, sessionId, active],
  );

  const handleClear = useCallback(() => {
    setLabel(sessionId, null);
  }, [setLabel, sessionId]);

  const handleAdd = useCallback(() => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    addCustom(trimmed, newColor);
    setLabel(sessionId, trimmed);
    setNewName('');
  }, [newName, newColor, addCustom, setLabel, sessionId]);

  const handleRemoveCustom = useCallback(
    (e: React.MouseEvent, name: string) => {
      e.stopPropagation();
      if (active === name) setLabel(sessionId, null);
      removeCustom(name);
    },
    [removeCustom, setLabel, sessionId, active],
  );

  const pos = clampToViewport(anchor.x, anchor.y + 6);

  const renderChip = (l: CustomLabel, removable: boolean) => {
    const isActive = active === l.name;
    return (
      <span key={l.name} className={styles.chipWrap}>
        <button
          type="button"
          className={`${styles.optionChip}${isActive ? ` ${styles.optionChipActive}` : ''}`}
          style={{
            color: l.color,
            borderColor: hexToRgba(l.color, isActive ? 0.85 : 0.5),
            background: hexToRgba(l.color, isActive ? 0.22 : 0.1),
          }}
          onClick={() => handlePick(l.name)}
          title={isActive ? `Clear "${l.name}"` : `Set label "${l.name}"`}
        >
          {l.name}
        </button>
        {removable && (
          <button
            type="button"
            className={styles.removeCustom}
            onClick={(e) => handleRemoveCustom(e, l.name)}
            title={`Delete custom label "${l.name}"`}
            aria-label={`Delete custom label ${l.name}`}
          >
            &times;
          </button>
        )}
      </span>
    );
  };

  return createPortal(
    <div
      ref={popupRef}
      className={styles.popup}
      style={{ left: pos.x, top: pos.y, width: POPUP_W }}
      role="dialog"
      aria-label="Session label"
      tabIndex={-1}
    >
      <div className={styles.header}>Session label</div>

      <div className={styles.chips}>
        {BUILTIN_LABELS.map((l) => renderChip(l, false))}
        {custom.map((l) => renderChip(l, true))}
      </div>

      <button
        type="button"
        className={styles.clear}
        onClick={handleClear}
        disabled={!active}
      >
        Clear label
      </button>

      <div className={styles.divider} />

      <div className={styles.addRow}>
        <input
          className={styles.nameInput}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="New label name"
          maxLength={24}
          aria-label="New custom label name"
        />
        <button
          type="button"
          className={styles.addBtn}
          onClick={handleAdd}
          disabled={!newName.trim()}
        >
          Add
        </button>
      </div>

      <div className={styles.swatches} role="radiogroup" aria-label="Label color">
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            className={`${styles.swatch}${newColor === c ? ` ${styles.swatchActive}` : ''}`}
            style={{ background: c, borderColor: newColor === c ? c : hexToRgba(c, 0.4) }}
            onClick={() => setNewColor(c)}
            title={c}
            aria-label={`Color ${c}`}
            aria-checked={newColor === c}
            role="radio"
          />
        ))}
      </div>

      {newName.trim() && (
        <div className={styles.preview}>
          <span className={styles.previewLabel}>Preview:</span>
          <LabelChip name={newName.trim()} color={newColor || DEFAULT_LABEL_COLOR} />
        </div>
      )}
    </div>,
    document.body,
  );
}

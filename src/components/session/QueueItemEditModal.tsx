/**
 * QueueItemEditModal — three-pane editor for a Loop or Schedule queue item:
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ Type / interval / runAt selector                          │
 *   │                                                            │
 *   │ BEFORE chain (steps that run before the main prompt)      │
 *   │   ▸ /context           [↑][↓][✕]                          │
 *   │   ▸ check git status   [↑][↓][✕]                          │
 *   │   [+ Add before-step]                                      │
 *   │                                                            │
 *   │ MAIN prompt (required)                                     │
 *   │   ┌─────────────────────────────────────────────────┐     │
 *   │   │ analyze recent commits and summarize             │     │
 *   │   └─────────────────────────────────────────────────┘     │
 *   │                                                            │
 *   │ AFTER chain (steps that run after the main prompt)        │
 *   │   ▸ /compact           [↑][↓][✕]                          │
 *   │   [+ Add after-step]                                       │
 *   │                                                            │
 *   │   [Delete item]            [Cancel]    [Save]              │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Renders as a self-contained overlay (not using the global Modal store) so
 * QueueTab can carry per-item state in its own component scope.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { QueueItem, ChainStep, ExcludeWindow, QueueItemType } from '@/stores/queueStore';
import TimePicker12 from '@/components/ui/TimePicker12';
import styles from '@/styles/modules/Terminal.module.css';

interface QueueItemEditModalProps {
  item: QueueItem;
  onClose: () => void;
  onSave: (patch: Partial<QueueItem>) => void;
  onDelete: () => void;
  /** Whether Auto-send is currently enabled on the parent session. When OFF,
   *  Loop and Schedule types are disabled because they wouldn't fire. */
  autoSendEnabled: boolean;
  /** Header text. Defaults to "Edit queue item". The history sheet passes
   *  "Edit history entry" so the title reflects what's being modified. */
  title?: string;
}

let nextStepId = Date.now();
function newStepId(): number {
  return nextStepId++;
}

/** Convert an item's intervalMs into the (value, unit) tuple used by the form. */
function splitInterval(ms: number | undefined): { value: number; unit: 'sec' | 'min' | 'hour' } {
  if (!ms || ms <= 0) return { value: 10, unit: 'min' };
  if (ms % 3_600_000 === 0) return { value: ms / 3_600_000, unit: 'hour' };
  if (ms % 60_000 === 0) return { value: ms / 60_000, unit: 'min' };
  return { value: Math.max(1, Math.round(ms / 1000)), unit: 'sec' };
}

/** Convert a unix-ms timestamp into the <input type="datetime-local"> string format. */
function toDatetimeLocal(ms: number | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function QueueItemEditModal({
  item,
  onClose,
  onSave,
  onDelete,
  autoSendEnabled,
  title = 'Edit queue item',
}: QueueItemEditModalProps) {
  // ---- Form state (initialized from the item, edited locally) -----------
  const [type, setType] = useState<QueueItemType>(item.type ?? 'once');
  const initialInterval = splitInterval(item.intervalMs);
  const [intervalValue, setIntervalValue] = useState<number>(initialInterval.value);
  const [intervalUnit, setIntervalUnit] = useState<'sec' | 'min' | 'hour'>(initialInterval.unit);
  const [runAt, setRunAt] = useState<string>(toDatetimeLocal(item.runAt));
  const [mainText, setMainText] = useState<string>(item.text);
  const [beforeChain, setBeforeChain] = useState<ChainStep[]>(
    (item.beforeChain ?? []).map((s) => ({ ...s })),
  );
  const [afterChain, setAfterChain] = useState<ChainStep[]>(
    (item.afterChain ?? []).map((s) => ({ ...s })),
  );
  /** Time-of-day exclusion windows — only used for type='loop'. */
  const [excludeWindows, setExcludeWindows] = useState<ExcludeWindow[]>(
    (item.excludeWindows ?? []).map((w) => ({ ...w })),
  );
  /** Daily start-time clamp — loop only. Empty string = no clamp. */
  const [firstFireOfDay, setFirstFireOfDay] = useState<string | undefined>(
    item.firstFireOfDay,
  );

  const overlayRef = useRef<HTMLDivElement>(null);

  // ESC to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  // ---- Chain step manipulation (immutable updates) ----------------------
  const addStep = (which: 'before' | 'after') => {
    const setter = which === 'before' ? setBeforeChain : setAfterChain;
    setter((prev) => [...prev, { id: newStepId(), text: '' }]);
  };
  const updateStep = (which: 'before' | 'after', stepId: number, text: string) => {
    const setter = which === 'before' ? setBeforeChain : setAfterChain;
    setter((prev) => prev.map((s) => (s.id === stepId ? { ...s, text } : s)));
  };
  const removeStep = (which: 'before' | 'after', stepId: number) => {
    const setter = which === 'before' ? setBeforeChain : setAfterChain;
    setter((prev) => prev.filter((s) => s.id !== stepId));
  };
  const moveStep = (which: 'before' | 'after', stepId: number, delta: -1 | 1) => {
    const setter = which === 'before' ? setBeforeChain : setAfterChain;
    setter((prev) => {
      const idx = prev.findIndex((s) => s.id === stepId);
      const newIdx = idx + delta;
      if (idx < 0 || newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(idx, 1);
      next.splice(newIdx, 0, moved);
      return next;
    });
  };

  // ---- Exclude-window manipulation (loops only) ------------------------
  const addExcludeWindow = () => {
    setExcludeWindows((prev) => [
      ...prev,
      { id: newStepId(), startHHMM: '00:00', endHHMM: '09:00' },
    ]);
  };
  const updateExcludeWindow = (
    id: number,
    field: 'startHHMM' | 'endHHMM',
    value: string,
  ) => {
    setExcludeWindows((prev) =>
      prev.map((w) => (w.id === id ? { ...w, [field]: value } : w)),
    );
  };
  const removeExcludeWindow = (id: number) => {
    setExcludeWindows((prev) => prev.filter((w) => w.id !== id));
  };

  // ---- Save handler ----------------------------------------------------
  const handleSave = () => {
    const trimmedMain = mainText.trim();
    if (!trimmedMain) {
      // Main prompt is required — skip save (HTML5 validation also catches this)
      return;
    }
    // Filter out empty chain steps so the user doesn't accidentally fire blanks.
    const cleanBefore = beforeChain
      .map((s) => ({ ...s, text: s.text.trim() }))
      .filter((s) => s.text.length > 0);
    const cleanAfter = afterChain
      .map((s) => ({ ...s, text: s.text.trim() }))
      .filter((s) => s.text.length > 0);

    const patch: Partial<QueueItem> = {
      type,
      text: trimmedMain,
      beforeChain: cleanBefore.length > 0 ? cleanBefore : undefined,
      afterChain: cleanAfter.length > 0 ? cleanAfter : undefined,
    };

    // Type-specific scheduling fields.
    if (type === 'loop') {
      const unitMs =
        intervalUnit === 'sec' ? 1000 : intervalUnit === 'min' ? 60_000 : 3_600_000;
      const intervalMs = Math.max(1, intervalValue) * unitMs;
      patch.intervalMs = intervalMs;
      // Preserve existing nextFireAt if it's still ahead; otherwise reset.
      if (!item.nextFireAt || item.nextFireAt < Date.now()) {
        patch.nextFireAt = Date.now() + intervalMs;
      }
      patch.runAt = undefined;
      // Persist exclude windows (drop empty/invalid rows).
      const cleanWindows = excludeWindows.filter(
        (w) => w.startHHMM && w.endHHMM && w.startHHMM !== w.endHHMM,
      );
      patch.excludeWindows = cleanWindows.length > 0 ? cleanWindows : undefined;
      patch.firstFireOfDay = firstFireOfDay || undefined;
    } else if (type === 'schedule') {
      const parsed = runAt ? Date.parse(runAt) : NaN;
      const runAtMs = Number.isNaN(parsed) ? Date.now() + 60_000 : parsed;
      patch.runAt = runAtMs;
      patch.nextFireAt = runAtMs;
      patch.intervalMs = undefined;
      // Schedule items ignore the daily clamp by design (they have an explicit runAt).
      patch.firstFireOfDay = undefined;
    } else {
      // 'once' — clear timing fields, force priority sort to 0. We deliberately
      // do NOT clear excludeWindows here so the user can flip type back to
      // 'loop' later without losing their configured pause hours.
      patch.intervalMs = undefined;
      patch.runAt = undefined;
      patch.nextFireAt = 0;
      patch.firstFireOfDay = undefined;
    }

    onSave(patch);
    onClose();
  };

  const renderChainList = (
    which: 'before' | 'after',
    chain: ChainStep[],
    label: string,
    hint: string,
  ) => (
    <div className={styles.chainSection}>
      <div className={styles.chainSectionHeader}>
        <span className={styles.chainSectionLabel}>{label}</span>
        <span className={styles.chainSectionHint}>{hint}</span>
      </div>
      {chain.length === 0 ? (
        <div className={styles.chainEmpty}>No steps yet.</div>
      ) : (
        chain.map((step, idx) => (
          <div key={step.id} className={styles.chainStepRow}>
            <span className={styles.chainStepIdx}>{idx + 1}</span>
            <textarea
              className={styles.chainStepTextarea}
              value={step.text}
              onChange={(e) => updateStep(which, step.id, e.target.value)}
              placeholder={which === 'before' ? 'Run before main…' : 'Run after main…'}
              rows={1}
            />
            <button
              className={styles.chainStepBtn}
              onClick={() => moveStep(which, step.id, -1)}
              disabled={idx === 0}
              title="Move up"
            >
              ↑
            </button>
            <button
              className={styles.chainStepBtn}
              onClick={() => moveStep(which, step.id, 1)}
              disabled={idx === chain.length - 1}
              title="Move down"
            >
              ↓
            </button>
            <button
              className={`${styles.chainStepBtn} ${styles.chainStepDel}`}
              onClick={() => removeStep(which, step.id)}
              title="Delete step"
            >
              ✕
            </button>
          </div>
        ))
      )}
      <button className={styles.chainAddBtn} onClick={() => addStep(which)}>
        + Add {which}-step
      </button>
    </div>
  );

  return (
    <div ref={overlayRef} className={styles.chainModalOverlay} onClick={handleOverlayClick}>
      <div className={styles.chainModalPanel} role="dialog" aria-modal="true">
        <div className={styles.chainModalHeader}>
          <h3>{title}</h3>
          <button className={styles.chainCloseBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.chainModalBody}>
          {/* Type selector */}
          <div className={styles.chainTypeRow}>
            <span className={styles.chainTypeLabel}>Type</span>
            <div className={styles.queueTypePills}>
              {(['once', 'loop', 'schedule'] as QueueItemType[]).map((t) => {
                const disabled = !autoSendEnabled && t !== 'once';
                return (
                  <button
                    key={t}
                    className={`${styles.queueTypePill}${type === t ? ` ${styles.queueTypePillActive}` : ''}${disabled ? ` ${styles.queueTypePillDisabled}` : ''}`}
                    onClick={() => { if (!disabled) setType(t); }}
                    disabled={disabled}
                    title={disabled ? 'Auto-send is OFF — enable it on the queue header to use this mode' : undefined}
                  >
                    {t === 'once' ? '★ Once' : t === 'loop' ? '⟳ Loop' : '🕐 Schedule'}
                  </button>
                );
              })}
            </div>
            {type === 'loop' && (
              <span className={styles.queueIntervalGroup}>
                every
                <input
                  type="number"
                  min={1}
                  className={styles.queueIntervalInput}
                  value={intervalValue}
                  onChange={(e) => setIntervalValue(Math.max(1, Number(e.target.value) || 1))}
                />
                <select
                  className={styles.queueIntervalUnit}
                  value={intervalUnit}
                  onChange={(e) => setIntervalUnit(e.target.value as 'sec' | 'min' | 'hour')}
                >
                  <option value="sec">sec</option>
                  <option value="min">min</option>
                  <option value="hour">hour</option>
                </select>
                <span
                  className={styles.dailyStartLabel}
                  title="Optional. When set, this loop won't fire before this local clock time on any given day."
                >
                  first fire each day
                </span>
                <TimePicker12
                  value={firstFireOfDay}
                  onChange={(next) => setFirstFireOfDay(next)}
                  allowEmpty
                  ariaLabel="First fire of day"
                />
              </span>
            )}
            {type === 'schedule' && (
              <span className={styles.queueScheduleGroup}>
                at
                <input
                  type="datetime-local"
                  className={styles.queueScheduleInput}
                  value={runAt}
                  onChange={(e) => setRunAt(e.target.value)}
                />
              </span>
            )}
          </div>

          {/* Before chain (only for loop / schedule — once has no chain) */}
          {type !== 'once' &&
            renderChainList('before', beforeChain, 'BEFORE chain', 'Runs first, in order')}

          {/* Main prompt */}
          <div className={styles.chainSection}>
            <div className={styles.chainSectionHeader}>
              <span className={styles.chainSectionLabel}>MAIN prompt</span>
              <span className={styles.chainSectionHint}>Required</span>
            </div>
            <textarea
              className={styles.chainMainTextarea}
              value={mainText}
              onChange={(e) => setMainText(e.target.value)}
              placeholder="What should this trigger send to the session?"
              rows={3}
              autoFocus
            />
          </div>

          {/* After chain */}
          {type !== 'once' &&
            renderChainList('after', afterChain, 'AFTER chain', 'Runs last, in order')}

          {/* Exclude windows — loop only. Each row defines a time-of-day
              range where the loop is paused (in local time). Multiple rows
              are OR'd. Windows that cross midnight (start > end) are
              supported. */}
          {type === 'loop' && (
            <div className={styles.chainSection}>
              <div className={styles.chainSectionHeader}>
                <span className={styles.chainSectionLabel}>EXCLUDE WINDOWS</span>
                <span className={styles.chainSectionHint}>
                  Don&apos;t fire during these time ranges (local time) — adds to the session&apos;s quiet hours.
                </span>
              </div>
              {excludeWindows.length === 0 ? (
                <div className={styles.chainEmpty}>No exclusions — loop runs 24/7.</div>
              ) : (
                excludeWindows.map((w) => {
                  const wraps = w.startHHMM && w.endHHMM && w.startHHMM > w.endHHMM;
                  const invalid = w.startHHMM === w.endHHMM;
                  return (
                    <div key={w.id} className={styles.excludeWindowRow}>
                      <TimePicker12
                        value={w.startHHMM || '00:00'}
                        onChange={(next) =>
                          updateExcludeWindow(w.id, 'startHHMM', next ?? '00:00')
                        }
                        ariaLabel="Window start"
                      />
                      <span className={styles.excludeWindowArrow}>→</span>
                      <TimePicker12
                        value={w.endHHMM || '00:00'}
                        onChange={(next) =>
                          updateExcludeWindow(w.id, 'endHHMM', next ?? '00:00')
                        }
                        ariaLabel="Window end"
                      />
                      {wraps && (
                        <span className={styles.excludeWindowHint} title="Wraps past midnight">
                          ↺ overnight
                        </span>
                      )}
                      {invalid && (
                        <span
                          className={styles.excludeWindowInvalid}
                          title="Start and end are equal — this window will be ignored"
                        >
                          ⚠ invalid
                        </span>
                      )}
                      <button
                        className={`${styles.chainStepBtn} ${styles.chainStepDel}`}
                        onClick={() => removeExcludeWindow(w.id)}
                        title="Delete window"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })
              )}
              <button className={styles.chainAddBtn} onClick={addExcludeWindow}>
                + Add exclusion window
              </button>
            </div>
          )}

          {/* Stats footer */}
          {((item.totalFires ?? 0) > 0 || item.lastFiredAt) && (
            <div className={styles.chainStats}>
              {item.totalFires ? `Fires: ${item.totalFires}` : ''}
              {item.lastFiredAt
                ? `  ·  Last fired: ${new Date(item.lastFiredAt).toLocaleString()}`
                : ''}
            </div>
          )}
        </div>

        <div className={styles.chainModalFooter}>
          <button className={`${styles.chainBtn} ${styles.chainBtnDanger}`} onClick={onDelete}>
            Delete item
          </button>
          <div className={styles.chainModalFooterRight}>
            <button className={styles.chainBtn} onClick={onClose}>
              Cancel
            </button>
            <button
              className={`${styles.chainBtn} ${styles.chainBtnPrimary}`}
              onClick={handleSave}
              disabled={!mainText.trim()}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

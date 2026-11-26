/**
 * AlertLevelSettings — Settings ▸ Sound ▸ Alert levels (Nov 25 2026, lib/attention.ts): what each of the five levels
 * does (sound, notification, phone push, glowing card, repeat) and the default level for sessions and rooms with none
 * of their own. The table lives on the server (`/api/alert-levels`, alertConfigStore), so the push and every window
 * follow it. Silent is fixed: all off. Full only. Only the Mac changes it (the PUT answers this machine alone): another
 * device, or one the server hasn't placed yet, sees it to read.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useAlertConfigStore } from '@/stores/alertConfigStore';
import { usePresenceStore, isLocalDevice } from '@/stores/presenceStore';
import { getClientId } from '@/lib/deviceIdentity';
import {
  ALERT_LEVELS,
  ALERT_LEVEL_LABEL,
  DEFAULT_ALERT_CONFIG,
  REPEAT_MINUTES,
  type AlertConfig,
  type AlertLevel,
  type AlertLevelOutputs,
  type AlertNotify,
  type AlertSound,
} from '@/lib/attention';
import NativeSelect, { type NativeSelectOption } from '@/components/ui/NativeSelect';
import Button from '@/components/ui/Button';
import { showToast } from '@/components/ui/ToastContainer';
import { AlertLevelIcon } from '@/components/ui/icons';
import settings from '@/styles/modules/Settings.module.css';
import styles from '@/styles/modules/AlertLevels.module.css';

const SOUND_OPTIONS: readonly NativeSelectOption<AlertSound>[] = [
  { value: 'none', label: 'Off' },
  { value: 'normal', label: 'Normal' },
  { value: 'loud', label: 'Loud' },
];

const NOTIFY_OPTIONS: readonly NativeSelectOption<AlertNotify>[] = [
  { value: 'none', label: 'Off' },
  { value: 'proceed', label: 'Proceed asks' },
  { value: 'all', label: 'Every moment' },
];

const repeatLabel = (min: number) => (min === 0 ? 'Off' : `${min} min`);
const REPEAT_OPTIONS: readonly NativeSelectOption[] = REPEAT_MINUTES.map((min) => ({ value: String(min), label: repeatLabel(min) }));

const LEVEL_OPTIONS: readonly NativeSelectOption<AlertLevel>[] = ALERT_LEVELS.map((level) => ({
  value: level,
  label: ALERT_LEVEL_LABEL[level],
}));

const optionLabel = <T extends string>(options: readonly NativeSelectOption<T>[], value: T) =>
  options.find((o) => o.value === value)?.label ?? value;

const onOff = (on: boolean) => (on ? 'On' : 'Off');

/** A repeat the table holds that the list doesn't offer (≤ 60 min, from an edited alert-levels.json or a direct PUT)
 *  stays choosable instead of vanishing. */
function repeatOptions(current: number): readonly NativeSelectOption[] {
  return (REPEAT_MINUTES as readonly number[]).includes(current) ? REPEAT_OPTIONS : [...REPEAT_OPTIONS, { value: String(current), label: repeatLabel(current) }];
}

function sameConfig(a: AlertConfig, b: AlertConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface SwitchCellProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function SwitchCell({ label, checked, onChange }: SwitchCellProps) {
  return (
    <label className={`${settings.toggleLabel} ${styles.switchCell}`}>
      <input type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className={settings.toggleSwitch} />
    </label>
  );
}

/**
 * Marks the scroller `data-more` while columns are still hidden off its right edge (a narrow window), so the CSS can
 * fade that edge: a half-cut select alone doesn't say three more columns are there.
 */
function useMoreToTheRight(ref: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      el.dataset.more = String(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    // Every browser the app runs in has ResizeObserver; jsdom does not.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [ref]);
}

export default function AlertLevelSettings() {
  const config = useAlertConfigStore((s) => s.config);
  const save = useAlertConfigStore((s) => s.save);
  // Unknown reads as elsewhere (presenceStore's fail-closed rule), so a remote window never offers a write it can't make.
  const onMac = usePresenceStore((s) => isLocalDevice(s.devices, getClientId()));
  const scrollerRef = useRef<HTMLDivElement>(null);
  useMoreToTheRight(scrollerRef);

  const commit = useCallback(
    async (next: AlertConfig) => {
      const ok = await save(next);
      if (!ok) showToast('Couldn’t save the alert levels. Try again.', 'error');
    },
    [save],
  );

  const setOutput = useCallback(
    <K extends keyof AlertLevelOutputs>(level: AlertLevel, key: K, value: AlertLevelOutputs[K]) => {
      void commit({ ...config, levels: { ...config.levels, [level]: { ...config.levels[level], [key]: value } } });
    },
    [commit, config],
  );

  const isDefault = sameConfig(config, DEFAULT_ALERT_CONFIG);

  return (
    <div className={settings.section}>
      <h4>Alert levels</h4>
      {!onMac && <p className={styles.readOnlyNote}>Only your Mac can change these.</p>}
      <div className={styles.defaultRow}>
        {onMac ? (
          <>
            <label htmlFor="alert-default-level" className={styles.defaultLabel}>Default level</label>
            <NativeSelect
              id="alert-default-level"
              className={styles.cellSelect}
              value={config.defaultLevel}
              options={LEVEL_OPTIONS}
              onChange={(defaultLevel) => void commit({ ...config, defaultLevel })}
            />
          </>
        ) : (
          <>
            <span className={styles.defaultLabel}>Default level</span>
            <span className={styles.defaultValue}>{ALERT_LEVEL_LABEL[config.defaultLevel]}</span>
          </>
        )}
        <span className={styles.defaultHint}>For sessions and rooms without their own</span>
      </div>
      <div className={styles.tableScroll} ref={scrollerRef}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.levelHead}>Level</th>
              <th scope="col">Sound</th>
              <th scope="col">Notification</th>
              <th scope="col">Phone push</th>
              <th scope="col">Glow</th>
              <th scope="col">Repeat</th>
            </tr>
          </thead>
          <tbody>
            {ALERT_LEVELS.map((level) => {
              const out = config.levels[level];
              const name = ALERT_LEVEL_LABEL[level];
              const fixed = level === 'silent' || !onMac;
              return (
                <tr key={level}>
                  <th scope="row" className={styles.levelCell}>
                    <span className={styles.levelName}>
                      <AlertLevelIcon level={level} />
                      {name}
                    </span>
                  </th>
                  {fixed ? (
                    <>
                      <td className={styles.fixedCell}>{optionLabel(SOUND_OPTIONS, out.sound)}</td>
                      <td className={styles.fixedCell}>{optionLabel(NOTIFY_OPTIONS, out.notify)}</td>
                      <td className={styles.fixedCell}>{onOff(out.push)}</td>
                      <td className={styles.fixedCell}>{onOff(out.glow)}</td>
                      <td className={styles.fixedCell}>{repeatLabel(out.repeatMin)}</td>
                    </>
                  ) : (
                    <>
                      <td>
                        <NativeSelect
                          aria-label={`${name}: sound`}
                          className={styles.cellSelect}
                          value={out.sound}
                          options={SOUND_OPTIONS}
                          onChange={(v) => setOutput(level, 'sound', v)}
                        />
                      </td>
                      <td>
                        <NativeSelect
                          aria-label={`${name}: notification`}
                          className={styles.cellSelect}
                          value={out.notify}
                          options={NOTIFY_OPTIONS}
                          onChange={(v) => setOutput(level, 'notify', v)}
                        />
                      </td>
                      <td>
                        <SwitchCell label={`${name}: phone push`} checked={out.push} onChange={(v) => setOutput(level, 'push', v)} />
                      </td>
                      <td>
                        <SwitchCell label={`${name}: glowing card`} checked={out.glow} onChange={(v) => setOutput(level, 'glow', v)} />
                      </td>
                      <td>
                        <NativeSelect
                          aria-label={`${name}: repeat`}
                          className={styles.cellSelect}
                          value={String(out.repeatMin)}
                          options={repeatOptions(out.repeatMin)}
                          onChange={(v) => setOutput(level, 'repeatMin', Number(v))}
                        />
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {onMac && !isDefault && (
        <div className={styles.resetRow}>
          <Button size="sm" onClick={() => void commit(DEFAULT_ALERT_CONFIG)}>Reset to defaults</Button>
        </div>
      )}
    </div>
  );
}

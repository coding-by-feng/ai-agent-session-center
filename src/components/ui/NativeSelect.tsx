/**
 * NativeSelect — a styled native <select> for toolbars and forms.
 *
 *   <Field label="Priority">
 *     <NativeSelect value={priority} onChange={setPriority} options={PRIORITY_OPTIONS} />
 *   </Field>
 *
 * Why native rather than the custom `Select`: the OS menu is always inside the
 * viewport (no flip or clamp to get wrong), type-ahead and keyboard work for
 * free, and a wrapping <label> can name it — the custom Select's trigger is a
 * button, and a label around it re-clicks the trigger whenever an option is
 * picked, reopening the list. The custom `Select` stays for places that need
 * themed option rows (settings, modals).
 *
 * `onChange` hands back the typed value, not the event.
 */
import type { ComponentPropsWithRef } from 'react';
import styles from '@/styles/modules/FormControl.module.css';

export interface NativeSelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface NativeSelectProps<T extends string = string>
  extends Omit<ComponentPropsWithRef<'select'>, 'value' | 'defaultValue' | 'onChange' | 'children'> {
  value: T;
  onChange: (value: T) => void;
  options: readonly NativeSelectOption<T>[];
}

export default function NativeSelect<T extends string = string>({
  value,
  onChange,
  options,
  className,
  ...rest
}: NativeSelectProps<T>) {
  const cls = [styles.control, styles.select, className].filter(Boolean).join(' ');
  return (
    <select {...rest} className={cls} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {/* Keyed by position too: two options sharing a value (bad data, e.g. a
          project recorded under two names) must not collide as React keys. */}
      {options.map((o, i) => (
        <option key={`${i}:${o.value}`} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

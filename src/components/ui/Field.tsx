/**
 * Field — a short caption beside one native control, associated by wrapping:
 * the <label> names the first input/select inside it, so a click on the
 * caption focuses the control and a screen reader announces "Project, combo box".
 *
 *   <Field label="Project"><NativeSelect … /></Field>
 *   <Field label="From"><TextInput type="date" … /></Field>
 *
 * Native controls only. Wrapping the custom `Select` (a button trigger) would
 * re-click the trigger on every option pick and reopen it.
 */
import type { ReactNode } from 'react';
import styles from '@/styles/modules/FormControl.module.css';

interface FieldProps {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}

export default function Field({ label, children, className }: FieldProps) {
  return (
    <label className={className ? `${styles.field} ${className}` : styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

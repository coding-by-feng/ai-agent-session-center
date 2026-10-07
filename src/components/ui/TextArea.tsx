/**
 * TextArea — a styled native <textarea> on the same control box as TextInput
 * (background, border, radius, focus ring), growing vertically by hand
 * (`resize: vertical`). For notes and compose boxes; wrap it in a <label> or
 * give it an `aria-label` — a placeholder is not a name.
 */
import type { ComponentPropsWithRef } from 'react';
import styles from '@/styles/modules/FormControl.module.css';

export type TextAreaProps = ComponentPropsWithRef<'textarea'>;

export default function TextArea({ className, rows = 2, ...rest }: TextAreaProps) {
  const cls = [styles.control, styles.textarea, className].filter(Boolean).join(' ');
  return <textarea {...rest} rows={rows} className={cls} />;
}

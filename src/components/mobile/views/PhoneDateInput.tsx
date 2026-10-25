/**
 * PhoneDateInput — a date field for the phone views' sheets (Oct 22 2026). iOS draws an empty
 * date input as a blank box and will not shrink it below its own width, which pushed the
 * Filters sheet sideways; this one fills its column and says what an empty value means
 * ("Any date"), drawn over the box on iOS only (Android's WebView prints its own dd/mm/yyyy).
 */
import TextInput from '@/components/ui/TextInput';
import styles from '@/styles/modules/PhoneViews.module.css';

export interface PhoneDateInputProps {
  value: string;
  onChange: (value: string) => void;
  /** What an empty value means here: "Any date" for a filter, "No date" for a due date. */
  emptyLabel?: string;
}

export default function PhoneDateInput({ value, onChange, emptyLabel = 'Any date' }: PhoneDateInputProps) {
  return (
    <span className={styles.dateBox}>
      <TextInput type="date" value={value} onChange={(e) => onChange(e.target.value)} />
      {!value && <span className={styles.datePlaceholder} aria-hidden="true">{emptyLabel}</span>}
    </span>
  );
}

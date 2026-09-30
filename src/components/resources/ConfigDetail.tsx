/**
 * ConfigDetail — settings, MCP servers, hooks and plugin records as a table
 * of flattened fields.
 *
 * Values arrive already masked by the server (server/resourceMask.ts is the
 * only way a config value leaves it). This component masks AGAIN on the
 * `masked` flag via `formatFieldValue`, so a server regression that forgets to
 * blank a value still renders `******` instead of a credential.
 */
import type { ResourceField, ResourceFieldKind } from '@/types/resources';
import { formatFieldValue } from '@/lib/resourceFilters';
import styles from '@/styles/modules/Resources.module.css';

const KIND_CLASS: Record<ResourceFieldKind, string> = {
  string: styles.valueString,
  number: styles.valueLiteral,
  boolean: styles.valueLiteral,
  null: styles.valueLiteral,
  array: styles.valueString,
  object: styles.valueString,
};

export default function ConfigDetail({ fields }: { fields: readonly ResourceField[] }) {
  if (fields.length === 0) {
    return <p className={styles.emptyNote}>This entry has no fields to show.</p>;
  }
  const maskedCount = fields.filter((f) => f.masked).length;
  return (
    <div className={styles.configPane}>
      {maskedCount > 0 && (
        <p className={styles.note}>
          {maskedCount === 1 ? '1 value is' : `${maskedCount} values are`} masked — secrets never leave the server.
        </p>
      )}
      <div className={styles.tableScroll}>
        <table className={styles.fieldTable}>
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field, i) => (
              <tr key={`${i}:${field.key}`}>
                <th scope="row" className={styles.fieldKey}>{field.key}</th>
                <td className={styles.fieldValue}>
                  <span className={field.masked ? styles.valueMasked : KIND_CLASS[field.kind]}>
                    {formatFieldValue(field)}
                  </span>
                  {field.masked && <>{' '}<span className={styles.maskedChip}>masked</span></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

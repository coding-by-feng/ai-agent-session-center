/**
 * CloudReview — the "Save to cloud" review (AASC-62): what will be saved, what can't be (and
 * why), and the OK memory files need. Blocked resources are left out, never guessed at.
 */
import { useState } from 'react';
import Button from '@/components/ui/Button';
import RefusalReason from './RefusalReason';
import type { PublicationPlan } from '@/types/cloudResources';
import { cloudCount, cloudPackageSize, resourceKindLabel } from '@/lib/cloudFormat';
import styles from '@/styles/modules/CloudResources.module.css';
export default function CloudReview({
  publication,
  onConfirm,
  onClose,
  busy = false,
  disabled = false,
  resourceName,
}: {
  /** The local catalog name for a blocked item; its id is a machine key. */
  resourceName?: (catalogId: string) => string | undefined;
  publication: PublicationPlan;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const [memory, setMemory] = useState(false);
  const hasMemory = publication.items.some((i) => i.manifest.kind === 'memory');
  const blocked = publication.blocked.length;
  // A save leaves blocked resources out; they are listed with the reason.
  const valid = publication.items.length > 0 && (!hasMemory || memory);
  return (
    <div>
      <p role="status">
        {cloudCount(publication.items.length, 'resource')} ready to save
        {blocked > 0 ? ` · ${blocked} can't be saved` : ''}
      </p>
      {publication.blocked.map((i) => (
        <div className={styles.error} key={i.catalogId}>
          {resourceName?.(i.catalogId) ?? i.catalogId}: <RefusalReason reason={i.reason} />
        </div>
      ))}
      <ul className={styles.reviewList}>
        {publication.items.map((i) => (
          <li key={i.catalogId}>
            <span className={styles.syncName}>{i.manifest.name}</span>
            <span className={styles.hint}>
              {resourceKindLabel(i.manifest.agent, i.manifest.kind)}
              {i.manifest.scope === 'project' ? ' · project' : ''} ·{' '}
              {i.baseVersion === null ? 'new' : `update after v${i.baseVersion}`} ·{' '}
              {cloudPackageSize(i.manifest.files.reduce((n, f) => n + f.bytes, 0))}
            </span>
          </li>
        ))}
      </ul>
      {hasMemory && (
        <label className={styles.check}>
          <input type="checkbox" checked={memory} onChange={(e) => setMemory(e.target.checked)} />
          OK to save the memory files listed here to the cloud.
        </label>
      )}
      <div className={styles.toolbar}>
        <Button variant="primary" disabled={!valid || busy || disabled} onClick={onConfirm}>
          Save {cloudCount(publication.items.length, 'resource')} to cloud
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

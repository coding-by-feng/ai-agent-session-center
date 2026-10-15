import { useState } from 'react';
import Button from '@/components/ui/Button';
import Field from '@/components/ui/Field';
import NativeSelect from '@/components/ui/NativeSelect';
import type { InstallDecisions, InstallPlan, PublicationPlan } from '@/types/cloudResources';
import { cloudPackageSize } from '@/lib/cloudFormat';
import styles from '@/styles/modules/CloudResources.module.css';
export default function CloudReview({
  publication,
  install,
  onConfirm,
  onClose,
  busy = false,
  disabled = false,
  resourceName,
}: {
  /** The local catalog name for a blocked item; its id is a machine key. */
  resourceName?: (catalogId: string) => string | undefined;
  publication?: PublicationPlan;
  install?: InstallPlan;
  onConfirm: (decisions: InstallDecisions) => void;
  onClose: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const [decisions, setDecisions] = useState<InstallDecisions>({});
  const [memory, setMemory] = useState(false);
  const hasMemory = publication?.items.some((i) => i.manifest.kind === 'memory');
  const blocked =
    publication?.blocked.length ?? install?.items.filter((i) => i.action === 'blocked').length ?? 0;
  const valid = publication
    ? blocked === 0 && publication.items.length > 0 && (!hasMemory || memory)
    : !!install &&
      blocked === 0 &&
      install.items.every((i) => i.action !== 'replace' || !!decisions[i.id]);
  return (
    <div>
      <p>
        Review this exact plan. Changes to sources, destinations or cloud versions require a new
        comparison.
      </p>
      {publication && (
        <>
          <p role="status">
            {publication.items.length} ready · {blocked} blocked
          </p>
          {publication.blocked.map((i) => (
            <div className={styles.error} key={i.catalogId}>
              {resourceName?.(i.catalogId) ?? i.catalogId}: {i.reason}
            </div>
          ))}
          {publication.items.map((i) => (
            <article className={styles.card} key={i.catalogId}>
              <h4>{i.manifest.name}</h4>
              <p>
                {i.manifest.agent} · {i.manifest.scope} ·{' '}
                {i.baseVersion === null ? 'New resource' : `New version after v${i.baseVersion}`} ·{' '}
                {cloudPackageSize(i.manifest.files.reduce((n, f) => n + f.bytes, 0))}
              </p>
              <ul className={styles.files}>
                {i.manifest.files.map((f) => (
                  <li key={f.path}>
                    {f.path} · {cloudPackageSize(f.bytes)}
                  </li>
                ))}
              </ul>
              <p className={styles.hint}>
                Dependencies:{' '}
                {i.manifest.dependencies.map((d) => `${d.resourceId} v${d.version}`).join(', ') ||
                  'None'}
              </p>
            </article>
          ))}
          {hasMemory && (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={memory}
                onChange={(e) => setMemory(e.target.checked)}
              />
              I explicitly approve publishing the listed memory files.
            </label>
          )}
        </>
      )}
      {install && (
        <>
          <p role="status">
            {install.items.length - blocked} ready · {blocked} blocked
          </p>
          {install.items.map((i) => (
            <article key={i.id} className={styles.card}>
              <h4>{i.destinationLabel}</h4>
              <p>
                v{i.version} · {i.action}
                {i.reason ? ` · ${i.reason}` : ''}
              </p>
              <ul className={styles.files}>
                {i.files.map((f) => (
                  <li key={f.path}>
                    {f.change}: {f.path}
                  </li>
                ))}
              </ul>
              {i.action === 'replace' && (
                <Field label={`Decision for ${i.destinationLabel}`}>
                  <NativeSelect
                    value={decisions[i.id] ?? ''}
                    onChange={(value) =>
                      setDecisions((d) => ({ ...d, [i.id]: value as InstallDecisions[string] }))
                    }
                    options={[
                      { value: '', label: 'Choose a decision' },
                      { value: 'keep-local', label: 'Keep local' },
                      { value: 'replace-with-backup', label: 'Replace with backup' },
                      { value: 'skip', label: 'Skip' },
                    ]}
                  />
                </Field>
              )}
            </article>
          ))}
        </>
      )}
      <div className={styles.toolbar}>
        <Button
          variant="primary"
          disabled={!valid || busy || disabled}
          onClick={() => onConfirm(decisions)}
        >
          {publication ? 'Publish reviewed resources' : 'Install reviewed resources'}
        </Button>
        <Button onClick={onClose}>Close review</Button>
      </div>
    </div>
  );
}

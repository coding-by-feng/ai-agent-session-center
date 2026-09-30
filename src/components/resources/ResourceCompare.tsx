/**
 * ResourceCompare — a resource against its agent-skills repo copy or one of
 * its variants: which package files differ, then the unified diff of the main
 * file with added/removed lines coloured.
 *
 * The diff is computed on the server; this only classifies and paints it.
 * Config resources arrive as masked `key: value` lines, never raw text.
 */
import { memo, useEffect, useId, useState } from 'react';
import type { ResourceCompare as CompareResult, ResourceCompareFile } from '@/types/resources';
import { classifyPatchLines, type CompareOption, type PatchLineKind } from '@/lib/resourceFilters';
import { ResourcesUnavailableError, errorMessage, fetchResourceCompare, isAbortError } from '@/lib/resourcesApi';
import styles from '@/styles/modules/Resources.module.css';

interface ResourceCompareProps {
  id: string;
  options: CompareOption[];
}

interface CompareState {
  target: string;
  compare?: CompareResult;
  error?: string;
}

const LINE_CLASS: Record<PatchLineKind, string> = {
  add: styles.patchAdd,
  del: styles.patchDel,
  hunk: styles.patchHunk,
  meta: styles.patchMeta,
  context: styles.patchContext,
};

const STATUS_CLASS: Record<ResourceCompareFile['status'], string> = {
  same: styles.chipOk,
  changed: styles.chipWarn,
  'only-left': styles.chipMuted,
  'only-right': styles.chipMuted,
};

function statusLabel(file: ResourceCompareFile, compare: CompareResult): string {
  if (file.status === 'only-left') return `only in ${compare.left.label}`;
  if (file.status === 'only-right') return `only in ${compare.right.label}`;
  return file.status;
}

// Memoised: a patch can run to 200 KB, and the view re-renders on every poll.
const CompareBody = memo(function CompareBody({ compare }: { compare: CompareResult }) {
  const lines = compare.patch ? classifyPatchLines(compare.patch) : [];
  // An identical pair still gets the diff's file header (====, ---, +++) with
  // no hunk after it — that is "no differences", not an empty patch.
  const hasHunk = lines.some((line) => line.kind === 'hunk');
  const differing = compare.files.filter((f) => f.status !== 'same').length;
  return (
    <>
      <dl className={styles.compareSides}>
        <div>
          <dt>{compare.left.label}</dt>
          <dd><code>{compare.left.path}</code></dd>
        </div>
        <div>
          <dt>{compare.right.label}</dt>
          <dd><code>{compare.right.path}</code></dd>
        </div>
      </dl>
      {compare.files.length > 0 && (
        <ul className={styles.compareFiles} aria-label="Compared files">
          {compare.files.map((file) => (
            <li key={file.path} className={styles.compareFile}>
              <code className={styles.compareFilePath}>{file.path}</code>{' '}
              <span className={`${styles.badge} ${STATUS_CLASS[file.status]}`}>{statusLabel(file, compare)}</span>
            </li>
          ))}
        </ul>
      )}
      {hasHunk ? (
        <pre className={styles.patch}>
          {lines.map((line, i) => (
            <span key={i} className={LINE_CLASS[line.kind]} data-kind={line.kind}>{line.text}</span>
          ))}
        </pre>
      ) : (
        <p className={styles.muted}>{differing === 0 ? 'No differences.' : 'No text diff for the main file.'}</p>
      )}
      {compare.patchTruncated && <p className={styles.note}>The diff was cut short — it is over the size cap.</p>}
    </>
  );
});

export default function ResourceCompare({ id, options }: ResourceCompareProps) {
  const selectId = useId();
  const [target, setTarget] = useState(options[0]?.value ?? '');
  const [result, setResult] = useState<CompareState | null>(null);

  useEffect(() => {
    if (!target) return undefined;
    const controller = new AbortController();
    fetchResourceCompare(id, target, controller.signal).then(
      (compare) => setResult({ target, compare }),
      (err: unknown) => {
        if (isAbortError(err)) return;
        const message = err instanceof ResourcesUnavailableError
          ? 'There is nothing to compare against any more — rescan to refresh.'
          : errorMessage(err);
        setResult({ target, error: message });
      },
    );
    return () => controller.abort();
  }, [id, target]);

  if (options.length === 0) return <p className={styles.emptyNote}>Nothing to compare against.</p>;

  // Derived rather than set in the effect: a result for another target is stale.
  const current = result?.target === target ? result : null;
  return (
    <div className={styles.comparePane}>
      <div className={styles.field}>
        <label htmlFor={selectId} className={styles.fieldLabel}>Compare with</label>
        <select id={selectId} className={styles.select} value={target} onChange={(e) => setTarget(e.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      {!current && <p className={styles.muted}>Comparing…</p>}
      {current?.error && <p className={styles.errorNote}>{current.error}</p>}
      {current?.compare && <CompareBody compare={current.compare} />}
    </div>
  );
}

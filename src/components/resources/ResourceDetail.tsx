/**
 * ResourceDetail — the right pane: what a resource is, where it lives, and a
 * read-only look inside (Preview / Files / Compare), plus its findings.
 *
 * Mounted with `key={id}` by the view, so every selection starts from a clean
 * "loading" state and a fresh Preview tab without resetting state in an effect.
 * The header renders at once from the catalog summary; the body waits for
 * `GET /item/:id`. A 404 here means the id is stale (the file moved since the
 * last scan) — the device-level "only on this machine" 404 is handled by the
 * view before any detail can be opened.
 */
import { Suspense, lazy, useEffect, useId, useRef, useState } from 'react';
import type {
  ResourceDetail as DetailData,
  ResourceFile,
  ResourceFileContent,
  ResourceFinding,
  ResourceProject,
  ResourceSummary,
} from '@/types/resources';
import {
  AGENT_LABELS,
  RESOURCE_TYPE_SINGULAR,
  canCompare,
  compareTargets,
  findingLabel,
  formatBytes,
  scopeName,
} from '@/lib/resourceFilters';
import {
  ResourcesUnavailableError,
  errorMessage,
  fetchResourceDetail,
  fetchResourceFile,
  isAbortError,
} from '@/lib/resourcesApi';
import ConfigDetail from './ConfigDetail';
import ResourceCompare from './ResourceCompare';
import styles from '@/styles/modules/Resources.module.css';

// See ResourceMarkdown's header: this boundary keeps react-markdown and
// rehype-highlight out of the tab's first chunk.
const ResourceMarkdown = lazy(() => import('./ResourceMarkdown'));

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; detail: DetailData }
  | { status: 'missing' }
  | { status: 'error'; message: string };

type DetailTab = 'preview' | 'files' | 'compare';

const TAB_LABELS: Record<DetailTab, string> = { preview: 'Preview', files: 'Files', compare: 'Compare' };

interface ResourceDetailProps {
  id: string;
  /** From the catalog, for an instant header; absent for a stale id. */
  summary?: ResourceSummary;
  byId: ReadonlyMap<string, ResourceSummary>;
  projectsById: ReadonlyMap<string, ResourceProject>;
  onSelect: (id: string) => void;
  onBack: () => void;
}

function DetailHeader({
  summary,
  byId,
  projectsById,
  onSelect,
}: Pick<ResourceDetailProps, 'byId' | 'projectsById' | 'onSelect'> & { summary: ResourceSummary }) {
  const variants = compareTargets(summary, byId, projectsById).filter((o) => o.value !== 'repo');
  const files = summary.fileCount === 1 ? '1 file' : `${summary.fileCount} files`;
  return (
    <header className={styles.detailHeader}>
      <div className={styles.detailTitleRow}>
        <h2 className={styles.detailTitle}>{summary.name}</h2>
        <span className={styles.detailType}>{RESOURCE_TYPE_SINGULAR[summary.type]}</span>
      </div>
      <p className={styles.detailMeta}>
        {[AGENT_LABELS[summary.agent], scopeName(summary, projectsById), summary.origin].join(' · ')}
      </p>
      {summary.pluginName && <p className={styles.detailMeta}>Plugin: {summary.pluginName}</p>}
      <p className={styles.detailPath}>
        <code>{summary.path}</code>
        {summary.linkTarget && (
          <>
            {' '}<span className={styles.linkArrow} title="Symlink target">→</span>{' '}
            <code>{summary.linkTarget}</code>
          </>
        )}
      </p>
      <p className={styles.detailFacts}>
        {`${files} · ${formatBytes(summary.bytes)}`}
        {summary.repo.status !== 'not-tracked' && ` · repo: ${summary.repo.status.replace(/-/g, ' ')}`}
      </p>
      {variants.length > 0 && (
        <div className={styles.variantRow}>
          <span className={styles.fieldLabel}>Also in</span>
          {variants.map((variant) => (
            <button key={variant.value} type="button" className={styles.chipButton} onClick={() => onSelect(variant.value)}>
              {variant.label}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}

function Preview({ detail }: { detail: DetailData }) {
  const { format } = detail.summary;
  if (format === 'config') return <ConfigDetail fields={detail.fields ?? []} />;
  if (detail.body === undefined) {
    return <p className={styles.emptyNote}>No preview — the file could not be read.</p>;
  }
  const truncated = detail.bodyTruncated && <p className={styles.note}>Showing the first 256 KB.</p>;
  if (format === 'markdown') {
    return (
      <>
        <Suspense fallback={<p className={styles.muted}>Loading preview…</p>}>
          <ResourceMarkdown body={detail.body} frontmatter={detail.frontmatter} frontmatterError={detail.frontmatterError} />
        </Suspense>
        {truncated}
      </>
    );
  }
  return (
    <>
      {format === 'policy' && (
        <p className={styles.note}>Codex exec-approval policy — not the same thing as Claude rules.</p>
      )}
      <pre className={styles.codeBlock}>{detail.body}</pre>
      {truncated}
    </>
  );
}

type OpenFile =
  | { path: string; status: 'loading' }
  | { path: string; status: 'ready'; file: ResourceFileContent }
  | { path: string; status: 'error'; message: string };

function FilePreview({ open }: { open: OpenFile }) {
  return (
    <figure className={styles.filePreview}>
      <figcaption className={styles.fieldLabel}>{open.path}</figcaption>
      {open.status === 'loading' && <p className={styles.muted}>Loading…</p>}
      {open.status === 'error' && <p className={styles.errorNote}>{open.message}</p>}
      {open.status === 'ready' && (open.file.binary
        ? <p className={styles.muted}>Binary file — not shown.</p>
        : <pre className={styles.codeBlock}>{open.file.content ?? ''}</pre>)}
      {open.status === 'ready' && open.file.truncated && <p className={styles.note}>Showing the first 512 KB.</p>}
    </figure>
  );
}

function FilesView({ id, files }: { id: string; files: readonly ResourceFile[] }) {
  const [open, setOpen] = useState<OpenFile | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);

  const openFile = (path: string) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setOpen({ path, status: 'loading' });
    fetchResourceFile(id, path, controller.signal).then(
      (file) => setOpen({ path, status: 'ready', file }),
      (err: unknown) => {
        if (isAbortError(err)) return;
        // A 404 here is a file removed since the scan, not a remote device.
        const message = err instanceof ResourcesUnavailableError
          ? 'This file is no longer there — rescan to refresh.'
          : errorMessage(err);
        setOpen({ path, status: 'error', message });
      },
    );
  };

  return (
    <div className={styles.filesPane}>
      <ul className={styles.fileList} aria-label="Package files">
        {files.map((file) => {
          const meta = (
            <>
              <span className={styles.filePath}>{file.path}</span>{' '}
              <span className={styles.fileSize}>{formatBytes(file.bytes)}</span>
              {file.isSymlink && <>{' '}<span className={styles.badge}>symlink</span></>}
            </>
          );
          return (
            <li key={file.path}>
              {file.isText ? (
                <button
                  type="button"
                  className={styles.fileButton}
                  aria-pressed={open?.path === file.path}
                  onClick={() => openFile(file.path)}
                >
                  {meta}
                </button>
              ) : (
                <div className={styles.fileStatic}>
                  {meta}{' '}<span className={`${styles.badge} ${styles.chipMuted}`}>binary</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {open && <FilePreview open={open} />}
    </div>
  );
}

function FindingsList({ findings }: { findings: readonly ResourceFinding[] }) {
  const headingId = useId();
  return (
    <section className={styles.detailFindings} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.subheading}>Findings</h3>
      <ul className={styles.findingList}>
        {findings.map((finding, i) => (
          <li key={`${finding.code}:${i}`} className={styles.findingItem}>
            <span className={`${styles.badge} ${styles[`sev_${finding.severity}`] ?? ''}`}>{finding.severity}</span>{' '}
            <span className={styles.findingLabel}>{findingLabel(finding.code)}</span>{' '}
            <span className={styles.findingMessage}>{finding.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DetailBody({ id, detail, summary, byId, projectsById }: {
  id: string;
  detail: DetailData;
  summary: ResourceSummary;
  byId: ReadonlyMap<string, ResourceSummary>;
  projectsById: ReadonlyMap<string, ResourceProject>;
}) {
  const baseId = useId();
  const [tab, setTab] = useState<DetailTab>('preview');
  const compareOptions = canCompare(summary) ? compareTargets(summary, byId, projectsById) : [];
  const tabs: DetailTab[] = [
    'preview',
    ...(detail.files && detail.files.length > 0 ? ['files' as const] : []),
    ...(compareOptions.length > 0 ? ['compare' as const] : []),
  ];
  const active = tabs.includes(tab) ? tab : 'preview';
  return (
    <>
      <div className={styles.detailTabs} role="tablist" aria-label="Detail views">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`${baseId}-${t}`}
            aria-selected={t === active}
            aria-controls={`${baseId}-panel`}
            className={t === active ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-${active}`} className={styles.detailPanel}>
        {active === 'preview' && <Preview detail={detail} />}
        {active === 'files' && <FilesView id={id} files={detail.files ?? []} />}
        {active === 'compare' && <ResourceCompare id={id} options={compareOptions} />}
      </div>
      {detail.findings.length > 0 && <FindingsList findings={detail.findings} />}
    </>
  );
}

export default function ResourceDetail({ id, summary: catalogSummary, byId, projectsById, onSelect, onBack }: ResourceDetailProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchResourceDetail(id, controller.signal).then(
      (detail) => setLoad({ status: 'ready', detail }),
      (err: unknown) => {
        if (isAbortError(err)) return;
        setLoad(err instanceof ResourcesUnavailableError
          ? { status: 'missing' }
          : { status: 'error', message: errorMessage(err) });
      },
    );
    return () => controller.abort();
  }, [id, attempt]);

  const summary = catalogSummary ?? (load.status === 'ready' ? load.detail.summary : undefined);
  const retry = () => {
    setLoad({ status: 'loading' });
    setAttempt((n) => n + 1);
  };

  return (
    <section className={styles.detailPane} aria-label="Resource detail">
      <button type="button" className={styles.backButton} onClick={onBack} aria-label="Back to list">
        ‹ Back
      </button>
      {summary && <DetailHeader summary={summary} byId={byId} projectsById={projectsById} onSelect={onSelect} />}
      {load.status === 'loading' && <p className={styles.muted}>Loading…</p>}
      {load.status === 'missing' && (
        <p className={styles.emptyNote}>
          This resource is no longer in the catalog — it may have moved since the last scan. Rescan to refresh.
        </p>
      )}
      {load.status === 'error' && (
        <div className={styles.inlineError}>
          <p className={styles.errorNote}>{load.message}</p>
          <button type="button" className={styles.button} onClick={retry}>Try again</button>
        </div>
      )}
      {load.status === 'ready' && summary && (
        <DetailBody id={id} detail={load.detail} summary={summary} byId={byId} projectsById={projectsById} />
      )}
    </section>
  );
}

/**
 * SourcesPanel — where the catalog came from: the global roots, every project
 * that was discovered (and how), what each root contributed, and folders the
 * user added by hand.
 *
 * Coverage is the honest half of the catalog. A category that was skipped,
 * sized-but-not-read, or deliberately excluded (credentials) is listed with its
 * reason, so "not scanned" reads as an answer rather than as "nothing there".
 */
import { Fragment, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import type {
  CoverageCategory,
  CoverageEntry,
  DiscoveryEvidence,
  ResourceCatalog,
  ResourceProject,
} from '@/types/resources';
import {
  RESOURCE_TYPE_LABELS,
  formatBytes,
  groupCoverage,
  normalizeExtraRoot,
  validateExtraRoot,
  orderProjects,
  sharedProjectNames,
} from '@/lib/resourceFilters';
import styles from '@/styles/modules/Resources.module.css';

interface SourcesPanelProps {
  catalog: ResourceCatalog;
  extraRoots: readonly string[];
  /** False when localStorage refused the last write. */
  storageOk: boolean;
  onAddRoot: (path: string) => void;
  onRemoveRoot: (path: string) => void;
}

const EVIDENCE_LABELS: Record<DiscoveryEvidence, string> = {
  'claude-projects': 'Claude projects dir',
  'claude-json': 'Claude config',
  'codex-config': 'Codex config',
  'aasc-session': 'AASC session',
  added: 'added by you',
};

const CATEGORY_LABELS: Record<CoverageCategory, string> = {
  ...RESOURCE_TYPE_LABELS,
  sessions: 'Sessions',
  history: 'History',
  databases: 'Databases',
  credentials: 'Credentials',
  'plugin-contents': 'Plugin contents',
};

/**
 * A path that wraps only after a `/`. Plain `overflow-wrap: anywhere` lets a
 * table column's minimum width collapse to one character, which is what the
 * projects table did at phone width ("~/Do / cume / nts/…").
 */
function BreakablePath({ path }: { path: string }) {
  const segments = path.split('/');
  return (
    <code className={`${styles.pathCell} ${styles.tablePath}`}>
      {segments.map((segment, i) => (
        <Fragment key={i}>
          {segment}
          {i < segments.length - 1 && <>/<wbr /></>}
        </Fragment>
      ))}
    </code>
  );
}

function projectTotal(project: ResourceProject): number {
  return Object.values(project.counts).reduce((sum, n) => sum + (n ?? 0), 0);
}

function coverageAmount(entry: CoverageEntry): string {
  const parts = [
    entry.count !== undefined ? String(entry.count) : null,
    entry.bytes !== undefined ? formatBytes(entry.bytes) : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: string }) {
  const headingId = useId();
  return (
    <section className={styles.sourcesSection} aria-labelledby={headingId}>
      <div className={styles.sectionHead}>
        <h3 id={headingId} className={styles.subheading}>{title}</h3>
        {aside && <span className={styles.sectionAside}>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function RootsList({ roots }: { roots: ResourceCatalog['roots'] }) {
  return (
    <dl className={styles.rootsList}>
      <div><dt>Claude</dt><dd><code>{roots.claude}</code></dd></div>
      <div><dt>Codex</dt><dd><code>{roots.codex}</code></dd></div>
      <div><dt>Shared</dt><dd><code>{roots.shared}</code></dd></div>
      <div>
        <dt>Repo</dt>
        <dd>
          {roots.repo
            ? <code>{roots.repo}</code>
            : <span className={styles.muted}>No agent-skills repo detected — repo compare is off.</span>}
        </dd>
      </div>
    </dl>
  );
}

function ProjectFlags({ project, duplicate }: { project: ResourceProject; duplicate: boolean }) {
  return (
    <>
      {project.isHome && <>{' '}<span className={styles.badge}>home</span></>}
      {!project.exists && <>{' '}<span className={`${styles.badge} ${styles.chipError}`}>missing</span></>}
      {project.worktreeOf && <>{' '}<span className={`${styles.badge} ${styles.badgeWrap}`}>worktree of {project.worktreeOf}</span></>}
      {duplicate && <>{' '}<span className={`${styles.badge} ${styles.chipWarn}`}>duplicate name</span></>}
    </>
  );
}

/**
 * The library filtered to one project. A real link (not a button) so it has an
 * href to copy or open elsewhere. It carries no `type`: the view opens the
 * first type the project actually has.
 */
function projectSearch(projectId: string): string {
  return `?${new URLSearchParams({ section: 'library', scope: 'project', project: projectId }).toString()}`;
}

function ProjectsTable({ projects }: { projects: readonly ResourceProject[] }) {
  const sorted = useMemo(() => orderProjects(projects), [projects]);
  const sharedNames = useMemo(() => sharedProjectNames(projects), [projects]);
  if (sorted.length === 0) return <p className={styles.emptyNote}>No projects were discovered.</p>;
  return (
    <div className={styles.tableScroll}>
      <table className={styles.dataTable}>
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Path</th>
            <th scope="col">Found via</th>
            <th scope="col" className={styles.numCell}>Resources</th>
            <th scope="col"><span className={styles.visuallyHidden}>Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((project) => {
            const total = projectTotal(project);
            return (
              <tr key={project.id}>
                <td>
                  <span className={styles.projectName}>{project.name}</span>
                  <ProjectFlags project={project} duplicate={project.exists && sharedNames.has(project.name)} />
                </td>
                <td><BreakablePath path={project.path} /></td>
                <td>
                  <span className={styles.chipRow}>
                    {project.evidence.map((e) => <span key={e} className={styles.badge}>{EVIDENCE_LABELS[e]}</span>)}
                  </span>
                </td>
                <td className={styles.numCell}>{total}</td>
                <td>
                  {total > 0 ? (
                    <Link
                      className={styles.button}
                      to={{ search: projectSearch(project.id) }}
                      aria-label={`Show resources in ${project.name} (${project.path})`}
                    >
                      Show
                    </Link>
                  ) : (
                    <span className={styles.muted} title="Nothing was found in this project">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CoverageTables({ coverage }: { coverage: readonly CoverageEntry[] }) {
  const groups = useMemo(() => groupCoverage(coverage), [coverage]);
  if (groups.length === 0) return <p className={styles.emptyNote}>No coverage was reported.</p>;
  return (
    <div className={styles.coverageGroups}>
      {groups.map((group) => (
        <div key={group.root} className={styles.tableScroll}>
          <table className={styles.dataTable}>
            <caption className={styles.tableCaption}>{group.root}</caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Status</th>
                <th scope="col">Found</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {group.entries.map((entry, i) => (
                <tr key={`${entry.agent}:${entry.category}:${i}`}>
                  <th scope="row">{CATEGORY_LABELS[entry.category]}</th>
                  <td><span className={`${styles.badge} ${styles[`cov_${entry.status}`] ?? ''}`}>{entry.status.replace(/-/g, ' ')}</span></td>
                  <td className={styles.numCell}>{coverageAmount(entry)}</td>
                  <td className={styles.noteCell}>{entry.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function AddFolder({ extraRoots, storageOk, onAddRoot, onRemoveRoot }: Pick<SourcesPanelProps, 'extraRoots' | 'storageOk' | 'onAddRoot' | 'onRemoveRoot'>) {
  const inputId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problem = validateExtraRoot(draft, extraRoots);
    if (problem) {
      setError(problem);
      return;
    }
    onAddRoot(normalizeExtraRoot(draft));
    setDraft('');
    setError(null);
  };

  return (
    <>
      <form className={styles.addFolderForm} onSubmit={submit} noValidate>
        <label htmlFor={inputId} className={styles.fieldLabel}>Folder path</label>
        <input
          id={inputId}
          className={styles.textInput}
          value={draft}
          placeholder="/Users/you/code/project"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
        />
        <button type="submit" className={styles.button}>Add</button>
      </form>
      {error && <p id={errorId} role="alert" className={styles.errorNote}>{error}</p>}
      {!storageOk && (
        <p className={styles.note}>These folders could not be saved in this browser — they apply until you reload.</p>
      )}
      {extraRoots.length > 0 ? (
        <ul className={styles.extraRoots}>
          {extraRoots.map((path) => (
            <li key={path} className={styles.extraRoot}>
              <code className={styles.pathCell}>{path}</code>
              <button type="button" className={styles.button} aria-label={`Remove ${path}`} onClick={() => onRemoveRoot(path)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>No folders added.</p>
      )}
      <p className={styles.hint}>Added folders are scanned as projects the next time you press Rescan.</p>
    </>
  );
}

export default function SourcesPanel({ catalog, extraRoots, storageOk, onAddRoot, onRemoveRoot }: SourcesPanelProps) {
  const live = catalog.projects.filter((p) => p.exists).length;
  const missing = catalog.projects.length - live;
  const projectsAside = [
    live === 1 ? '1 project' : `${live} projects`,
    ...(missing > 0 ? [`${missing} missing`] : []),
  ].join(' · ');
  return (
    <div className={styles.panelScroll}>
      <Section title="Roots">
        <RootsList roots={catalog.roots} />
      </Section>
      <Section title="Projects" aside={projectsAside}>
        <ProjectsTable projects={catalog.projects} />
      </Section>
      <Section title="Coverage">
        <p className={styles.hint}>What each root contributed. “Not scanned” and “excluded” are answers, not gaps.</p>
        <CoverageTables coverage={catalog.coverage} />
      </Section>
      <Section title="Add folder">
        <p className={styles.hint}>Scan a project folder that no session or config file points at.</p>
        <AddFolder extraRoots={extraRoots} storageOk={storageOk} onAddRoot={onAddRoot} onRemoveRoot={onRemoveRoot} />
      </Section>
    </div>
  );
}

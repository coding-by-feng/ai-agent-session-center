/**
 * ChecksPanel — every finding from the last scan, grouped by severity and then
 * by check, each one a way into the resource it is about.
 *
 * The checks are deterministic (Phase B has no AI suggestions). Info groups
 * start collapsed: "not in repo" and "hard-coded home path" can run to hundreds
 * and would bury the handful of errors and warnings above them.
 * `repo-only` findings describe a repo file with no live counterpart, so they
 * show a path and are not links — there is no resource to open.
 */
import { useId, useMemo } from 'react';
import type { FindingSeverity, ResourceFinding, ResourceProject, ResourceSummary } from '@/types/resources';
import { AGENT_LABELS, groupFindings, scopeName, type FindingGroup } from '@/lib/resourceFilters';
import styles from '@/styles/modules/Resources.module.css';

interface ChecksPanelProps {
  findings: readonly ResourceFinding[];
  byId: ReadonlyMap<string, ResourceSummary>;
  projectsById: ReadonlyMap<string, ResourceProject>;
  onSelect: (resource: ResourceSummary) => void;
}

const SEVERITY_TITLES: Record<FindingSeverity, string> = { error: 'Errors', warning: 'Warnings', info: 'Info' };

function summaryText(groups: readonly FindingGroup[]): string {
  return groups
    .map(({ severity, count }) => {
      if (severity === 'info') return `${count} info`;
      return `${count} ${severity}${count === 1 ? '' : 's'}`;
    })
    .join(' · ');
}

function FindingItem({
  finding,
  resource,
  projectsById,
  onSelect,
}: {
  finding: ResourceFinding;
  resource?: ResourceSummary;
  projectsById: ReadonlyMap<string, ResourceProject>;
  onSelect: (resource: ResourceSummary) => void;
}) {
  if (resource) {
    return (
      <button type="button" className={styles.findingButton} onClick={() => onSelect(resource)}>
        <span className={styles.findingName}>{resource.name}</span>{' '}
        <span className={styles.findingWhere}>{`${AGENT_LABELS[resource.agent]} · ${scopeName(resource, projectsById)}`}</span>{' '}
        <span className={styles.findingMessage}>{finding.message}</span>
      </button>
    );
  }
  return (
    <div className={styles.findingStatic}>
      <span className={styles.findingMessage}>{finding.message}</span>
      {finding.path && <>{' '}<code className={styles.pathCell}>{finding.path}</code></>}
    </div>
  );
}

function SeveritySection({ group, byId, projectsById, onSelect }: Omit<ChecksPanelProps, 'findings'> & { group: FindingGroup }) {
  const headingId = useId();
  return (
    <section className={`${styles.checksSection} ${styles[`checks_${group.severity}`] ?? ''}`} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.subheading}>{`${SEVERITY_TITLES[group.severity]} · ${group.count}`}</h3>
      {group.codes.map((code) => (
        <details key={code.code} className={styles.checkGroup} open={group.severity !== 'info'}>
          <summary className={styles.checkSummary}>{`${code.label} · ${code.findings.length}`}</summary>
          <ul className={styles.checkList}>
            {code.findings.map((finding, i) => (
              <li key={`${finding.resourceId ?? finding.path ?? ''}:${i}`}>
                <FindingItem
                  finding={finding}
                  resource={finding.resourceId ? byId.get(finding.resourceId) : undefined}
                  projectsById={projectsById}
                  onSelect={onSelect}
                />
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

export default function ChecksPanel({ findings, byId, projectsById, onSelect }: ChecksPanelProps) {
  const groups = useMemo(() => groupFindings(findings), [findings]);
  if (groups.length === 0) {
    return (
      <div className={styles.panelScroll}>
        <p className={styles.emptyNote}>No findings — every check passed.</p>
      </div>
    );
  }
  return (
    <div className={styles.panelScroll}>
      <p className={styles.hint}>{summaryText(groups)}</p>
      {groups.map((group) => (
        <SeveritySection key={group.severity} group={group} byId={byId} projectsById={projectsById} onSelect={onSelect} />
      ))}
    </div>
  );
}

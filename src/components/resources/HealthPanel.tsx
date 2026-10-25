/**
 * HealthPanel — RESOURCES → Health (Oct 23 2026): Checks, then Sources, in one scrolling view.
 * Both answer "is my catalog right?" and are opened far less than Library, so they share a tab
 * instead of taking two. Old `?section=checks` and `?section=sources` links open here.
 */
import type { ResourceCatalog, ResourceProject, ResourceSummary } from '@/types/resources';
import { healthIssues } from '@/lib/resourceFilters';
import SectionHeader from '@/components/ui/SectionHeader';
import ChecksPanel from './ChecksPanel';
import SourcesPanel from './SourcesPanel';
import lib from '@/styles/modules/ResourceLibrary.module.css';

export default function HealthPanel({
  catalog,
  byId,
  projectsById,
  onSelect,
  extraRoots,
  storageOk,
  onAddRoot,
  onRemoveRoot,
}: {
  catalog: ResourceCatalog;
  byId: ReadonlyMap<string, ResourceSummary>;
  projectsById: ReadonlyMap<string, ResourceProject>;
  onSelect: (r: ResourceSummary) => void;
  extraRoots: readonly string[];
  storageOk: boolean;
  onAddRoot: (path: string) => void;
  onRemoveRoot: (path: string) => void;
}) {
  const issues = healthIssues(catalog.findings);
  return (
    <div className={lib.health}>
      <section className={lib.healthSection} aria-label="Checks">
        <SectionHeader
          label="Checks"
          count={issues}
          countLabel={`${issues} ${issues === 1 ? 'issue' : 'issues'}`}
          level={2}
        />
        <ChecksPanel
          findings={catalog.findings}
          byId={byId}
          projectsById={projectsById}
          onSelect={onSelect}
        />
      </section>
      <section className={lib.healthSection} aria-label="Sources">
        <SectionHeader label="Sources" level={2} />
        <SourcesPanel
          catalog={catalog}
          extraRoots={extraRoots}
          storageOk={storageOk}
          onAddRoot={onAddRoot}
          onRemoveRoot={onRemoveRoot}
        />
      </section>
    </div>
  );
}

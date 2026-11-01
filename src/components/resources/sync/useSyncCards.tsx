/**
 * useSyncCards — Project Sync on the Projects cards (Oct 31 2026). A project linked to a server
 * gets a Sync button beside its own and a line saying where it syncs and how that stands; any
 * other project folder offers "Sync with a server…" in its ⋯ menu. Both open one dialog.
 *
 * A folder can sync once Sources knows it (the resource catalog: the link names its project),
 * never the home folder or a linked worktree. Hidden where sync is unsupported (Windows).
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { SyncDevice, SyncLink, SyncRun } from '@/types/projectSync';
import type { ResourceCatalog, ResourceProject } from '@/types/resources';
import { LINK_STATE_LABEL } from '@/lib/projectSyncFormat';
import Button from '@/components/ui/Button';
import type { MenuItem } from '@/components/ui/Menu';
import { displayPath } from '../cloud/projectList';
import ProjectSyncDialog from './ProjectSyncDialog';
import { useProjectSync } from './useProjectSync';

export interface SyncCard {
  /** Where the project syncs and how that stands, under the card's facts. */
  line?: string;
  /** Sync, beside the card's own button. */
  button?: ReactNode;
  /** For the card's ⋯ menu. */
  menuItems: MenuItem[];
}

function lineFor(link: SyncLink, device: SyncDevice | undefined, run: SyncRun | undefined) {
  const where = `${link.direction === 'two-way' ? 'Syncs with' : 'Mirrors to'} ${device?.name ?? 'a removed server'}`;
  if (run?.state === 'comparing') return `${where} · Comparing…`;
  if (run?.state === 'running') return `${where} · Syncing ${run.done}/${run.total}`;
  return `${where} · ${LINK_STATE_LABEL[link.state]}`;
}

export function useSyncCards({
  catalog,
  home,
  visible,
}: {
  catalog: ResourceCatalog | undefined;
  /** This computer's home folder, as the Projects list has it. */
  home: string | null;
  visible: boolean;
}) {
  const sync = useProjectSync(visible && !!catalog);
  const [open, setOpen] = useState<{ project: ResourceProject; name: string } | null>(null);
  const overview = sync.overview;
  const byPath = useMemo(
    () =>
      new Map(
        (catalog?.projects ?? [])
          .filter((p) => p.exists && !p.isHome && !p.worktreeOf)
          .map((p) => [p.path, p]),
      ),
    [catalog],
  );

  function cardFor(path: string | null, name: string): SyncCard | undefined {
    if (!overview?.supported || !path) return undefined;
    const project = byPath.get(displayPath(path, home));
    if (!project) return undefined;
    const show = () => setOpen({ project, name });
    const link = overview.links.find((l) => l.projectId === project.id);
    if (!link)
      return {
        menuItems: [{ kind: 'action', id: 'sync', label: 'Sync with a server…', onSelect: show }],
      };
    const device = overview.devices.find((d) => d.id === link.deviceId);
    const run = link.lastRunId ? overview.runs.find((r) => r.id === link.lastRunId) : undefined;
    return {
      line: lineFor(link, device, run),
      button: (
        <Button aria-label={`Sync ${name}`} onClick={show}>
          Sync
        </Button>
      ),
      menuItems: [],
    };
  }

  const dialog = open ? (
    <ProjectSyncDialog
      project={open.project}
      name={open.name}
      sync={sync}
      onClose={() => setOpen(null)}
    />
  ) : null;
  return { cardFor, dialog };
}

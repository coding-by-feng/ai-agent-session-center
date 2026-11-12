/**
 * ProjectFolderRow — a folder on this Mac that is not a saved project's checkout (Oct 29 2026):
 * a GitHub folder not saved yet (Save keeps its name, link and branch in the cloud and links the
 * folder here), a folder with a saved project's repository that isn't linked yet (Use this folder;
 * it stands for that project, ♥ and tags too), another copy of a linked project, or a folder whose
 * origin is not on GitHub or that AASC won't read (it says why). The last two only open, but any
 * of them can sync with a server (Project Sync, Oct 31 2026): its ⋯ menu, then a Sync button.
 */
import type { ProjectViewMode } from '@/stores/uiStore';
import Menu, { type MenuItem } from '@/components/ui/Menu';
import { MoreActionsIcon } from '@/components/ui/icons';
import ProjectRowFrame, { FavToggle, PrimaryButton } from './ProjectRowFrame';
import { displayPath, folderName, type ProjectRow } from './projectList';
import { folderStatus } from './projectState';
import type { SyncCard } from '../sync/useSyncCards';
import styles from '@/styles/modules/CloudResources.module.css';

export default function ProjectFolderRow({
  layout,
  row,
  home,
  favColumn,
  linkedPath,
  alike,
  disabled,
  onSave,
  onLink,
  onFav,
  sync,
}: {
  /** A row of the list, or a card of the grid. */
  layout: ProjectViewMode;
  row: Extract<ProjectRow, { kind: 'folder' }>;
  home: string | null;
  favColumn: boolean;
  /** Where its saved project is linked here, for another copy. */
  linkedPath: string | null;
  /** Folders here not linked yet with the same saved project, this one included. */
  alike: number;
  disabled: boolean;
  onSave: () => void;
  onLink: () => void;
  /** The ♥ of the saved project an 'unlinked' folder stands for. */
  onFav: (favorite: boolean) => void;
  /** Project Sync's part of the card; absent where the folder can't sync. */
  sync?: SyncCard;
}) {
  const { folder, state, project } = row;
  const status = folderStatus(state, folder.blocked);
  const name = folderName(folder.path);
  const openUrl = `/project-browser?path=${encodeURIComponent(folder.path)}`;
  const hint =
    state === 'unlinked' && project
      ? alike > 1
        ? `${project.name} is saved with this repository and branch, and ${alike} folders here have them. Use this one?`
        : `${project.name} is saved with this repository and branch. Use this folder for it?`
      : state === 'copy' && project && linkedPath
        ? `${project.name} uses ${displayPath(linkedPath, home)} on this Mac.`
        : (status.hint ?? null);
  const stands = state === 'unlinked' && favColumn && project;
  const items: MenuItem[] = [
    ...(status.primary !== 'open'
      ? [
          {
            kind: 'action' as const,
            id: 'open',
            label: 'Open folder',
            onSelect: () => window.open(openUrl, '_blank'),
          },
        ]
      : []),
    ...(sync?.menuItems ?? []),
  ];
  return (
    <ProjectRowFrame
      layout={layout}
      name={name}
      muted={state === 'copy' || state === 'plain'}
      favColumn={favColumn}
      fav={
        stands ? (
          <FavToggle
            name={project.name}
            favorite={row.meta?.favorite ?? false}
            disabled={disabled}
            onFav={onFav}
          />
        ) : undefined
      }
      branch={folder.repository?.branch}
      tags={favColumn ? row.meta?.tags : undefined}
      path={folder.path}
      home={home}
      lastActivityAt={folder.lastActivityAt}
      repository={folder.repository}
      status={status}
      button={
        <PrimaryButton
          status={status}
          openUrl={openUrl}
          disabled={disabled}
          onRun={(action) => (action === 'save' ? onSave() : action === 'link' && onLink())}
        />
      }
      aside={sync?.button}
      menu={
        items.length > 0 && (
          <Menu
            label={`Actions for ${name}`}
            triggerLabel={`More actions for ${name}`}
            triggerIcon={<MoreActionsIcon />}
            align="end"
            sections={[{ id: 'row', items }]}
          />
        )
      }
    >
      {sync?.line && <p className={styles.hint}>{sync.line}</p>}
      {hint && <p className={styles.hint}>{hint}</p>}
    </ProjectRowFrame>
  );
}

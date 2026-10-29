/**
 * CloudProjectRow — one saved project (AASC-63; one button and a ⋯ menu since Oct 29 2026): its
 * ♥, name, branch and tags, where its checkout is here, how it compares with GitHub, and the one
 * thing to do about it (Clone, Pull, Push or Open). The ⋯ menu holds the rest: Open folder, Check
 * for changes now, Edit tags…, GitHub account… and Remove from cloud…, which asks once and never
 * touches a folder. Each "…" opens a small panel under the row.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  GithubAccounts,
  LocalProject,
  ProjectMeta,
  ProjectRecord,
} from '@/types/cloudProjects';
import type { ProjectViewMode } from '@/stores/uiStore';
import Button from '@/components/ui/Button';
import Field from '@/components/ui/Field';
import Menu, { type MenuItem } from '@/components/ui/Menu';
import NativeSelect from '@/components/ui/NativeSelect';
import { MoreActionsIcon } from '@/components/ui/icons';
import ProjectRowFrame, { FavToggle, PrimaryButton } from './ProjectRowFrame';
import ProjectTags from './ProjectTags';
import { projectStatus } from './projectState';
import styles from '@/styles/modules/CloudResources.module.css';

export const OWN_SIGN_IN = 'This Mac’s Git sign-in';
/** The same, mid-sentence: "Mac" and "Git" keep their capitals. */
export const OWN_SIGN_IN_MIDDLE = 'this Mac’s Git sign-in';

type Panel = 'tags' | 'account' | 'remove';

export default function CloudProjectRow({
  layout,
  project,
  path,
  lastActivityAt,
  home,
  local,
  meta,
  metaAvailable,
  tagSuggestions,
  accounts,
  disabled,
  working,
  checking,
  checkError,
  onFav,
  onAddTag,
  onRemoveTag,
  onClone,
  onPull,
  onPush,
  onCheck,
  onAccount,
  onRemove,
  children,
}: {
  /** A row of the list, or a card of the grid. */
  layout: ProjectViewMode;
  project: ProjectRecord;
  /** Its checkout here (projectList.ts); null when it is not on this Mac. */
  path: string | null;
  lastActivityAt: number | null;
  home: string | null;
  local: LocalProject | undefined;
  meta: ProjectMeta | null;
  /** AASC Cloud keeps project ♥ and tags. */
  metaAvailable: boolean;
  tagSuggestions: readonly string[];
  accounts: GithubAccounts | null;
  /** No action can start (offline, busy, stale list). */
  disabled: boolean;
  /** A Clone, Pull or Push of this project is running. */
  working: boolean;
  /** The tab is reading it right now: its checkout here, or GitHub. */
  checking: boolean;
  /** Why the tab couldn't read its folder or check it with GitHub, in a sentence. */
  checkError?: string;
  onFav: (favorite: boolean) => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onClone: () => void;
  onPull: () => void;
  onPush: () => void;
  onCheck: () => void;
  onAccount: (login: string | null) => void;
  onRemove: () => void;
  /** This project's running jobs. */
  children?: ReactNode;
}) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const status = projectStatus(local, project.repository.branch, checking);
  const off = disabled || working;
  const favorite = meta?.favorite ?? false;
  // Opened from the ⋯ menu, a panel takes the focus (the tag panel focuses its own input).
  useEffect(() => {
    if (panel === 'account') panelRef.current?.querySelector('select')?.focus();
    if (panel === 'remove') panelRef.current?.querySelector<HTMLElement>('[data-keep]')?.focus();
  }, [panel]);
  const chosen = local?.account ?? '';
  const signedIn = (accounts?.accounts ?? []).filter((a) => a.ok);
  // A chosen account the CLI no longer has is still shown, so the select never lies.
  const options = [
    { value: '', label: OWN_SIGN_IN },
    ...signedIn.map((a) => ({ value: a.login, label: a.login })),
    ...(chosen && !signedIn.some((a) => a.login === chosen)
      ? [{ value: chosen, label: `${chosen} (signed out)` }]
      : []),
  ];
  const openUrl = local?.openUrl ?? null;
  const menu: MenuItem[] = [
    ...(openUrl && status.primary !== 'open'
      ? [
          {
            kind: 'action' as const,
            id: 'open',
            label: 'Open folder',
            onSelect: () => window.open(openUrl, '_blank'),
          },
        ]
      : []),
    ...(status.check
      ? [
          {
            kind: 'action' as const,
            id: 'check',
            label: 'Check for changes now',
            disabled: off,
            onSelect: onCheck,
          },
        ]
      : []),
    ...(metaAvailable
      ? [
          {
            kind: 'action' as const,
            id: 'tags',
            label: 'Edit tags…',
            onSelect: () => setPanel('tags'),
          },
        ]
      : []),
    {
      kind: 'action',
      id: 'account',
      label: 'GitHub account…',
      disabled: !local,
      onSelect: () => setPanel('account'),
    },
    {
      kind: 'action',
      id: 'remove',
      label: 'Remove from cloud…',
      disabled: off,
      onSelect: () => setPanel('remove'),
    },
  ];
  return (
    <ProjectRowFrame
      layout={layout}
      name={project.name}
      favColumn={metaAvailable}
      fav={<FavToggle name={project.name} favorite={favorite} disabled={disabled} onFav={onFav} />}
      branch={project.repository.branch}
      tags={metaAvailable ? meta?.tags : undefined}
      path={path}
      home={home}
      lastActivityAt={lastActivityAt}
      repository={project.repository}
      status={status}
      button={
        <PrimaryButton
          status={status}
          openUrl={openUrl}
          disabled={off}
          onRun={(action) =>
            action === 'clone'
              ? onClone()
              : action === 'pull'
                ? onPull()
                : action === 'push' && onPush()
          }
        />
      }
      menu={
        <Menu
          label={`Actions for ${project.name}`}
          triggerLabel={`More actions for ${project.name}`}
          triggerIcon={<MoreActionsIcon />}
          align="end"
          sections={[{ id: 'row', items: menu }]}
        />
      }
    >
      {status.hint && <p className={styles.hint}>{status.hint}</p>}
      {checkError && <div className={styles.rowError}>{checkError}</div>}
      {panel === 'tags' && (
        <ProjectTags
          name={project.name}
          tags={meta?.tags ?? []}
          suggestions={tagSuggestions}
          disabled={disabled}
          onAdd={onAddTag}
          onRemove={onRemoveTag}
          onDone={() => setPanel(null)}
        />
      )}
      {panel === 'account' && (
        <div
          ref={panelRef}
          className={styles.rowPanel}
          role="group"
          aria-label={`GitHub account for ${project.name}`}
        >
          <Field className={styles.accountField} label="GitHub account">
            <NativeSelect
              value={chosen}
              disabled={off || !local}
              onChange={(value) => onAccount(value || null)}
              options={options}
            />
          </Field>
          <span className={styles.hint}>Clone, Pull and Push use it on this Mac.</span>
          <Button variant="quiet" onClick={() => setPanel(null)}>
            Done
          </Button>
        </div>
      )}
      {panel === 'remove' && (
        <div
          ref={panelRef}
          className={styles.rowPanel}
          role="group"
          aria-label={`Remove ${project.name}`}
        >
          <span className={styles.hint}>Remove from the cloud list? Folders stay.</span>
          <span className={styles.panelActions}>
            <Button
              variant="danger"
              size="sm"
              disabled={off}
              onClick={() => {
                setPanel(null);
                onRemove();
              }}
            >
              Remove
            </Button>
            <Button size="sm" data-keep onClick={() => setPanel(null)}>
              Keep
            </Button>
          </span>
        </div>
      )}
      {children}
    </ProjectRowFrame>
  );
}

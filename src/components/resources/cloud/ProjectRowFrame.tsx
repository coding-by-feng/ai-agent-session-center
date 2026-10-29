/**
 * ProjectRowFrame — what every Projects row shares (Oct 29 2026): the ♥ column, the name line
 * (name, branch, tags) and the facts line (folder, last session, GitHub repository), then the
 * state, one button and the ⋯ menu. A saved project's row (CloudProjectRow) and a folder's
 * (ProjectFolderRow) fill it in. An empty ♥ column keeps the names in line.
 *
 * As a card (the Projects grid, Oct 29 2026) the same parts stack: the name with the ♥ and ⋯ at
 * its right, the folder, the last session and repository, the tags, what the row adds, and at
 * the foot the state and the button, so the feet line up across a row of cards.
 */
import type { ReactNode } from 'react';
import type { GithubRepositorySchema } from '@/types/cloudProjects';
import type { ProjectViewMode } from '@/stores/uiStore';
import type { z } from 'zod';
import { relativeTime } from '@/lib/chat/chatFormat';
import Button from '@/components/ui/Button';
import { buttonClass } from '@/components/ui/buttonClass';
import Chip from '@/components/ui/Chip';
import IconButton from '@/components/ui/IconButton';
import { displayPath } from './projectList';
import type { ProjectAction, ProjectStatus } from './projectState';
import styles from '@/styles/modules/CloudResources.module.css';

const ACTION_LABEL: Record<ProjectAction, string> = {
  clone: 'Clone',
  pull: 'Pull',
  push: 'Push',
  open: 'Open',
  save: 'Save',
  link: 'Use this folder',
};

/** A saved project's ♥: on its own row, or on a folder that stands for it until one is linked. */
export function FavToggle({
  name,
  favorite,
  disabled,
  onFav,
}: {
  name: string;
  favorite: boolean;
  disabled: boolean;
  onFav: (favorite: boolean) => void;
}) {
  return (
    <IconButton
      label="Favourite"
      ariaLabel={`Favourite ${name}`}
      tone="warning"
      size="sm"
      pressed={favorite}
      tooltip={false}
      disabled={disabled}
      onClick={() => onFav(!favorite)}
    >
      <span aria-hidden="true">{favorite ? '♥' : '♡'}</span>
    </IconButton>
  );
}

/** The row's one button. Open is a link to the project browser; Pull and Push stand out. */
export function PrimaryButton({
  status,
  openUrl,
  disabled,
  onRun,
}: {
  status: ProjectStatus;
  openUrl: string | null;
  disabled: boolean;
  onRun: (action: ProjectAction) => void;
}) {
  const action = status.primary;
  if (!action) return null;
  if (action === 'open')
    return openUrl ? (
      <a className={buttonClass()} href={openUrl} target="_blank" rel="noopener noreferrer">
        Open
      </a>
    ) : null;
  return (
    <Button
      variant={action === 'pull' || action === 'push' ? 'primary' : 'default'}
      disabled={disabled || status.waits}
      onClick={() => onRun(action)}
    >
      {ACTION_LABEL[action]}
    </Button>
  );
}

/**
 * The repository's GitHub page, built from its owner and name: a record's `url` comes from the
 * cloud and is not checked to be GitHub's (security review, Oct 29 2026).
 */
function githubPage({ owner, name }: { owner: string; name: string }): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}
export default function ProjectRowFrame({
  layout = 'list',
  name,
  muted = false,
  favColumn,
  fav,
  branch,
  tags,
  path,
  home,
  lastActivityAt,
  repository,
  status,
  button,
  menu,
  children,
}: {
  name: string;
  /** A folder that can't sync from here: it reads quieter. */
  muted?: boolean;
  /** The list has a ♥ column (AASC Cloud keeps project tags). */
  favColumn: boolean;
  /** The ♥ toggle; absent on a row that can't have one. */
  fav?: ReactNode;
  branch?: string;
  tags?: readonly string[];
  path: string | null;
  home: string | null;
  lastActivityAt: number | null;
  repository: z.infer<typeof GithubRepositorySchema> | null;
  status: ProjectStatus;
  button: ReactNode;
  menu?: ReactNode;
  /** The hint, an error, an open panel and running jobs, under the row. */
  children?: ReactNode;
  /** 'card': a cell of the Projects grid. */
  layout?: ProjectViewMode;
}) {
  const folder = path ? displayPath(path, home) : null,
    when = lastActivityAt !== null ? relativeTime(lastActivityAt) : null;
  const repoLink = repository && (
    <a
      className={styles.repoLink}
      href={githubPage(repository)}
      target="_blank"
      rel="noopener noreferrer"
    >
      {repository.owner}/{repository.name}
    </a>
  );
  const tagLine = !!tags?.length && (
    <span className={styles.projectFact}>{tags.map((t) => `#${t}`).join(' ')}</span>
  );
  if (layout === 'card') {
    const tools = (favColumn && fav) || menu;
    return (
      <li className={[styles.projectCard, muted && styles.muted].filter(Boolean).join(' ')}>
        <div className={styles.cardHead}>
          <span className={styles.projectTitle}>
            <span className={styles.syncName}>{name}</span>
            {branch && <span className={styles.projectFact}>{branch}</span>}
          </span>
          {tools && (
            <span className={styles.cardTools}>
              {favColumn && fav}
              {menu}
            </span>
          )}
        </div>
        {folder && <span className={styles.hint}>{folder}</span>}
        {(when || repoLink) && (
          <span className={styles.hint}>
            {when}
            {when && repoLink && ' · '}
            {repoLink}
          </span>
        )}
        {tagLine}
        {children}
        <div className={styles.cardFoot}>
          <Chip tone={status.tone}>{status.label}</Chip>
          {button}
        </div>
      </li>
    );
  }
  const facts = [folder, when].filter((f): f is string => !!f);
  return (
    <li
      className={[styles.projectRow, favColumn && styles.withFav, muted && styles.muted]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.syncRow}>
        <div className={styles.projectHead}>
          {favColumn && <span className={styles.favSlot}>{fav}</span>}
          <div className={styles.syncMain}>
            <span className={styles.projectTitle}>
              <span className={styles.syncName}>{name}</span>
              {branch && <span className={styles.projectFact}>{branch}</span>}
              {tagLine}
            </span>
            <span className={styles.hint}>
              {facts.join(' · ')}
              {repoLink && (
                <>
                  {facts.length > 0 && ' · '}
                  {repoLink}
                </>
              )}
            </span>
          </div>
        </div>
        <div className={styles.syncSide}>
          <Chip tone={status.tone}>{status.label}</Chip>
          {button}
          {/* Kept when empty, so every row's button lines up. */}
          <span className={styles.menuSlot}>{menu}</span>
        </div>
      </div>
      {children}
    </li>
  );
}

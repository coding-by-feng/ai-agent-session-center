/**
 * CloudProjectRow — one saved project (AASC-63): its GitHub repository, whether it is on this
 * device and how it compares with GitHub, the GitHub account used for it here, and Clone / Pull /
 * Push / Check / Open. Remove asks once and never touches a folder.
 */
import { useState, type ReactNode } from 'react';
import type { GithubAccounts, LocalProject, ProjectRecord } from '@/types/cloudProjects';
import Button from '@/components/ui/Button';
import { buttonClass } from '@/components/ui/buttonClass';
import Chip from '@/components/ui/Chip';
import Field from '@/components/ui/Field';
import NativeSelect from '@/components/ui/NativeSelect';
import { projectStatus } from './projectState';
import styles from '@/styles/modules/CloudResources.module.css';

export const OWN_SIGN_IN = 'This Mac’s Git sign-in';

export default function CloudProjectRow({
  project,
  local,
  accounts,
  disabled,
  working,
  onClone,
  onPull,
  onPush,
  onCheck,
  onAccount,
  onRemove,
  children,
}: {
  project: ProjectRecord;
  local: LocalProject | undefined;
  accounts: GithubAccounts | null;
  /** No action can start (offline, busy, stale list). */
  disabled: boolean;
  /** A Clone, Pull or Push of this project is running. */
  working: boolean;
  onClone: () => void;
  onPull: () => void;
  onPush: () => void;
  onCheck: () => void;
  onAccount: (login: string | null) => void;
  onRemove: () => void;
  /** This project's running jobs. */
  children?: ReactNode;
}) {
  const [confirm, setConfirm] = useState(false);
  const status = projectStatus(local, project.repository.branch);
  const off = disabled || working;
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
  return (
    <li className={styles.projectRow}>
      <div className={styles.syncRow}>
        <div className={styles.syncMain}>
          <span className={styles.syncName}>{project.repository.name}</span>
          <a
            className={styles.repoLink}
            href={project.repository.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/{project.repository.owner}/{project.repository.name}
          </a>
          <span className={styles.hint}>
            {project.repository.branch}
            {local?.path ? ` · ${local.path}` : ''}
          </span>
        </div>
        {/* The account is a setting of this project here, so it sits with its state, not
            among the verbs: the action row then fits one line even at phone width. */}
        <div className={`${styles.syncSide} ${styles.projectSide}`}>
          <Chip tone={status.tone}>{status.label}</Chip>
          <Field className={styles.accountField} label="GitHub account">
            <NativeSelect
              value={chosen}
              disabled={off || !local}
              onChange={(value) => onAccount(value || null)}
              options={options}
            />
          </Field>
        </div>
      </div>
      {status.hint && <p className={styles.hint}>{status.hint}</p>}
      <div className={styles.toolbar}>
        {status.clone && (
          <Button variant="primary" disabled={off} onClick={onClone}>
            Clone
          </Button>
        )}
        {status.pull && (
          <Button variant="primary" disabled={off} onClick={onPull}>
            Pull
          </Button>
        )}
        {status.push && (
          <Button variant={status.pull ? 'default' : 'primary'} disabled={off} onClick={onPush}>
            Push
          </Button>
        )}
        {status.check && (
          <Button disabled={off} onClick={onCheck}>
            Check
          </Button>
        )}
        {local?.openUrl && (
          <a
            className={buttonClass()}
            href={local.openUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open
          </a>
        )}
        {!confirm ? (
          <Button className={styles.pushEnd} disabled={off} onClick={() => setConfirm(true)}>
            Remove
          </Button>
        ) : (
          <span className={`${styles.pushEnd} ${styles.confirm}`} role="group">
            <span className={styles.hint}>Remove from the cloud list? Folders stay.</span>
            <Button
              variant="danger"
              size="sm"
              disabled={off}
              onClick={() => {
                setConfirm(false);
                onRemove();
              }}
            >
              Remove
            </Button>
            <Button size="sm" onClick={() => setConfirm(false)}>
              Keep
            </Button>
          </span>
        )}
      </div>
      {children}
    </li>
  );
}

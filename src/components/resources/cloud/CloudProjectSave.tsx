/**
 * CloudProjectSave — "Save a project" (AASC-63): pick one of this Mac's git folders whose origin
 * is on GitHub, or paste a GitHub link. Only the repository's name, link and branch are saved to
 * the cloud; a folder picked here is linked on this Mac and its path never leaves it.
 */
import { useState } from 'react';
import { canonicalGithub, type ProjectCandidate } from '@/types/cloudProjects';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import TextInput from '@/components/ui/TextInput';
import styles from '@/styles/modules/CloudResources.module.css';

export interface SaveChoice {
  repository: ProjectCandidate['repository'];
  /** The folder it came from, linked on this Mac; absent for a pasted link. */
  localPath?: string;
}

export default function CloudProjectSave({
  candidates,
  loading,
  busy,
  disabled,
  onSave,
  onClose,
}: {
  candidates: ProjectCandidate[] | null;
  loading: boolean;
  busy: boolean;
  disabled: boolean;
  onSave: (choice: SaveChoice) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState(''),
    [link, setLink] = useState(''),
    [branch, setBranch] = useState('main');
  const url = canonicalGithub(link.trim().replace(/\/+$/, ''));
  const free = (candidates ?? []).filter((c) => !c.projectId);
  const chosen = free.find((c) => c.path === picked);
  const pasted: SaveChoice | null =
    url && branch.trim()
      ? {
          repository: {
            provider: 'github',
            owner: url.split('/')[3],
            name: url.split('/')[4],
            url,
            branch: branch.trim(),
          },
        }
      : null;
  const choice: SaveChoice | null = chosen
    ? { repository: chosen.repository, localPath: chosen.path }
    : link.trim()
      ? pasted
      : null;
  return (
    <div>
      <p className={styles.hint}>
        The cloud keeps only the repository’s name, link and branch. The project’s files stay on
        GitHub and on your devices.
      </p>
      <h4>From this Mac</h4>
      {loading && <EmptyState compact busy title="Looking for GitHub folders on this Mac…" />}
      {!loading && candidates && !candidates.length && (
        <p className={styles.hint}>
          No git folder with a GitHub origin was found in your projects.
        </p>
      )}
      {!!candidates?.length && (
        <ul className={styles.reviewList} aria-label="GitHub folders on this Mac">
          {candidates.map((c) => (
            <li key={c.path}>
              <label className={styles.check}>
                <input
                  type="radio"
                  name="cloud-project-folder"
                  value={c.path}
                  checked={picked === c.path}
                  disabled={!!c.projectId}
                  onChange={() => {
                    setPicked(c.path);
                    setLink('');
                  }}
                />
                <span className={styles.syncMain}>
                  <span className={styles.syncName}>
                    {c.repository.owner}/{c.repository.name}
                    {c.projectId ? ' · already saved' : ''}
                  </span>
                  <span className={styles.hint}>
                    {c.repository.branch} · {c.path}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <h4>Or paste a GitHub link</h4>
      <div className={styles.form}>
        <Field label="GitHub repository link">
          <TextInput
            value={link}
            placeholder="https://github.com/owner/repository"
            onChange={(e) => {
              setLink(e.target.value);
              setPicked('');
            }}
          />
        </Field>
        <Field label="Branch">
          <TextInput value={branch} onChange={(e) => setBranch(e.target.value)} />
        </Field>
      </div>
      {link.trim() && !url && (
        <div className={styles.error} role="alert">
          Use a link like https://github.com/owner/repository.
        </div>
      )}
      <div className={styles.toolbar}>
        <Button
          variant="primary"
          disabled={!choice || busy || disabled}
          onClick={() => choice && onSave(choice)}
        >
          Save to cloud
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

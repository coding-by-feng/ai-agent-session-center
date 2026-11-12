/**
 * CloudProjectSave — "Add a GitHub link" (AASC-63; a link only since Oct 29 2026, when this Mac's
 * GitHub folders moved into the Projects list, each with its own Save): save a repository that is
 * not on this Mac by its link and branch, so every device can clone it. Only the name, link and
 * branch reach the cloud.
 */
import { useState } from 'react';
import { canonicalGithub } from '@/types/cloudProjects';
import Button from '@/components/ui/Button';
import Field from '@/components/ui/Field';
import TextInput from '@/components/ui/TextInput';
import type { SaveChoice } from './projectState';
import styles from '@/styles/modules/CloudResources.module.css';

export default function CloudProjectSave({
  busy,
  disabled,
  onSave,
  onClose,
}: {
  busy: boolean;
  disabled: boolean;
  onSave: (choice: SaveChoice) => void;
  onClose: () => void;
}) {
  const [link, setLink] = useState(''),
    [branch, setBranch] = useState('main');
  const url = link.trim() ? canonicalGithub(link.trim().replace(/\/+$/, '')) : null;
  const choice: SaveChoice | null =
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
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (choice) onSave(choice);
      }}
    >
      <p className={styles.hint}>
        For a repository that is not on this Mac. Folders here are in the list already, each with
        its own Save.
      </p>
      <div className={styles.form}>
        <Field label="GitHub repository link">
          <TextInput
            value={link}
            placeholder="https://github.com/owner/repository"
            onChange={(e) => setLink(e.target.value)}
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
        <Button type="submit" variant="primary" disabled={!choice || busy || disabled}>
          Save to cloud
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

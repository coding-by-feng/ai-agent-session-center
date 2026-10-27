/**
 * CloudProjectSave — "Save projects to cloud" (AASC-63; multi-select since Oct 26 2026): tick any of
 * this Mac's git folders whose origin is on GitHub, or paste a GitHub link, and save them at once.
 * Only each repository's name, link and branch are saved to the cloud; a folder ticked here is
 * linked on this Mac and its path never leaves it. Each save reports on its own row.
 */
import { useState } from 'react';
import { canonicalGithub, type ProjectCandidate } from '@/types/cloudProjects';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import TextInput from '@/components/ui/TextInput';
import { choiceKey, type SaveChoice, type SaveResults } from './projectState';
import styles from '@/styles/modules/CloudResources.module.css';

function pastedChoice(link: string, branch: string): SaveChoice | null {
  const url = canonicalGithub(link.trim().replace(/\/+$/, ''));
  if (!url || !branch.trim()) return null;
  const [, , , owner, name] = url.split('/');
  return { repository: { provider: 'github', owner, name, url, branch: branch.trim() } };
}

export default function CloudProjectSave({
  candidates,
  loading,
  busy,
  disabled,
  results,
  onSave,
  onClose,
}: {
  candidates: ProjectCandidate[] | null;
  loading: boolean;
  busy: boolean;
  disabled: boolean;
  results: SaveResults;
  onSave: (choices: SaveChoice[]) => void;
  onClose: () => void;
}) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set()),
    [pasting, setPasting] = useState(false),
    [link, setLink] = useState(''),
    [branch, setBranch] = useState('main');
  const saved = (c: ProjectCandidate) => !!c.projectId || results[c.path]?.ok === true;
  const free = (candidates ?? []).filter((c) => !saved(c));
  const pasted = pasting && link.trim() ? pastedChoice(link, branch) : null;
  const pastedDone = pasted ? results[choiceKey(pasted)]?.ok === true : false;
  const choices: SaveChoice[] = [
    ...free
      .filter((c) => ticked.has(c.path))
      .map((c) => ({ repository: c.repository, localPath: c.path })),
    ...(pasted && !pastedDone ? [pasted] : []),
  ];
  const tried = Object.keys(results).length;
  const done = Object.values(results).filter((r) => r.ok).length;
  const allTicked = free.length > 0 && free.every((c) => ticked.has(c.path));
  const toggle = (path: string) =>
    setTicked((old) => {
      const next = new Set(old);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const failure = (key: string) => {
    const r = results[key];
    return r && !r.ok ? r.error : null;
  };
  return (
    <div>
      <p className={styles.hint}>
        Only the name, GitHub link and branch are saved. Folder paths stay on this Mac.
      </p>
      <div className={styles.saveHead}>
        <h4>From this Mac</h4>
        {free.length > 0 && (
          <Button
            size="sm"
            onClick={() => setTicked(allTicked ? new Set() : new Set(free.map((c) => c.path)))}
          >
            {allTicked ? 'Clear' : 'Select all'}
          </Button>
        )}
      </div>
      {loading && <EmptyState compact busy title="Looking for GitHub folders on this Mac…" />}
      {!loading && candidates && !candidates.length && (
        <p className={styles.hint}>
          No git folder with a GitHub origin was found in your projects.
        </p>
      )}
      {!!candidates?.length && (
        <ul className={styles.reviewList} aria-label="GitHub folders on this Mac">
          {candidates.map((c) => {
            const isSaved = saved(c),
              error = failure(c.path);
            return (
              <li key={c.path}>
                <label className={`${styles.check} ${styles.saveRow}`}>
                  <input
                    type="checkbox"
                    checked={isSaved || ticked.has(c.path)}
                    disabled={isSaved || busy}
                    onChange={() => toggle(c.path)}
                  />
                  <span className={styles.syncMain}>
                    <span className={styles.syncName}>{c.repository.name}</span>
                    <span className={styles.hint}>
                      {c.repository.owner} · {c.repository.branch}
                    </span>
                    <span className={styles.hint}>{c.path}</span>
                  </span>
                  {isSaved && <Chip tone="success">Saved</Chip>}
                </label>
                {error && <div className={styles.rowError}>{error}</div>}
              </li>
            );
          })}
        </ul>
      )}
      <Button
        variant="quiet"
        size="sm"
        aria-expanded={pasting}
        onClick={() => setPasting((open) => !open)}
      >
        <span aria-hidden="true">{pasting ? '▾' : '▸'}</span> Paste a GitHub link instead
      </Button>
      {pasting && (
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
      )}
      {pasting && link.trim() && !pasted && (
        <div className={styles.error} role="alert">
          Use a link like https://github.com/owner/repository.
        </div>
      )}
      {pasted && failure(choiceKey(pasted)) && (
        <div className={styles.rowError}>{failure(choiceKey(pasted))}</div>
      )}
      {tried > 0 && done < tried && (
        <p className={styles.hint} role="status">
          {done} of {tried} saved
        </p>
      )}
      <div className={styles.toolbar}>
        <Button
          variant="primary"
          disabled={!choices.length || busy || disabled}
          onClick={() => onSave(choices)}
        >
          {choices.length ? `Save ${choices.length} to cloud` : 'Save to cloud'}
        </Button>
        <Button onClick={onClose}>{done ? 'Done' : 'Cancel'}</Button>
      </div>
    </div>
  );
}

/**
 * ProjectTags — a saved project's tags (Oct 29 2026), opened from its row's ⋯ menu. They follow
 * the Library's rule (normalizeTag, at most 12) and live in AASC Cloud, so every device on the
 * account sees them. Each add or remove is sent at once; the row shows it while it goes.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { MAX_PROJECT_TAGS } from '@/types/cloudProjects';
import { MAX_TAG_CHARS, normalizeTag } from '@/lib/skillNotes';
import Button from '@/components/ui/Button';
import TextInput from '@/components/ui/TextInput';
import notes from '@/styles/modules/SkillNotes.module.css';
import styles from '@/styles/modules/CloudResources.module.css';

export default function ProjectTags({
  name,
  tags,
  suggestions,
  disabled,
  onAdd,
  onRemove,
  onDone,
}: {
  name: string;
  tags: readonly string[];
  /** Tags on the other projects, offered as you type. */
  suggestions: readonly string[];
  disabled: boolean;
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
  onDone: () => void;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(''),
    [error, setError] = useState<string | null>(null);
  const full = tags.length >= MAX_PROJECT_TAGS;
  // Opened from the ⋯ menu: the typing starts here.
  useEffect(() => input.current?.focus(), []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const tag = normalizeTag(draft);
    if (!tag) {
      setError('Use letters or digits in a tag.');
      return;
    }
    setError(null);
    setDraft('');
    if (!tags.includes(tag)) onAdd(tag);
  };
  return (
    <div className={styles.rowPanel} role="group" aria-label={`Tags for ${name}`}>
      {tags.length > 0 && (
        <ul className={notes.tags} aria-label="Tags">
          {tags.map((t) => (
            <li key={t} className={notes.tag}>
              <span>{t}</span>
              <button
                type="button"
                className={notes.tagRemove}
                disabled={disabled}
                aria-label={`Remove tag ${t}`}
                onClick={() => onRemove(t)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className={notes.inline} onSubmit={submit}>
        <TextInput
          ref={input}
          aria-label="Add a tag"
          list={listId}
          value={draft}
          maxLength={MAX_TAG_CHARS}
          placeholder={full ? `At most ${MAX_PROJECT_TAGS} tags` : 'Add a tag…'}
          disabled={disabled || full}
          onChange={(e) => setDraft(e.target.value)}
        />
        <datalist id={listId}>
          {suggestions
            .filter((s) => !tags.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
        <Button type="submit" disabled={disabled || full || !draft.trim()}>
          Add
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Done
        </Button>
      </form>
      {error && (
        <div role="alert" className={styles.rowError}>
          {error}
        </div>
      )}
    </div>
  );
}

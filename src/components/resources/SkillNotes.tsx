/**
 * SkillNotes — the user's own marks on a skill or command: a favourite flag,
 * any number of tags, and one abbreviation. Shown in the Library detail pane
 * (SkillNotes) and as a heart on each list row (FavToggle).
 *
 * The notes live in this browser (src/stores/skillNotesStore.ts) and are keyed
 * by `agent:name`, so they survive a rescan and a move. They never touch the
 * catalog. The one thing that reaches the disk is the opt-in "also work inside
 * Claude Code / Codex" switch, which asks the server to write (or remove) a
 * small command file (server/resourceAliases.ts) and shows exactly which.
 */
import { useId, useMemo, useState, type FormEvent } from 'react';
import type { ResourceSummary } from '@/types/resources';
import { createAliasCommand, errorMessage, removeAliasCommand, type AliasFileResult } from '@/lib/resourcesApi';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import {
  ABBR_RE,
  isNotable,
  MAX_TAG_CHARS,
  MAX_TAGS,
  noteForResource,
  resourceNoteKey,
  resourceNoteName,
  tagsInUse,
  validateAbbr,
} from '@/lib/skillNotes';
import Button from '@/components/ui/Button';
import IconButton from '@/components/ui/IconButton';
import TextInput from '@/components/ui/TextInput';
import styles from '@/styles/modules/SkillNotes.module.css';

/** The heart on a list row. Nothing for types that cannot carry notes. */
export function FavToggle({ resource }: { resource: ResourceSummary }) {
  const key = resourceNoteKey(resource);
  const fav = useSkillNotesStore((s) => s.notes[key]?.fav ?? false);
  const toggleFav = useSkillNotesStore((s) => s.toggleFav);
  if (!isNotable(resource)) return null;
  return (
    <IconButton
      className={styles.favToggle}
      label="Favourite"
      ariaLabel={`Favourite ${resource.name}`}
      tone="warning"
      size="sm"
      pressed={fav}
      tooltip={false}
      onClick={() => toggleFav(key)}
    >
      <span aria-hidden="true">{fav ? '♥' : '♡'}</span>
    </IconButton>
  );
}

/** Stable identity for "no tags", so the suggestions memo is not rebuilt every render. */
const NO_TAGS: readonly string[] = [];

type NoteResource = Pick<ResourceSummary, 'agent' | 'type' | 'name' | 'origin' | 'pluginName'>;

/** How each CLI types the abbreviation once its command file exists. */
function typedAs(agent: ResourceSummary['agent'], kind: string, abbr: string): string[] {
  const claude = `/${abbr}`;
  const codex = kind === 'skill' ? `$${abbr}` : `/prompts:${abbr}`;
  return agent === 'claude' ? [claude] : agent === 'codex' ? [codex] : [claude, codex];
}

function cliName(agent: ResourceSummary['agent']): string {
  return agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : 'Claude Code and Codex';
}

interface SkillNotesProps {
  resource: NoteResource & Partial<ResourceSummary>;
  /** `agent:name` keys of every real skill and command, so an abbreviation can't shadow one. */
  realNames: ReadonlySet<string>;
}

export default function SkillNotes({ resource, realNames }: SkillNotesProps) {
  const key = resourceNoteKey(resource);
  const headingId = useId();
  const listId = useId();
  const cliId = useId();
  const notes = useSkillNotesStore((s) => s.notes);
  const { toggleFav, addTag, removeTag, setAbbr, setCli } = useSkillNotesStore.getState();
  const own = notes[key];
  const merged = noteForResource(notes, resource);
  const tags = own?.tags ?? NO_TAGS;
  const abbr = own?.abbr ?? '';
  const cli = own?.cli === true;
  const [tagDraft, setTagDraft] = useState('');
  const [abbrDraft, setAbbrDraft] = useState(abbr);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<AliasFileResult[] | null>(null);
  const [removedNote, setRemovedNote] = useState<string | null>(null);
  // Tags already used elsewhere, offered as suggestions.
  const suggestions = useMemo(
    () => tagsInUse(notes).map((t) => t.tag).filter((t) => !tags.includes(t)),
    [notes, tags],
  );
  if (!isNotable(resource)) return null;

  const kind = resource.type === 'command' ? 'command' : 'skill';
  const target = resourceNoteName(resource);
  const aliasInput = (name: string) => ({ agent: resource.agent, kind, target, abbr: name }) as const;

  const submitTag = (e: FormEvent) => {
    e.preventDefault();
    if (!tagDraft.trim()) return;
    addTag(key, tagDraft);
    setTagDraft('');
  };

  /** Run one server call with the busy flag; returns false (and shows why) on failure. */
  const run = async <T,>(call: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await call();
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submitAbbr = async (e: FormEvent) => {
    e.preventDefault();
    const check = validateAbbr(abbrDraft, key, notes, realNames);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setError(null);
    setRemovedNote(null);
    if (cli && check.value !== abbr) {
      // Move the command: create the new one first, so a refusal leaves the old one working.
      const made = await run(() => createAliasCommand(aliasInput(check.value)));
      if (!made) return;
      setAbbr(key, check.value, realNames);
      setFiles(made.files);
      await removeAliasCommand({ agent: resource.agent, kind, abbr }).catch(() => undefined);
    } else {
      setAbbr(key, check.value, realNames);
    }
    setAbbrDraft(check.value);
  };

  const clearAbbr = async () => {
    setRemovedNote(null);
    if (cli) {
      const gone = await run(() => removeAliasCommand({ agent: resource.agent, kind, abbr }));
      if (!gone) return;
    }
    setAbbr(key, '', realNames);
    setAbbrDraft('');
    setError(null);
    setFiles(null);
  };

  const toggleCli = async (on: boolean) => {
    setRemovedNote(null);
    if (on) {
      const made = await run(() => createAliasCommand(aliasInput(abbr)));
      if (!made) return;
      setCli(key, true);
      setFiles(made.files);
    } else {
      const gone = await run(() => removeAliasCommand({ agent: resource.agent, kind, abbr }));
      if (!gone) return;
      setCli(key, false);
      setFiles(null);
      const kept = gone.files.filter((f) => f.action === 'kept');
      setRemovedNote(kept.length > 0
        ? `Removed. ${kept.map((f) => f.path).join(', ')} was not made by AASC, so it was left alone.`
        : 'Removed the command file.');
    }
  };

  const typed = typedAs(resource.agent, kind, abbr || 'abbr');

  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.heading}>
        My notes <span className={styles.scope}>· this browser only</span>
      </h3>

      <div className={styles.row}>
        <IconButton
          label="Favourite"
          ariaLabel={`Favourite ${resource.name}`}
          tone="warning"
          pressed={own?.fav ?? false}
          tooltip={false}
          onClick={() => toggleFav(key)}
        >
          <span aria-hidden="true">{own?.fav ? '♥' : '♡'}</span>
        </IconButton>
        <span className={styles.caption}>{own?.fav ? 'Favourite' : 'Not a favourite'}</span>
        {resource.agent !== 'shared' && merged && merged.fav && !own?.fav && (
          <span className={styles.caption}>(favourite through the shared copy)</span>
        )}
      </div>

      <div className={styles.block}>
        <span className={styles.label}>Tags</span>
        {tags.length > 0 && (
          <ul className={styles.tags} aria-label="Tags">
            {tags.map((t) => (
              <li key={t} className={styles.tag}>
                <span>{t}</span>
                <button type="button" className={styles.tagRemove} aria-label={`Remove tag ${t}`} onClick={() => removeTag(key, t)}>
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className={styles.inline} onSubmit={submitTag}>
          <TextInput
            aria-label="Add a tag"
            list={listId}
            value={tagDraft}
            maxLength={MAX_TAG_CHARS}
            placeholder={tags.length >= MAX_TAGS ? `At most ${MAX_TAGS} tags` : 'Add a tag…'}
            disabled={tags.length >= MAX_TAGS}
            onChange={(e) => setTagDraft(e.target.value)}
          />
          <datalist id={listId}>
            {suggestions.map((t) => <option key={t} value={t} />)}
          </datalist>
          <Button type="submit" size="sm" disabled={!tagDraft.trim() || tags.length >= MAX_TAGS}>Add</Button>
        </form>
      </div>

      <div className={styles.block}>
        <span className={styles.label}>Abbreviation</span>
        <form className={styles.inline} onSubmit={submitAbbr}>
          <TextInput
            aria-label="Abbreviation"
            aria-invalid={error ? true : undefined}
            value={abbrDraft}
            maxLength={12}
            pattern={ABBR_RE.source}
            placeholder="e.g. rar"
            autoCapitalize="none"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => { setAbbrDraft(e.target.value); setError(null); }}
          />
          <Button type="submit" size="sm" disabled={busy || abbrDraft.trim().toLowerCase() === abbr}>Save abbreviation</Button>
          {abbr && <Button size="sm" disabled={busy} onClick={() => void clearAbbr()}>Clear abbreviation</Button>}
        </form>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <p className={styles.hint}>
          In AASC&apos;s prompt box, typing {typed.join(' or ')} finds this skill and inserts its full name.
        </p>
        {abbr && (
          <div className={styles.cliBlock}>
            <label className={styles.cliLabel} htmlFor={cliId}>
              <input
                id={cliId}
                type="checkbox"
                checked={cli}
                disabled={busy}
                onChange={(e) => void toggleCli(e.target.checked)}
              />
              <span>{`Also work inside ${cliName(resource.agent)} (${typedAs(resource.agent, kind, abbr).join(', ')})`}</span>
            </label>
            <p className={styles.hint}>
              Writes a small command file in ~/.{resource.agent === 'codex' ? 'codex' : resource.agent === 'claude' ? 'claude' : 'claude and ~/.codex'}.
              AASC only ever changes files it wrote itself.
            </p>
            {files && files.length > 0 && (
              <ul className={styles.fileList} aria-label="Command files">
                {files.map((f) => (
                  <li key={f.path}><code>{f.path}</code> <span className={styles.caption}>{f.action}</span></li>
                ))}
              </ul>
            )}
            {removedNote && <p className={styles.hint} role="status">{removedNote}</p>}
          </div>
        )}
      </div>
    </section>
  );
}

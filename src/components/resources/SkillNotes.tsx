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
import { useEffect, useRef, useId, useMemo, useState, type FormEvent } from 'react';
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
  const ready = useSkillNotesStore((s) => s.ready);
  if (!isNotable(resource)) return null;
  return (
    <IconButton
      className={styles.favToggle}
      label="Favourite"
      ariaLabel={`Favourite ${resource.name}`}
      tone="warning"
      size="sm"
      disabled={!ready}
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

/** Selection/readiness boundaries remount only the small notes editor, not the detail pane. */
export default function SkillNotes(props: SkillNotesProps) {
  const ready = useSkillNotesStore(s => s.ready);
  const generation = useSkillNotesStore(s => s.selectionGeneration);
  const identity = useSkillNotesStore(s => s.identity);
  const scope = identity ? [identity.backendOrigin, identity.accountId, identity.profileId, identity.generation] : null;
  return <SkillNotesEditor key={JSON.stringify([resourceNoteKey(props.resource), scope, generation, ready])} {...props}/>;
}

function SkillNotesEditor({ resource, realNames }: SkillNotesProps) {
  const key = resourceNoteKey(resource);
  const headingId = useId();
  const listId = useId();
  const cliId = useId();
  const notes = useSkillNotesStore((s) => s.notes);
  const ready = useSkillNotesStore((s) => s.ready);
  const sync = useSkillNotesStore((s) => s.sync);
  const identity = useSkillNotesStore((s) => s.identity);
  const syncMessage = useSkillNotesStore((s) => s.message);
  const historyReset = useSkillNotesStore((s) => s.historyReset);
  const { toggleFav, addTag, removeTag, setAbbr, setCli } = useSkillNotesStore.getState();
  const own = notes[key];
  const merged = noteForResource(notes, resource);
  const tags = own?.tags ?? NO_TAGS;
  const abbr = own?.abbr ?? '';
  const cli = own?.cli === true;
  const [tagDraft, setTagDraft] = useState('');
  const [abbrEdit, setAbbrEdit] = useState({ value: abbr, dirty: false });
  const abbrDraft = abbrEdit.dirty ? abbrEdit.value : abbr;
  const setAbbrDraft = (value: string, dirty = false) => setAbbrEdit({ value, dirty });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selectionScope = (value: typeof identity) => JSON.stringify(value ? [value.backendOrigin, value.accountId, value.profileId, value.generation] : null);
  const captureSelection = () => {
    const generation = useSkillNotesStore.getState().selectionGeneration;
    const scope = selectionScope(identity);
    return () => { const current = useSkillNotesStore.getState(); return mounted.current && current.ready && current.selectionGeneration === generation && selectionScope(current.identity) === scope; };
  };
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
  const run = async <T,>(call: () => Promise<T>, current: () => boolean): Promise<T | null> => {
    if (!current()) return null;
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      return current() ? result : null;
    } catch (err) {
      if (current()) setError(errorMessage(err));
      return null;
    } finally {
      if (current()) setBusy(false);
    }
  };

  const submitAbbr = async (e: FormEvent) => {
    e.preventDefault();
    const current = captureSelection();
    if (!current()) return;
    const check = validateAbbr(abbrDraft, key, notes, realNames);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setError(null);
    setRemovedNote(null);
    if (!identity && cli && check.value !== abbr) {
      // Move the command: create the new one first, so a refusal leaves the old one working.
      const made = await run(() => createAliasCommand(aliasInput(check.value)), current);
      if (!made || !current()) return;
      setAbbr(key, check.value, realNames);
      setFiles(made.files);
      if (current()) await removeAliasCommand({ agent: resource.agent, kind, abbr }).catch(() => undefined);
      if (!current()) return;
    } else {
      setAbbr(key, check.value, realNames);
    }
    setAbbrDraft(check.value);
  };

  const clearAbbr = async () => {
    const current = captureSelection();
    if (!current()) return;
    setRemovedNote(null);
    if (!identity && cli) {
      const gone = await run(() => removeAliasCommand({ agent: resource.agent, kind, abbr }), current);
      if (!gone || !current()) return;
    }
    setAbbr(key, '', realNames);
    setAbbrDraft('');
    setError(null);
    setFiles(null);
  };

  const toggleCli = async (on: boolean) => {
    const current = captureSelection();
    if (!current()) return;
    setRemovedNote(null);
    if (identity) { setCli(key, on); return; }
    if (on) {
      const made = await run(() => createAliasCommand(aliasInput(abbr)), current);
      if (!made || !current()) return;
      setCli(key, true);
      setFiles(made.files);
    } else {
      const gone = await run(() => removeAliasCommand({ agent: resource.agent, kind, abbr }), current);
      if (!gone || !current()) return;
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
        My notes <span className={styles.scope}>· {identity ? 'cloud account · saved on this device' : 'local notes'}</span>
      </h3>

      {historyReset && <p role="status" className={styles.hint}>Server note history was resynchronized. Pending edits were preserved for review.</p>}
      {!ready && sync.state !== 'error' && <p role="status" className={styles.hint}>Loading saved notes. Editing will be available when the active notes finish loading.</p>}
      {!sync.durable && (ready || syncMessage) && <p role="status" className={styles.hint}>{syncMessage ?? 'Saving notes on this device…'}</p>}
      {sync.durable && identity && <p role="status" className={styles.hint}>{sync.pending} pending · {sync.conflicts} need review{sync.state === 'off' || sync.state === 'offline' ? ' · offline' : ''}</p>}
      {sync.durable && syncMessage && <p role="alert" className={styles.error}>{syncMessage}</p>}

      <div className={styles.row}>
        <IconButton
          label="Favourite"
          ariaLabel={`Favourite ${resource.name}`}
          tone="warning"
          disabled={!ready}
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
                <button type="button" disabled={!ready} className={styles.tagRemove} aria-label={`Remove tag ${t}`} onClick={() => removeTag(key, t)}>
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
            disabled={!ready || tags.length >= MAX_TAGS}
            onChange={(e) => setTagDraft(e.target.value)}
          />
          <datalist id={listId}>
            {suggestions.map((t) => <option key={t} value={t} />)}
          </datalist>
          <Button type="submit" size="sm" disabled={!ready || !tagDraft.trim() || tags.length >= MAX_TAGS}>Add</Button>
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
            disabled={!ready || busy}
            onChange={(e) => { setAbbrDraft(e.target.value, e.target.value !== abbr); setError(null); }}
          />
          <Button type="submit" size="sm" disabled={!ready || busy || abbrDraft.trim().toLowerCase() === abbr}>Save abbreviation</Button>
          {abbr && <Button size="sm" disabled={!ready || busy} onClick={() => void clearAbbr()}>Clear abbreviation</Button>}
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
                disabled={!ready || busy}
                onChange={(e) => void toggleCli(e.target.checked)}
              />
              <span>{identity ? 'Use this abbreviation as a CLI command on my devices' : `Also work inside ${cliName(resource.agent)} (${typedAs(resource.agent, kind, abbr).join(', ')})`}</span>
            </label>
            {identity ? <p className={styles.hint}>Desired state: {cli ? 'CLI alias requested' : 'CLI alias off'}. Saved with your cloud notes; this device writes no command file for it.</p> : <p className={styles.hint}>
              Writes a small command file in ~/.{resource.agent === 'codex' ? 'codex' : resource.agent === 'claude' ? 'claude' : 'claude and ~/.codex'}.
              AASC only ever changes files it wrote itself.
            </p>}
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

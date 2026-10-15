/**
 * PhoneSuggestionBar — a row of suggestions above the phone keyboard (AASC-20,
 * feature 70), for the queue's compose box and the terminal's.
 *
 * - While a `/name` (or, on Codex, `$name`) fragment is under the caret it
 *   offers the matching commands and skills; a tap replaces the fragment.
 * - With nothing typed at the caret it offers the user's favourite skills, and
 *   `/` (plus `$` on Codex), which a phone keyboard keeps a layer away.
 * - Favourites rank first. A phone has no skill notes of its own: they come from
 *   the Mac (`fetchPhoneSkillNotes`), and with no cloud connection there are none,
 *   so the commands rank plainly.
 *
 * Shown while its compose box has focus (the keyboard is up) or a fragment is
 * being typed. A tap never takes focus from the box: the keyboard stays up.
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchCommandIndex, type CommandEntry, type CommandKind } from '@/lib/commandIndex';
import { parseTrigger } from '@/lib/autocompleteTrigger';
import { detectCli } from '@/lib/cliDetect';
import {
  favoriteSuggestions,
  fetchPhoneSkillNotes,
  insertSigil,
  insertSuggestion,
  mergeNotes,
  rankSuggestions,
  type Suggestion,
} from '@/lib/phoneSuggestions';
import type { SkillNotes } from '@/lib/skillNotes';
import { useSessionStore } from '@/stores/sessionStore';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import styles from '@/styles/modules/PhoneSuggestionBar.module.css';

export interface PhoneSuggestionBarProps {
  text: string;
  onChange: (next: string) => void;
  /** The compose box served: its caret decides what is offered, and it keeps focus on a tap. */
  textarea: HTMLTextAreaElement | null;
  sessionId: string | null;
  projectPath?: string | null;
  disabled?: boolean;
  className?: string;
}

/** Follow a textarea's focus and caret through its own events. */
function useCaret(textarea: HTMLTextAreaElement | null): {
  focused: boolean;
  caret: number | null;
  /** Where a programmatic edit left the caret (setting `value` fires no event of its own). */
  moveCaret: (at: number) => void;
} {
  const [state, setState] = useState<{ el: HTMLTextAreaElement | null; focused: boolean; caret: number | null }>({
    el: null,
    focused: false,
    caret: null,
  });
  useEffect(() => {
    if (!textarea) return;
    const sync = () =>
      setState({ el: textarea, focused: document.activeElement === textarea, caret: textarea.selectionStart });
    const blur = () => setState((s) => ({ ...s, el: textarea, focused: false }));
    const events = ['focus', 'input', 'keyup', 'click', 'select'] as const;
    for (const e of events) textarea.addEventListener(e, sync);
    textarea.addEventListener('blur', blur);
    const onSelection = () => {
      if (document.activeElement === textarea) sync();
    };
    document.addEventListener('selectionchange', onSelection);
    return () => {
      for (const e of events) textarea.removeEventListener(e, sync);
      textarea.removeEventListener('blur', blur);
      document.removeEventListener('selectionchange', onSelection);
    };
  }, [textarea]);
  const moveCaret = (at: number) => setState({ el: textarea, focused: true, caret: at });
  // A swapped textarea starts over (focus and caret belonged to the old one).
  return state.el === textarea
    ? { focused: state.focused, caret: state.caret, moveCaret }
    : { focused: false, caret: null, moveCaret };
}

function chipLabel(s: Suggestion): string {
  return [s.token, s.fav ? 'favourite' : '', s.abbr ? `abbreviation ${s.abbr}` : ''].filter(Boolean).join(', ');
}

export default function PhoneSuggestionBar({
  text,
  onChange,
  textarea,
  sessionId,
  projectPath,
  disabled = false,
  className,
}: PhoneSuggestionBarProps) {
  const cli = useSessionStore((s) => {
    const session = sessionId ? s.sessions.get(sessionId) : undefined;
    return (session && detectCli(session)) || 'claude';
  });
  // The terminal's box passes no project: the session's own (shared) one lists its project commands.
  const sessionProject = useSessionStore((s) => (sessionId ? s.sessions.get(sessionId)?.projectPath ?? null : null));
  const project = projectPath !== undefined ? projectPath : sessionProject;
  const localNotes = useSkillNotesStore((s) => s.notes);
  const [remoteNotes, setRemoteNotes] = useState<SkillNotes>({});
  const [index, setIndex] = useState<{ key: string; entries: CommandEntry[] }>({ key: '', entries: [] });
  const indexKey = `${cli}|${project ?? ''}`;
  const { focused, caret, moveCaret } = useCaret(textarea);

  const pos = Math.min(caret ?? text.length, text.length);
  const raw = parseTrigger(text, pos);
  // `$` is a Codex sigil; on Claude it is ordinary text ($HOME, a price). `@` is the file menu's.
  const trigger = raw && (raw.type === 'command' || (raw.type === 'skill' && cli === 'codex')) ? raw : null;
  // Asked for only once the bar is wanted: a terminal that is never typed into fetches nothing.
  const wanted = !disabled && (focused || !!trigger);

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void fetchPhoneSkillNotes().then((notes) => {
      if (live) setRemoteNotes(notes);
    });
    return () => {
      live = false;
    };
  }, [wanted]);

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void fetchCommandIndex(cli, project ?? null).then((entries) => {
      if (live) setIndex({ key: indexKey, entries });
    });
    return () => {
      live = false;
    };
  }, [wanted, cli, project, indexKey]);

  const notes = useMemo(() => mergeNotes(remoteNotes, localNotes), [remoteNotes, localNotes]);
  const entries = useMemo(() => (index.key === indexKey ? index.entries : []), [index, indexKey]);

  const suggestions = useMemo(() => {
    if (trigger) {
      const kinds: CommandKind[] =
        trigger.type === 'skill' ? ['skill'] : cli === 'codex' ? ['command'] : ['command', 'skill'];
      return rankSuggestions(entries, trigger.query, kinds, notes);
    }
    return favoriteSuggestions(entries, ['command', 'skill'], notes);
  }, [trigger, entries, notes, cli]);

  if (!wanted) return null;

  const put = (token: string, triggerStart: number | null) => {
    const next = insertSuggestion(text, pos, token, triggerStart);
    onChange(next.text);
    const at = next.caret;
    moveCaret(at);
    setTimeout(() => {
      textarea?.focus();
      textarea?.setSelectionRange(at, at);
    }, 0);
  };

  // A sigil starts a word: it is inserted bare, so the matching list opens next.
  const sigils = trigger ? [] : cli === 'codex' ? ['/', '$'] : ['/'];

  return (
    <div className={`${styles.bar}${className ? ` ${className}` : ''}`} role="toolbar" aria-label="Suggestions" data-phone-suggestions="">
      {sigils.map((sigil) => (
        <button
          key={sigil}
          type="button"
          className={`${styles.chip} ${styles.sigil}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const next = insertSigil(text, pos, sigil);
            onChange(next.text);
            moveCaret(next.caret);
            setTimeout(() => {
              textarea?.focus();
              textarea?.setSelectionRange(next.caret, next.caret);
            }, 0);
          }}
          aria-label={sigil === '/' ? 'Type a command' : 'Type a skill'}
        >
          {sigil}
        </button>
      ))}
      {suggestions.map((s) => (
        <button
          key={s.token}
          type="button"
          className={`${styles.chip}${s.fav ? ` ${styles.fav}` : ''}`}
          // Keep the compose box's focus (and the keyboard) where it is.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => put(s.token, trigger?.triggerStart ?? null)}
          aria-label={chipLabel(s)}
        >
          {s.fav && <span className={styles.heart} aria-hidden="true">♥</span>}
          <span className={styles.token}>{s.token}</span>
          {s.abbr && <span className={styles.abbr} aria-hidden="true">{s.abbr}</span>}
        </button>
      ))}
      {trigger && suggestions.length === 0 && (
        <span className={styles.empty} role="status">
          {entries.length === 0 ? 'Loading commands…' : `No command matches “${trigger.query}”`}
        </span>
      )}
    </div>
  );
}

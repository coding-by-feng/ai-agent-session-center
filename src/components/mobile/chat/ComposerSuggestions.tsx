/**
 * ComposerSuggestions — the commands and skills a `/prefix` matches, listed just
 * above the Chat box (Oct 21 2026: typing `/krt-wor` mid-prompt listed nothing).
 *
 *   ♥ /krt-work    Work the requirement queue…
 *     /krt-update  Read or change an existing item…
 *   ┌───────────────────────────────────────────┐
 *   │ /krt-wor▌ take EE-86                       │
 *
 * - The fragment is the word before the caret (`parseTrigger`), so it works mid-prompt.
 * - `/` lists commands and skills on both CLIs, each by its own token (a Codex skill
 *   goes in as `$name`); `$` lists skills on Codex only (`chatSuggestionKinds`).
 * - Ranked like the suggestion bar (`rankSuggestions`: favourites, prefix, A–Z).
 * - In the footer's flow, not floating: the footer clips overflow.
 * - Rows keep the box's focus, so the keyboard stays up. Escape closes the list
 *   for the fragment under the caret.
 * - The caret is followed HERE, never in the Composer: a caret update in the box's
 *   owner re-renders it between the browser's input listeners, before React's own
 *   onChange, and the controlled value snaps back (every keystroke was lost).
 */
import { useEffect, useState } from 'react';
import { parseTrigger } from '@/lib/autocompleteTrigger';
import { entryToken } from '@/lib/commandIndex';
import { chatSuggestionKinds, insertSuggestion, rankSuggestions } from '@/lib/phoneSuggestions';
import { pickerSheetFor } from '@/lib/chat/composerAction';
import { usePhoneCommandIndex } from '../usePhoneCommandIndex';
import { useTextareaCaret } from '../useTextareaCaret';
import styles from '@/styles/modules/mobile/Composer.module.css';

export interface ComposerSuggestionsProps {
  cli: 'claude' | 'codex';
  projectPath: string | null;
  /** The box's text and the box itself (its caret decides the fragment). */
  text: string;
  textarea: HTMLTextAreaElement | null;
  disabled: boolean;
  onChange: (next: string) => void;
  /** /model or /effort was picked: its sheet sends it; `text` is the box without the fragment. */
  onPicker: (focus: 'model' | 'effort', text: string) => void;
}

export default function ComposerSuggestions({ cli, projectPath, text, textarea, disabled, onChange, onPicker }: ComposerSuggestionsProps) {
  const { focused, caret, moveCaret } = useTextareaCaret(textarea);
  /** Where the fragment Escape closed the list starts; a fragment elsewhere lists again. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  const pos = Math.min(caret ?? text.length, text.length);
  const raw = focused && !disabled ? parseTrigger(text, pos) : null;
  const kinds = raw ? chatSuggestionKinds(raw.type, cli) : null;
  const live = raw && kinds ? raw : null;
  if (dismissedAt !== null && live?.triggerStart !== dismissedAt) setDismissedAt(null);
  const trigger = live && live.triggerStart !== dismissedAt ? live : null;

  const { entries, notes } = usePhoneCommandIndex(cli, projectPath, !!live);
  // Worked out each render: a filter and sort over a few hundred entries, and a useMemo
  // here can't be kept by the compiler (the Escape reset above sets state while rendering).
  const byToken = new Map(entries.map((e) => [entryToken(e), e]));
  const matches = trigger && kinds ? rankSuggestions(entries, trigger.query, kinds, notes) : [];
  const start = trigger?.triggerStart ?? null;
  const showing = start !== null && matches.length > 0;

  useEffect(() => {
    if (!textarea || !showing || start === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setDismissedAt(start);
    };
    textarea.addEventListener('keydown', onKey);
    return () => textarea.removeEventListener('keydown', onKey);
  }, [textarea, showing, start]);

  if (!showing || start === null) return null;

  const pick = (token: string) => {
    const entry = byToken.get(token);
    if (!entry) return;
    const picker = pickerSheetFor(entry);
    if (picker) {
      onPicker(picker, text.slice(0, start) + text.slice(pos));
      return;
    }
    const next = insertSuggestion(text, pos, token, start);
    onChange(next.text);
    moveCaret(next.caret);
    setTimeout(() => {
      textarea?.focus();
      textarea?.setSelectionRange(next.caret, next.caret);
    }, 0);
  };

  return (
    <section className={styles.suggestions} aria-label="Matching commands and skills" data-testid="composer-suggestions">
      <ul className={styles.suggestionList}>
        {matches.map((s) => {
          const description = byToken.get(s.token)?.description;
          return (
            <li key={s.token}>
              <button
                type="button"
                className={styles.suggestion}
                // Keep the box's focus (and the keyboard) where it is.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s.token)}
              >
                {s.fav && <span className={styles.suggestionFav} aria-label="favourite">♥</span>}
                <span className={styles.suggestionToken}>{s.token}</span>
                {description && <span className={styles.suggestionDesc}>{description}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

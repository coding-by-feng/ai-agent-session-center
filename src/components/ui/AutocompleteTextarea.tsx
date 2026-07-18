/**
 * AutocompleteTextarea — controlled textarea with `/` slash-command + `@`
 * file-reference autocomplete.
 *
 * Originally inlined in `QueueTab.tsx`. Lifted out so the same UX is
 * available in `QueueItemEditModal` (main prompt + every before/after
 * chain step) without copy-pasting ~250 lines of state.
 *
 * Behavior:
 *   - Typing `/foo` at start-of-text or after whitespace fetches the session's
 *     CLI command/skill index, filtered by the fragment, and shows a dropdown.
 *   - Typing `@foo` does the same for project files (debounced 150 ms).
 *   - ArrowUp / ArrowDown navigate; Enter inserts; Escape closes.
 *   - Cmd/Ctrl+Enter and other modifier-keys fall through to the parent's
 *     `onKeyDown` so existing keyboard shortcuts keep working.
 *   - Dropdown direction auto-detects: opens DOWN if there's enough room
 *     below the textarea, otherwise UP. Width matches the textarea.
 *
 * Parent contract:
 *   - Parent owns the text via `value` + `onChange`.
 *   - Parent passes `sessionId` so the component can pick the right CLI for
 *     command/skill lookups and the right project path for `@` files.
 *   - `projectPath` is optional — when missing, `@` autocomplete is silently
 *     disabled (we don't have a directory to search).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// `useRef` is still used for the debounce timer ref.
import {
  fetchCommandIndex,
  filterAndGroup,
  entryDisplayName,
  type CommandGroup,
} from '@/lib/commandIndex';
import { detectCli } from '@/lib/cliDetect';
import { useSessionStore } from '@/stores/sessionStore';
import styles from '@/styles/modules/AutocompleteTextarea.module.css';

interface AcItem {
  label: string;
  insert: string;
  sub?: string;
  /** Drives the icon shown before the label. */
  kind?: 'command' | 'skill' | 'file';
}

interface AcMenu {
  type: 'command' | 'file';
  query: string;
  items: AcItem[];
  groups?: Array<{ title: string; startIdx: number; count: number }>;
  selectedIdx: number;
  triggerStart: number;
}

interface AutocompleteTextareaProps {
  value: string;
  onChange: (next: string) => void;
  sessionId: string;
  projectPath?: string | null;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  className?: string;
  /** Forwarded to the underlying <textarea> AFTER the autocomplete has had
   *  its turn. The autocomplete only intercepts ArrowUp/Down/Enter/Escape
   *  while its dropdown is open. Cmd/Ctrl+Enter, Tab, etc. fall through. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
  /** Forwarded directly. Useful if the parent wraps the textarea in a
   *  drop-zone overlay. */
  onDragOver?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  ariaLabel?: string;
}

const DROPDOWN_MIN_DOWN_HEIGHT = 220;

function parseTrigger(
  text: string,
  pos: number,
): { type: 'command' | 'file'; query: string; triggerStart: number } | null {
  const before = text.slice(0, pos);
  const atIdx = before.lastIndexOf('@');
  if (atIdx >= 0 && (atIdx === 0 || /\s/.test(before[atIdx - 1]))) {
    const frag = before.slice(atIdx + 1);
    if (!frag.includes(' ')) return { type: 'file', query: frag, triggerStart: atIdx };
  }
  const slashIdx = before.lastIndexOf('/');
  if (slashIdx >= 0 && (slashIdx === 0 || /\s/.test(before[slashIdx - 1]))) {
    const frag = before.slice(slashIdx + 1);
    if (!frag.includes(' ')) return { type: 'command', query: frag, triggerStart: slashIdx };
  }
  return null;
}

function commandEntriesToMenu(groups: CommandGroup[]): {
  items: AcItem[];
  groupSpans: Array<{ title: string; startIdx: number; count: number }>;
} {
  const items: AcItem[] = [];
  const groupSpans: Array<{ title: string; startIdx: number; count: number }> = [];
  for (const g of groups) {
    const startIdx = items.length;
    for (const e of g.entries) {
      const display = entryDisplayName(e);
      items.push({
        label: '/' + display,
        insert: '/' + display,
        sub: e.description || (e.kind === 'skill' ? 'skill' : 'command'),
        kind: e.kind,
      });
    }
    if (items.length > startIdx) {
      groupSpans.push({ title: g.title, startIdx, count: items.length - startIdx });
    }
  }
  return { items, groupSpans };
}

function sessionCli(sessionId: string): 'claude' | 'codex' | 'gemini' {
  const session = useSessionStore.getState().sessions.get(sessionId);
  if (!session) return 'claude';
  const cli = detectCli(session);
  return cli ?? 'claude';
}

export default function AutocompleteTextarea({
  value,
  onChange,
  sessionId,
  projectPath,
  placeholder,
  rows = 2,
  autoFocus,
  className,
  onKeyDown,
  onPaste,
  onBlur,
  onDragOver,
  onDrop,
  ariaLabel,
}: AutocompleteTextareaProps) {
  // Hold the textarea element as state so dropdown-position math can run in
  // a useMemo without tripping React 19's "no ref reads during render" rule.
  const [textarea, setTextarea] = useState<HTMLTextAreaElement | null>(null);
  const [acMenu, setAcMenu] = useState<AcMenu | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  // Trigger detection on every text change.
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      const pos = e.target.selectionStart ?? next.length;
      onChange(next);

      const trigger = parseTrigger(next, pos);
      if (!trigger) {
        setAcMenu(null);
        return;
      }

      if (trigger.type === 'command') {
        const cli = sessionCli(sessionId);
        setAcMenu((prev) =>
          prev?.type === 'command'
            ? { ...prev, query: trigger.query, triggerStart: trigger.triggerStart, selectedIdx: 0 }
            : {
                type: 'command',
                query: trigger.query,
                items: [],
                groups: [],
                selectedIdx: 0,
                triggerStart: trigger.triggerStart,
              },
        );
        void (async () => {
          const entries = await fetchCommandIndex(cli, projectPath ?? null);
          const cmdGroups = filterAndGroup(entries, trigger.query, 'command');
          const skillGroups = filterAndGroup(entries, trigger.query, 'skill');
          const merged = new Map<string, CommandGroup>();
          const order: string[] = [];
          for (const g of [...cmdGroups, ...skillGroups]) {
            const key = g.title;
            if (!merged.has(key)) {
              merged.set(key, { title: g.title, source: g.source, entries: [] });
              order.push(key);
            }
            merged.get(key)!.entries.push(...g.entries);
          }
          const { items, groupSpans } = commandEntriesToMenu(
            order.map((k) => merged.get(k)!),
          );
          setAcMenu((prev) =>
            prev && prev.type === 'command' && prev.triggerStart === trigger.triggerStart
              ? { ...prev, items, groups: groupSpans, selectedIdx: 0 }
              : prev,
          );
        })();
      } else {
        if (!projectPath) {
          // Without a project path we have no directory to search. Silently
          // skip rather than spamming a loading state.
          setAcMenu(null);
          return;
        }
        // An empty query (bare `@`) is intentional — the server returns the
        // shallowest files/folders so the picker is useful before any keystroke.
        if (debounceRef.current) clearTimeout(debounceRef.current);
        setAcMenu((prev) =>
          prev?.type === 'file'
            ? { ...prev, query: trigger.query, triggerStart: trigger.triggerStart, selectedIdx: 0 }
            : {
                type: 'file',
                query: trigger.query,
                items: [],
                selectedIdx: 0,
                triggerStart: trigger.triggerStart,
              },
        );
        const fetchFiles = async (attempt: number): Promise<void> => {
          try {
            const res = await fetch(
              `/api/files/search?root=${encodeURIComponent(projectPath)}&q=${encodeURIComponent(trigger.query)}`,
            );
            if (!res.ok) return;
            const data = (await res.json()) as {
              results?: Array<{ path: string; name: string; type: string }>;
              indexing?: boolean;
            };
            const results = data.results ?? [];
            // Cold index: the server returns empty results + indexing:true while it
            // builds. Retry a few times with a short backoff so a bare `@` (or any
            // query) on a fresh workDir isn't stuck showing an empty dropdown.
            if (results.length === 0 && data.indexing && attempt < 5) {
              debounceRef.current = setTimeout(() => void fetchFiles(attempt + 1), 300);
              return;
            }
            const acItems: AcItem[] = results.slice(0, 8).map((r) => ({
              label: r.name,
              insert: '@' + r.path.replace(/^\//, ''),
              sub: r.path.replace(/^\//, ''),
              kind: 'file',
            }));
            // Guard against a stale response landing after the user moved the trigger.
            setAcMenu((prev) =>
              prev?.type === 'file' && prev.triggerStart === trigger.triggerStart
                ? { ...prev, items: acItems, selectedIdx: 0 }
                : prev,
            );
          } catch {
            /* ignore */
          }
        };
        debounceRef.current = setTimeout(() => void fetchFiles(0), 150);
      }
    },
    [onChange, sessionId, projectPath],
  );

  // Insert selected item at cursor.
  const insertItem = useCallback(
    (item: AcItem) => {
      if (!acMenu) return;
      const cursorPos = textarea?.selectionStart ?? value.length;
      const next =
        value.slice(0, acMenu.triggerStart) + item.insert + ' ' + value.slice(cursorPos);
      onChange(next);
      setAcMenu(null);
      const newPos = acMenu.triggerStart + item.insert.length + 1;
      setTimeout(() => {
        if (textarea) {
          textarea.setSelectionRange(newPos, newPos);
          textarea.focus();
        }
      }, 0);
    },
    [acMenu, value, onChange, textarea],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (acMenu && acMenu.items.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setAcMenu((prev) =>
            prev ? { ...prev, selectedIdx: (prev.selectedIdx + 1) % prev.items.length } : prev,
          );
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setAcMenu((prev) =>
            prev
              ? {
                  ...prev,
                  selectedIdx:
                    (prev.selectedIdx - 1 + prev.items.length) % prev.items.length,
                }
              : prev,
          );
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
          const item = acMenu.items[acMenu.selectedIdx];
          if (item) {
            e.preventDefault();
            insertItem(item);
            return;
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setAcMenu(null);
          return;
        }
      }
      onKeyDown?.(e);
    },
    [acMenu, insertItem, onKeyDown],
  );

  // Compute dropdown position + direction at render time.
  const dropdownStyle = useMemo<React.CSSProperties | null>(() => {
    if (!acMenu || acMenu.items.length === 0) return null;
    if (!textarea) return null;
    const rect = textarea.getBoundingClientRect();
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const expandDown = spaceBelow >= DROPDOWN_MIN_DOWN_HEIGHT || spaceBelow >= spaceAbove;
    const maxHeight = Math.min(
      window.innerHeight * 0.6,
      expandDown ? spaceBelow - 8 : spaceAbove - 8,
    );
    const base: React.CSSProperties = {
      left: rect.left,
      width: rect.width,
      maxHeight: `${Math.max(120, maxHeight)}px`,
    };
    if (expandDown) {
      base.top = rect.bottom + gap;
    } else {
      base.bottom = window.innerHeight - rect.top + gap;
    }
    return base;
    // Recompute when the menu changes (open/close, items, selection) and
    // when the textarea element is mounted.
  }, [acMenu, textarea]);

  const headerAt = useMemo(() => {
    const map = new Map<number, string>();
    if (acMenu?.groups) {
      for (const g of acMenu.groups) map.set(g.startIdx, g.title);
    }
    return map;
  }, [acMenu]);

  return (
    <>
      <textarea
        ref={setTextarea}
        className={className}
        value={value}
        placeholder={placeholder}
        rows={rows}
        autoFocus={autoFocus}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={(e) => {
          // Defer closing so a mousedown on a dropdown item still fires.
          // The item's onMouseDown calls e.preventDefault() anyway, but a
          // direct close-then-blur race can flake.
          setTimeout(() => setAcMenu(null), 0);
          onBlur?.(e);
        }}
        onPaste={onPaste}
        onDragOver={onDragOver}
        onDrop={onDrop}
        aria-label={ariaLabel}
      />
      {acMenu && acMenu.items.length > 0 && dropdownStyle && (
        <div className={styles.acDropdown} style={dropdownStyle}>
          {acMenu.items.map((item, i) => (
            <div key={`row-${i}-${item.insert}`}>
              {headerAt.has(i) && (
                <div className={styles.acGroupHeader}>{headerAt.get(i)}</div>
              )}
              <div
                className={`${styles.acItem}${
                  i === acMenu.selectedIdx ? ` ${styles.acItemSelected}` : ''
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertItem(item);
                }}
              >
                {item.kind && (
                  <span className={styles.acKindIcon}>
                    {item.kind === 'skill' ? '★' : item.kind === 'file' ? '@' : '▸'}
                  </span>
                )}
                <span className={styles.acLabel}>{item.label}</span>
                {item.sub && <span className={styles.acSub}>{item.sub}</span>}
              </div>
            </div>
          ))}
          <div className={styles.acFooter}>
            <span>
              {acMenu.items.length} match{acMenu.items.length === 1 ? '' : 'es'}
            </span>
            <span>↑↓ navigate · Enter select · Esc close</span>
          </div>
        </div>
      )}
    </>
  );
}

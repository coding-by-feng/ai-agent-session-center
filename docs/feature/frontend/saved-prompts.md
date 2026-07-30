# Saved Prompts (reusable snippet library)

## Function
A curated library of reusable prompt **text**, insertable into any queue prompt box — the compose row, a `QueueItemEditModal` MAIN prompt, or a before/after chain step. A bookmark (🔖) button keeps the text you're looking at; a bookmark-stack button opens a picker to insert one. The picker's second tab browses prompt history pooled across every session, from which individual entries can be promoted into the library.

## Purpose
Users retype the same prompts constantly — `/compact`, `/retouch-current-prompt`, a house review incantation, a chain step like "check git status and report anything uncommitted". Two things had to be true for a library to be useful here:

1. **It must be curated.** Auto-saving every prompt produces a list nobody can scan; the whole point is that only prompts the user judged reusable appear in it. Nothing writes to `promptSnippets` without an explicit 🔖 click.
2. **It must reach the chain editors.** Chain steps are the highest-value snippets — they're usually a whole reusable command rather than a one-off prompt — so the picker is wired into both chain sections, not just the main composer.

Raw prompt history is still *browsable* (the RECENT tab) so users don't have to remember a prompt in order to keep it. Browsing is free; keeping is deliberate.

**This is not queue history.** `queueHistoryStore` (★, 📚 sheet — see [Queue Scheduler](./queue-scheduler.md)) saves an entire `QueueItem` — type, interval, before/after chains, images — and applies it as a **new queue row**. This feature saves bare **text** and appends it into a box that's already being typed. Different granularity, different lifecycle, different table.

## Source Files
| File | Role |
|------|------|
| `src/stores/promptSnippetStore.ts` | `snippets: PromptSnippet[]` + `loadFromDb` / `save` / `remove` / `setLabel` / `touch` / `hasText`; owns the `promptSnippets` Dexie table |
| `src/components/session/PromptSnippetPicker.tsx` | The portaled picker (SAVED / RECENT tabs, filter, insert, rename, forget) plus the exported `BookmarkIcon` / `BookmarkStackIcon` marks and `SNIPPET_TRIGGER_ATTR` |
| `src/lib/promptSnippetPool.ts` | Pure pooling maths for the RECENT tab (`poolRecentPrompts`, `RECENT_LIMIT`) — DOM-free and store-free so the dedupe rules are unit-testable |
| `src/lib/promptSnippetInsert.ts` | `appendSnippet(current, snippet)` — the single insertion rule shared by every call site |
| `src/styles/modules/PromptSnippetPicker.module.css` | Picker styling (`.picker`, `.tabs`, `.row`, `.rowSource`, …) |
| `src/lib/queueMovePlacement.ts` | Reused for placement — `computeMovePickerPosition(anchor, menu, viewport, align)` |
| `src/lib/db.ts` | `DbPromptSnippet` + the Dexie **v7** `promptSnippets` store declaration |
| `src/main.tsx` | `bootstrap()` awaits `usePromptSnippetStore.loadFromDb()` alongside the queue + history hydrates |

Call sites (documented in their own feature docs):
- Compose row → [Prompt Queue](./prompt-queue.md) (`QueueTab.tsx`)
- MAIN prompt + both chain sections → [Queue Scheduler](./queue-scheduler.md) (`QueueItemEditModal.tsx`)

Tests: `src/stores/promptSnippetStore.test.ts` (24), `src/lib/promptSnippetPool.test.ts` (12), `src/lib/promptSnippetInsert.test.ts` (9), `src/components/session/PromptSnippetPicker.test.tsx` (19).

## Implementation

### Data model
**`PromptSnippet`** — `{ id: number, text: string, label: string, useCount: number, lastUsedAt: number | null, createdAt: number }`.

- `text` is stored **trimmed**; dedupe compares trimmed text **case-sensitively**.
- `label` is `''` when unnamed, never `undefined`, so every row has one shape and read sites need no `?? ''`.
- Persisted to the `promptSnippets` Dexie table, schema `'++id, createdAt, lastUsedAt, useCount'` (added in **v7**). v7 is purely additive — a new table needs no `.upgrade()` — but it re-declares every pre-existing table verbatim, because Dexie treats an omitted table in a version block as dropped.

### Store operations (`promptSnippetStore.ts`)
- **`save(text, label = '')`** → `{ id: number | null, duplicate: boolean }`. Trims; a blank string is a no-op returning `{ id: null, duplicate: false }` and writes nothing. An exact trimmed-text match returns the **existing** id with `duplicate: true` rather than adding a row — the 🔖 button doesn't move, so double-clicking it is easy and would otherwise silently build a library of identical entries. New snippets are prepended so a just-kept one is visible without scrolling.
- **`touch(id)`** — `useCount + 1` and `lastUsedAt = Date.now()`, called on every insert. Drives the "most used" ordering.
- **`setLabel(id, label)`** — trims; blank clears back to `''`. Skips the DB write entirely when the value is unchanged.
- **`remove(id)`** — deletes, and drops the row from memory **even if the delete throws**: leaving a snippet the user just forgot on screen is worse than a stale row, and the next `loadFromDb` reconciles.
- **`hasText(text)`** — exact trimmed match; `false` for blank text so an empty box never shows a filled bookmark.
- **`loadFromDb()`** — `orderBy('createdAt').reverse()`; backfills a missing `label` / `useCount` from older rows; flips `loaded: true` **even on a read failure**, matching the other stores, so the picker renders an empty library instead of hanging.

Unlike `queueHistoryStore`, this store has **no cross-store coupling** — no `historyId` marker on any live `QueueItem`, nothing to clear on delete. The filled-bookmark state is derived on the fly from `hasText(...)`.

### The picker (`PromptSnippetPicker.tsx`)
Props: `{ anchor: HTMLElement | null, align?: HorizontalAlign, onInsert: (text: string) => void, onClose: () => void }`.

**SAVED tab** — the library, sorted `useCount` desc → `lastUsedAt ?? createdAt` desc → `createdAt` desc. Filter matches `text` **or** `label`. Each row:
- Title = `label || firstLine(text)`; a preview line (`truncate(text, 90)`) renders **only when it differs from the title**, so an unnamed single-line snippet like `/compact` isn't printed twice at two font sizes (`SavedRowButton`).
- Clicking the row body calls `onInsert(text)`, then `touch(id)`, then `onClose()`.
- `useCount` badge (`N×`, hidden at 0), `✎` inline rename, `✕` forget.
- Rename commits on Enter or blur. **Escape inside the rename input calls `stopPropagation()`** so it cancels the rename rather than reaching the picker's own document-level Escape listener and closing the whole menu.
- Empty states are distinct: "No saved prompts yet…" (nothing kept) vs. "No saved prompts match the filter." (filtered to nothing).

**RECENT tab** — read-only, writes nothing. Built by `poolRecentPrompts` over `Array.from(sessions.entries())`, each mapped to `{ sessionLabel: s.projectName || s.title || id.slice(0, 8), promptHistory: s.promptHistory ?? [] }`. Pooling is skipped entirely (`if (tab !== 'recent') return []`) while SAVED is showing, since the flatten walks every session's full history. Each row: full text (truncated to 110 chars), a session breadcrumb, and either a 🔖 keep button or a green `✓` when the text is already in the library.

**`poolRecentPrompts(sources, limit = RECENT_LIMIT)`** where `RECENT_LIMIT = 40`:
- Flattens every source's `promptHistory`, trimming and **dropping blank entries**.
- Dedupes on exact trimmed text, keeping the **newest** occurrence. Pooling across sessions means common prompts appear in many histories; without dedupe the list is mostly repeats. Keeping the newest is what makes the breadcrumb meaningful — it names the session that used the prompt most recently, not an arbitrary one.
- Sorts newest-first, slices to `limit` (a non-positive limit returns `[]` rather than throwing).

### Insertion rule (`appendSnippet`)
`appendSnippet(current, snippet)` — trims the snippet, `trimEnd()`s the existing text, and joins with a single `\n`. An empty-or-whitespace box is replaced outright (no leading blank line); a blank snippet returns `current` unchanged; internal newlines in a multi-line snippet survive. Caret position is deliberately **not** consulted, which is why no call site needs an imperative handle on the shared `AutocompleteTextarea`.

Chain sections don't use it — a pick there appends a whole new `ChainStep` (`{ id: newStepId(), text }`), so there's no "which of the several boxes does this go into?" ambiguity.

### Placement — portaled, not absolute
`createPortal(..., document.body)` with `position: fixed`, `z-index: 10150`, geometry written inline from `computeMovePickerPosition(...)`. This is mandatory, not stylistic: **every** trigger sits inside a scroll box — the compose row and rows are in `.queueBody` (`max-height: 250px; overflow-y: auto`), and the MAIN / chain triggers are in `.chainModalBody` (`overflow-y: auto`). Per CSS overflow rules a `visible` axis computes to `auto` when the other is `auto`, so an `absolute` descendant is clipped on **both** axes; and the usual flip/clamp helpers measure `window.innerWidth`/`innerHeight`, a boundary far outside the real clip edge, so the guard silently never fires and the menu always renders cropped while *looking* guarded in review. Same fix and same failure history as [`QueueMovePicker`](./prompt-queue.md).

- `useLayoutEffect` measures then places before paint; re-places on `resize` and on `scroll` with **`capture: true`** (scroll doesn't bubble, so an inner `.queueBody` / `.chainModalBody` scroll is only observable during capture). It bails when nothing moved so a scroll burst doesn't re-render per event, and re-measures when the row count or tab changes (the menu's height changes with it).
- Renders `visibility: hidden` for the single pre-measure frame so it never flashes at the top-left corner.
- The open animation is **fade-only**: `getBoundingClientRect()` includes an in-flight transform, so an animated translate/scale would feed corrupted geometry back into placement.
- `align` is `'right'` for the compose row and MAIN prompt (triggers at a right edge) and `'left'` for the chain sections' "From saved…" button (a trigger at the left of a wide modal).
- `z-index: 10150` clears `.chainModalOverlay` / QueueHistory `.overlay` (10000/10001) and the `AutocompleteTextarea` dropdown (10100), and stays under `TitleBar` (99999).

### Dismissal and Escape layering
Closes on Escape (document listener) and on outside `mousedown`, except when the target is inside the menu or matches `[data-snippet-trigger]` (`SNIPPET_TRIGGER_ATTR`) — a trigger owns its own toggle and would otherwise close-then-reopen.

**`QueueItemEditModal` skips its own Escape close while a picker is open** (`if (snippetPicker) return`). `stopPropagation()` cannot achieve this: both listeners are on `document`, and stopping propagation does not suppress a sibling listener on the *same* node — only `stopImmediatePropagation` would, and its effect depends on registration order. Gating on state is the only order-independent fix. Same layering pattern as `QueueHistorySheet`'s `view → edit → sheet` chain.

### UI elements
| Element | Class | Location | Action |
|---------|-------|----------|--------|
| Keep (bookmark) | `queueSnippetBtn` / `queueSnippetBtnOn` | compose row, MAIN prompt | `save(text)`; `disabled` while the box is blank; filled + purple when already kept |
| Library (bookmark-stack) | `queueSnippetBtn` | compose row, MAIN prompt | toggles the picker (`align: 'right'`) |
| Keep step (bookmark) | `chainStepBtn chainStepIconBtn` / `chainStepIconBtnOn` | each chain step row | `save(step.text)`; makes the row `↑ ↓ 🔖 ✕` |
| From saved… | `chainAddBtn chainFromSavedBtn` | each chain section footer | toggles the picker (`align: 'left'`); a pick appends a new step |
| SAVED / RECENT | `tab` / `tabActive` | picker | switch list source |
| ✎ / ✕ | `rowBtn` / `rowBtnDanger` | SAVED row | rename / forget |
| 🔖 / ✓ | `rowBtn` / `rowKept` | RECENT row | promote into the library / already kept |

Both marks are inline SVG, never the emoji characters — 🔖 renders in full colour on macOS and as tofu on some Linux builds, and can't inherit the button's hover colour. Purple (`--accent-purple`) throughout so neither reads as the yellow row-level ★ or the cyan attach/ADD actions.

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — `promptSnippetStore` is a Zustand store; the RECENT tab reads `sessionStore.sessions`
- [Client Persistence](./client-persistence.md) — the `promptSnippets` table (Dexie v7)
- [Prompt Queue](./prompt-queue.md) — `computeMovePickerPosition` / `HorizontalAlign` from `queueMovePlacement.ts`
- [Session Management](../server/session-management.md) — `Session.promptHistory` (`PromptEntry[]`) is the RECENT pool's raw material

### Depended On By
- [Prompt Queue](./prompt-queue.md) — compose row keep/library buttons
- [Queue Scheduler](./queue-scheduler.md) — `QueueItemEditModal`'s MAIN prompt and both chain sections
- [Views & Routing](./views-routing.md) — `main.tsx` `bootstrap()` awaits this store's hydrate

### Shared Resources
- `usePromptSnippetStore`, the `promptSnippets` Dexie table, `computeMovePickerPosition`, `Session.promptHistory`

## Change Risks
- **The library must stay curated.** Any code path that writes to `promptSnippets` without an explicit user click defeats the feature — the whole design premise is that RECENT is a read-only view and only 🔖 promotes. `PromptSnippetPicker.test.tsx` asserts that inserting a RECENT row leaves the library size unchanged.
- **Never un-portal the picker.** It opens from two different `overflow-y: auto` boxes, so an `absolute`-positioned version is clipped on both axes with no linter warning. Guarded by `PromptSnippetPicker.test.tsx`'s "portals the menu to document.body" case; the `QueueMovePicker` history in [Prompt Queue](./prompt-queue.md) is what happens when this is dropped.
- **`scroll` must keep `capture: true`** — scroll doesn't bubble, so a window listener only sees the inner container's scroll during capture. Drop it and the menu detaches from its trigger the moment the queue or modal body is scrolled.
- **Placement stays pure** — `computeMovePickerPosition` must not read the DOM or any ancestor's height. Measuring anything but the trigger's viewport rect is exactly the bug that made `QueueMovePicker`'s flip unreachable.
- **`QueueItemEditModal`'s Escape gate is not optional** — remove `if (snippetPicker) return` and a single Escape closes the picker *and* the modal, discarding unsaved edits. Reaching for `stopPropagation` instead does nothing (same-node listeners).
- **Dedupe on `save` is what keeps the library usable** — it's the only thing stopping a repeated 🔖 click from filling the list with identical rows, and `duplicate: true` is what lets the caller say "already saved" instead of appearing to do nothing.
- **Dexie v7 must re-declare every table** — an omitted table in a version block is a dropped table. Adding a new column to `promptSnippets` needs a v8 block, not an edit to v7.
- **`appendSnippet` is the single insertion rule** — inlining a different concatenation at one call site makes insert behaviour differ between the composer and the modal, which is the class of divergence this feature deliberately removed from the editors.

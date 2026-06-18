# REVIEW Tab — Saved Explanations & Translations

> **Function** Persist every selection-popup / translate-toolbar / AI-popup
> action together with its surrounding context, capture the CLI response when the
> floating session is closed, and surface the entire history both in a dedicated
> nav tab (REVIEW) and in a per-session detail tab (AI POPUPS) — with favorites,
> aliases, notes, archive, and source-file highlighting for later review.

## Purpose

When the user is learning a topic via the [Floating Terminal Fork](./floating-terminal-fork.md)
feature, every explanation or translation they request is worth keeping — but
floating windows are ephemeral. The REVIEW tab is the persistent journal:

- Every spawn writes a draft entry with the prompt context.
- Closing the float captures the CLI output (ANSI- + TUI-chrome-stripped) into
  the same entry.
- The user can browse, search, favorite, alias, archive, annotate, and delete
  entries.
- Favorited selections are highlighted back inside the source markdown file
  (clickable, deep-links to the REVIEW row).

## Source Files

| File | Role |
|------|------|
| `src/lib/db.ts` | `DbTranslationLog` interface + `translationLogs` table. Schema reached **v6** (favorite + alias + sourceFilePath added in v6, with an `.upgrade()` back-fill). |
| `src/lib/translationLog.ts` | CRUD helpers: `createLog`, `findByUuid`, `findByFloatTerminalId`, `updateLog`, `captureResponse`, `listLogs`, `listByOriginSession`, `listFavoritedByFile`, `setArchived`, `setNotes`, `setFavorite`, `setAlias`, `deleteLog`. |
| `src/lib/ansi.ts` | `stripAnsi` + `cleanCapturedOutput` (the latter also drops box-drawing / block / Braille-spinner TUI chrome). `captureResponse` uses `cleanCapturedOutput`. |
| `src/lib/rehypeSavedSelections.ts` | rehype plugin `makeSavedSelectionsPlugin(terms)` — wraps favorited selection strings in the rendered markdown with `<mark className="saved-selection">` for click-to-open deep-links. |
| `src/routes/ReviewView.tsx` | The REVIEW view: filters (mode / archived / favorites / search), list, expandable rows, alias + notes inputs, deep-link scroll-to. |
| `src/styles/modules/ReviewView.module.css` | REVIEW view styling. **Theme-aware**: references the canonical `body[data-theme]` CSS vars (`--bg-primary`/`--bg-card`/`--bg-accent`/`--bg-subtle-strong`, `--border-subtle`/`--border-accent`, `--text-primary`/`--text-secondary`, `--accent-cyan`/`--accent-red`/`--accent-yellow`) so it follows the selected theme. Previously it used the **non-existent** `--bg-deep` / `--panel-border` vars (always falling back to hardcoded `#0a0a1a` navy + cyan `rgba`), so the tab stayed cyberpunk-dark under every theme. Red/yellow accent tints with no themed bg-var use `color-mix(in srgb, var(--accent-*) N%, transparent)`. Do not reintroduce `--bg-deep`/`--panel-border` or raw color literals. |
| `src/components/session/AiPopupHistory.tsx` | Per-session detail-tab list of AI-popups spawned FROM that session (`listByOriginSession`). Same expandable-row UI as REVIEW. |
| `src/styles/modules/AiPopupHistory.module.css` | AI POPUPS tab styling. |
| `src/components/layout/NavBar.tsx` | Adds the `REVIEW` link (`/review`). |
| `src/App.tsx` | Lazy-loads + registers `<Route path="/review" />`. |
| `src/stores/floatingSessionsStore.ts` | On `close()`: GETs `/api/terminals/:id/output`, base64 → bytes → UTF-8 (`TextDecoder`), calls `captureResponse(terminalId, decoded)` before killing the pty. |
| `src/components/translate/SelectionPopup.tsx` | Calls `createLog` after a successful spawn (explain / vocab / translate-selection / custom modes). |
| `src/components/terminal/TerminalContainer.tsx` | Calls `createLog` for `translate-answer`. |
| `src/components/session/ProjectTab.tsx` | Calls `createLog` for `translate-file`; renders the saved-selection `<mark>` (via `makeSavedSelectionsPlugin` + `listFavoritedByFile`) and navigates to `/review?uuid=…` on click. |
| `server/apiRouter.ts` | `GET /api/terminals/:id/output` — base64 ring-buffer snapshot via `getTerminalOutputBuffer` (sshManager). |

## Data Model

```ts
interface DbTranslationLog {
  id?: number;                  // Dexie auto id
  uuid: string;                 // stable id, generated client-side (crypto.randomUUID)
  mode:
    | 'explain-learning'
    | 'explain-native'
    | 'vocab-native'
    | 'translate-selection-learning'
    | 'translate-selection-native'
    | 'translate-answer'
    | 'translate-file'
    | 'custom';
  nativeLanguage: string;
  learningLanguage: string;
  selection: string;            // selected text (empty for translate-file)
  contextLine: string;          // surrounding sentence/line
  filePath: string;             // prompt-attached path (translate-file)
  fileContent: string;          // for translate-file
  prompt: string;               // synthesized prompt (populated for custom mode)
  response: string;             // captured at float close, ANSI/TUI-stripped, capped to 256 KB
  originSessionId: string;
  originProjectName: string;
  originSessionTitle: string;
  floatTerminalId: string;      // ties draft → response capture
  notes: string;                // user-authored
  archived: 0 | 1;
  favorite: 0 | 1;              // ★ — also drives source-file highlighting
  alias: string;                // optional short label (REVIEW header + md tooltip)
  sourceFilePath: string;       // md file the selection came from (for highlighting)
  createdAt: number;
  updatedAt: number;
}
```

Indexes (v6): `++id, uuid, mode, createdAt, originSessionId, archived, favorite, sourceFilePath, floatTerminalId`.

The response cap is `RESPONSE_CAP_BYTES = 256 * 1024` in `translationLog.ts`
(keeps the tail when output exceeds it).

## Capture Pipeline

```
User clicks 🔎 / 🌐 / 📖 / 🔤 / ⤴ / 📝 / ✦
   │
   ▼
POST /api/sessions/spawn-floating  →  { terminalId, label }
   │                       │
   │                       ▼
   │                createLog({ mode, selection, contextLine, sourceFilePath,
   │                            prompt, originSession…, floatTerminalId: terminalId })
   ▼
floatingSessionsStore.open()    →  FloatingTerminalPanel renders
   ⋮  user reads the CLI response in the floating window
   ▼
floatingSessionsStore.close(terminalId)
   ├─ GET /api/terminals/:id/output  →  { ok: true, output: <base64> }
   ├─ base64 → Uint8Array → TextDecoder('utf-8') → captureResponse(terminalId, decoded)
   │       ├─ cleanCapturedOutput (strip ANSI + TUI chrome)
   │       └─ db.translationLogs.update(…, { response, updatedAt })
   └─ DELETE /api/terminals/:id     (kills pty)
```

The base64 is decoded via `TextDecoder` (not bare `atob`) so multibyte UTF-8
characters survive — bare `atob` yields a Latin-1 string that mojibakes (e.g.
`·` → `Â·`).

## REVIEW View

Live polling reload (every 4 s) plus immediate reload after local mutations.
Filters: `mode`, `archived` (active / archived / all), `favorite` toggle, and a
200 ms-debounced free-text `search` (matches selection / response / contextLine
/ notes / filePath).

Each row:
- Header (always visible): ★/☆ favorite toggle, mode icon + label (or alias),
  target-language chip, archived chip, origin project + session title, relative
  time, source snippet (≤220 chars).
- Expanded body: alias input, full source (+ file path for translate-file +
  surrounding line), the captured **Conversation** (with copy button), notes
  textarea, archive / delete buttons, created/updated timestamps.

**Deep-link**: clicking a saved-selection `<mark>` in a rendered markdown file
navigates to `/review?uuid=<uuid>`. ReviewView seeds initial state from the
param (expands the row, widens the archived filter to `all`), scrolls it into
view once loaded, then clears the param.

## AI POPUPS Tab (per-session)

`AiPopupHistory` renders the same expandable-row UI inside the session
[Detail Panel](./session-detail-panel.md) as the `AI POPUPS` tab. It filters to
active records spawned from the current session (`listByOriginSession`, i.e.
`originSessionId` + non-archived) and supports favorite / alias / notes /
archive / delete / copy — a session-scoped slice of the global REVIEW journal.

## Source-File Highlighting

`makeSavedSelectionsPlugin(terms)` is a rehype tree transform. ProjectTab loads
the favorited selections for the open markdown file via `listFavoritedByFile`
and passes them as terms. The plugin de-dupes, drops terms shorter than
`MIN_TERM_LEN = 2`, sorts longest-first (so a longer phrase wins), and wraps
each match in `<mark className="saved-selection" data-saved-uuid=… title=…>`
(skipping `code/pre/a/mark/script/style`). The `.saved-selection` style lives in
`src/styles/global.css`; clicking it deep-links into REVIEW.

## Privacy

All data lives in the local browser IndexedDB (`claude-dashboard` /
`translationLogs`). Nothing is sent to a server we don't already use.

## Dependencies & Connections

| Connected feature | Why |
|-------------------|-----|
| [Floating Terminal Fork](./floating-terminal-fork.md) | Drafts are created by every spawn; responses captured at float close. |
| [Session Detail Panel](./session-detail-panel.md) | Hosts the per-session `AI POPUPS` tab via `AiPopupHistory`. |
| [Client persistence](./client-persistence.md) | The `translationLogs` table lives in the shared Dexie database (added v3, extended v6). |
| [Project browser](./project-browser.md) | ProjectTab renders the saved-selection highlight marks in markdown files. |
| [API endpoints](../server/api-endpoints.md) | `GET /api/terminals/:id/output` snapshot route. |
| [Terminal/SSH](../server/terminal-ssh.md) | `getTerminalOutputBuffer` reads the 128 KB PTY ring buffer the snapshot returns. |
| [State management](./state-management.md) | `floatingSessionsStore.close()` does response capture before pty kill. |

## Change Risks

* **DB migration**: schema is at **v6**; favorite / alias / sourceFilePath are
  back-filled by the v6 `.upgrade()`. Rolling back below the relevant version
  leaves rows intact but those fields unindexed/unused.
* **Response capture is best-effort**: the PTY output ring buffer is only
  `OUTPUT_BUFFER_MAX = 128 KB` (server/sshManager.ts) and the CLI may still be
  streaming when the user closes the float. We capture whatever's present at
  that moment.
* **ANSI / TUI stripping is pragmatic, not exhaustive** — `cleanCapturedOutput`
  removes box-drawing / block / Braille-spinner chrome and common escapes, but
  unusual sequences could leak through. Add cases to `src/lib/ansi.ts` as needed.
* **Storage growth**: there's no auto-archive (per user preference). Each
  response is capped at 256 KB (`RESPONSE_CAP_BYTES`). With many large entries
  this can grow; add manual export / clear-all if it becomes a concern.
* **Highlight matching is substring-based**: `makeSavedSelectionsPlugin` matches
  case-insensitive substrings ≥2 chars, so very short/common favorited
  selections can over-highlight a file.

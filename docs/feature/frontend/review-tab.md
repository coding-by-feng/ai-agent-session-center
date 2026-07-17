# REVIEW Tab — Saved Explanations & Translations

> **Function** Persist every selection-popup / translate-toolbar / AI-popup
> action together with its surrounding context, capture the CLI response
> continuously while the floating session is open (and at close), and surface the
> entire history both in a dedicated
> nav tab (REVIEW) and in a per-session detail tab (AI POPUPS) — with favorites,
> aliases, notes, archive, and source-file highlighting for later review.

## Purpose

When the user is learning a topic via the [Floating Terminal Fork](./floating-terminal-fork.md)
feature, every explanation or translation they request is worth keeping — but
floating windows are ephemeral. The REVIEW tab is the persistent journal:

- Every spawn writes a draft entry with the prompt context.
- The CLI output (ANSI- + TUI-chrome-stripped) is captured into the same entry
  continuously while the float is open (6 s poll + `beforeunload`) and again at
  close, so a reload/quit mid-stream doesn't lose the answer.
- The user can browse, search, favorite, alias, archive, annotate, and delete
  entries.
- Favorited selections are highlighted back inside the source markdown file
  (clickable, deep-links to the REVIEW row).

## Source Files

| File | Role |
|------|------|
| `src/lib/db.ts` | `DbTranslationLog` interface + `translationLogs` table. Schema reached **v6** (favorite + alias + sourceFilePath added in v6, with an `.upgrade()` back-fill). |
| `src/lib/translationLog.ts` | CRUD helpers: `createLog`, `findByUuid`, `findByFloatTerminalId`, `updateLog`, `captureResponse`, `listLogs`, `listByOriginSession`, `listFavoritedByFile`, `setArchived`, `setNotes`, `setFavorite`, `setAlias`, `deleteLog`, `migrateOriginSessionId(oldId, newId)` (lines 87-98) — re-points rows from an old origin session id to a new one on re-key (clone/fork/`claude --resume` via `replacesId`), called from `useWebSocket.ts:100` so `AiPopupHistory` (lists by `originSessionId`) isn't empty for a resumed session. |
| `src/lib/ansi.ts` | `stripAnsi` + `cleanCapturedOutput` (the latter also drops box-drawing / block / Braille-spinner TUI chrome). `captureResponse` uses `cleanCapturedOutput` at **capture** time. |
| `src/lib/popupResponse.ts` | `formatPopupResponse(raw)` — **display-time**, non-destructive cleanup layered on top of the stored capture: drops heredoc `quote>`-style continuation echoes, the `--fork-session`/`--resume` spawn command echo, shell-prompt header lines, and the `ClaudeCode` / `Welcome back` CLI banner. Returns the readable answer (possibly empty if the snapshot caught only chrome). Does **not** attempt to repair character-doubling from terminal reflow. |
| `src/components/session/PopupResponse.tsx` | **Shared** response-display component used by both `AiPopupHistory` and `ReviewView`. Cleans the raw `response` via `formatPopupResponse`, renders it as themed **markdown** (`react-markdown` + `remark-gfm`, **no** `rehype-raw` → raw HTML disabled, no XSS), and exposes a raw ⇆ formatted toggle + copy. Falls back to a raw `<pre>` (with a note) when nothing formats, and an empty hint when nothing was captured. |
| `src/styles/modules/PopupResponse.module.css` | Themed markdown styles for `PopupResponse` (canonical CSS vars; `pre`/`table` scroll inside their box so long content never overflows a docked panel). |
| `src/lib/rehypeSavedSelections.ts` | rehype plugin `makeSavedSelectionsPlugin(terms)` — wraps favorited selection strings in the rendered markdown with `<mark className="saved-selection">` for click-to-open deep-links. |
| `src/routes/ReviewView.tsx` | The REVIEW view: filters (mode / archived / favorites / search), list, expandable rows, alias + notes inputs, deep-link scroll-to. |
| `src/styles/modules/ReviewView.module.css` | REVIEW view styling. **Theme-aware**: references the canonical `body[data-theme]` CSS vars (`--bg-primary`/`--bg-card`/`--bg-accent`/`--bg-subtle-strong`, `--border-subtle`/`--border-accent`, `--text-primary`/`--text-secondary`, `--accent-cyan`/`--accent-red`/`--accent-yellow`) so it follows the selected theme. Previously it used the **non-existent** `--bg-deep` / `--panel-border` vars (always falling back to hardcoded `#0a0a1a` navy + cyan `rgba`), so the tab stayed cyberpunk-dark under every theme. Red/yellow accent tints with no themed bg-var use `color-mix(in srgb, var(--accent-*) N%, transparent)`. Do not reintroduce `--bg-deep`/`--panel-border` or raw color literals. |
| `src/components/session/AiPopupHistory.tsx` | Per-session detail-tab list of AI-popups spawned FROM that session (`listByOriginSession`). Same expandable-row UI as REVIEW; delegates the response section to `<PopupResponse label="Response" />`. |
| `src/styles/modules/AiPopupHistory.module.css` | AI POPUPS tab styling. |
| `src/components/layout/NavBar.tsx` | Adds the `REVIEW` link (`/review`). |
| `src/App.tsx` | Lazy-loads + registers `<Route path="/review" />`. |
| `src/stores/floatingSessionsStore.ts` | `captureNow(terminalId)` (lines 98-112) — GETs `/api/terminals/:id/output`, base64 → bytes → UTF-8 (`TextDecoder`), calls `captureResponse(terminalId, decoded)` **without** killing the pty. `close()` delegates to `captureNow` before issuing the `DELETE`. `migrateOriginSession(oldId, newId)` re-points live float entries on session re-key. |
| `src/components/translate/SelectionPopup.tsx` | The **sole** `createLog` caller — writes the draft after a successful spawn (explain / vocab / translate-selection / custom modes). |
| `src/components/session/ProjectTab.tsx` | Renders the saved-selection `<mark>` (via `makeSavedSelectionsPlugin` + `listFavoritedByFile`) and navigates to `/review?uuid=…` on click. |
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
  fileContent: string;          // LEGACY — historical rows only; SelectionPopup (the
                                //   sole createLog caller) hard-codes '' , so no
                                //   newly written row populates this
  prompt: string;               // synthesized prompt (populated for custom mode)
  response: string;             // captured continuously while the float is open and
                                //   again at close, ANSI/TUI-stripped, capped to 256 KB
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
User clicks 🔎 / 🌐 / 📖 / 🔤 / ✦   (the six live SelectionPopup modes;
                                    ⤴ translate-answer and 📝 translate-file
                                    have no trigger — historical rows only)
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
   ⋮
   ├─ WHILE OPEN — FloatingTerminalRoot snapshots continuously:
   │     setInterval(captureNow, 6000) + window 'beforeunload'
   │     + a final flush on unmount / float-set change.
   │     captureNow(terminalId) is an idempotent overwrite (keyed by
   │     floatTerminalId), so polling never duplicates rows.
   ▼
floatingSessionsStore.close(terminalId)
   ├─ captureNow(terminalId):
   │     GET /api/terminals/:id/output  →  { ok: true, output: <base64> }
   │     base64 → Uint8Array → TextDecoder('utf-8') → captureResponse(terminalId, decoded)
   │       ├─ cleanCapturedOutput (strip ANSI + TUI chrome)
   │       └─ db.translationLogs.update(…, { response, updatedAt })
   └─ DELETE /api/terminals/:id     (kills pty — capture already done)
```

`close()` and the periodic snapshot share the same `captureNow(terminalId)`
helper — it captures WITHOUT killing the PTY, and `close()` simply calls it
before the `DELETE`. The base64 is decoded via `TextDecoder` (not bare `atob`)
so multibyte UTF-8 characters survive — bare `atob` yields a Latin-1 string that
mojibakes (e.g. `·` → `Â·`).

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
  surrounding line), the captured **Conversation** (rendered by `PopupResponse`
  — see below), notes textarea, archive / delete buttons, created/updated
  timestamps.

## Response Rendering (`PopupResponse`)

Both the REVIEW **Conversation** section and the AI POPUPS **Response** section
render through the shared `PopupResponse` component instead of a raw `<pre>`:

1. **Clean (display-time, non-destructive):** `formatPopupResponse(response)`
   strips the shell scaffolding a mid-startup snapshot can wrap around the
   answer — heredoc `quote>` continuation echoes, the `--fork-session`/`--resume`
   command echo, shell-prompt header lines, and the `ClaudeCode` / `Welcome back`
   banner. The raw capture is never modified in IndexedDB.
2. **Render:** the cleaned text renders as markdown (`react-markdown` +
   `remark-gfm`) with theme-aware typography (`PopupResponse.module.css`), so a
   vocabulary entry's `# heading`, `**bold**`, lists and tables display properly
   instead of as literal markdown source. Raw HTML is disabled (no `rehype-raw`),
   so rendering untrusted terminal output is XSS-safe.
3. **Escape hatches:** a raw ⇆ formatted toggle always exposes the exact capture;
   copy grabs whatever is on screen; a capture that cleans to nothing shows the
   raw output with a note (honest, rather than a wall of chrome).

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
Its **Response** section is the shared `PopupResponse` component (see
[Response Rendering](#response-rendering-popupresponse)).

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
| [Terminal/SSH](../server/terminal-ssh.md) | `getTerminalOutputBuffer` reads the PTY replay ring buffer (2 MB default, configurable 256 KB–32 MB) the snapshot returns. |
| [State management](./state-management.md) | `floatingSessionsStore.close()` does response capture before pty kill. |

## Change Risks

* **DB migration**: schema is at **v6**; favorite / alias / sourceFilePath are
  back-filled by the v6 `.upgrade()`. Rolling back below the relevant version
  leaves rows intact but those fields unindexed/unused.
* **Response capture is best-effort**: the PTY output ring buffer defaults to
  `DEFAULT_TERMINAL_REPLAY_BUFFER_BYTES = 2 MB` (`src/types/terminal.ts`),
  configurable via Settings ▸ ADVANCED ▸ Terminal and clamped to 256 KB–32 MB by
  `clampReplayBufferBytes` (a change applies only to terminals created after it),
  and the CLI may still be
  streaming. The latest output is snapshotted continuously while the float is
  open — `FloatingTerminalRoot` runs `captureNow` on a 6 s interval, on
  `beforeunload`, and as a final flush on unmount/float-set change (idempotent
  overwrite keyed by `floatTerminalId`), not only at close — so a reload/quit
  while a popup is open no longer loses the answer. We still capture whatever's
  present at each snapshot, so a mid-stream snapshot may be partial.
* **ANSI / TUI stripping is pragmatic, not exhaustive** — `cleanCapturedOutput`
  removes box-drawing / block / Braille-spinner chrome and common escapes, but
  unusual sequences could leak through. Add cases to `src/lib/ansi.ts` as needed.
* **Storage growth**: there's no auto-archive (per user preference). Each
  response is capped at 256 KB (`RESPONSE_CAP_BYTES`). With many large entries
  this can grow; add manual export / clear-all if it becomes a concern.
* **Highlight matching is substring-based**: `makeSavedSelectionsPlugin` matches
  case-insensitive substrings ≥2 chars, so very short/common favorited
  selections can over-highlight a file.

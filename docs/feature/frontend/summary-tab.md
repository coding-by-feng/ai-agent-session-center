# Session Summary

## Function — what it does

Provides AI-generated, single-paragraph summaries of a coding session: a read-only **Summary tab** that renders a stored summary string, a **Summarize modal** that lets the user pick/edit a prompt template and POST the session's transcript to the backend for summarization, and a **Summary Prompt settings** panel for managing reusable summary-prompt templates. The backend pipes the assembled transcript through `claude -p --model haiku`, stores the result on the session, and archives the session.

## Purpose — why it exists

Long sessions accumulate many prompts, tool calls, and responses; a concise AI summary lets the user recall what a session accomplished without re-reading the full transcript. Reusable prompt templates let the user steer the summary style (e.g. "bullet-point changelog" vs. "detailed narrative"). Summarizing also archives the session, treating "summarize" as a "wrap up and file away" action.

> **State note (current code):** The server endpoint (`POST /api/sessions/:id/summarize`), the persisted `session.summary` field, the SQLite `summary` column, and the `summaryPrompts` IndexedDB table are all live infrastructure. The three React components in this doc — `SummaryTab`, `SummarizeModal`, `SummaryPromptSettings` — are **not currently imported or rendered by any live UI** (no `Summary` tab in `DetailTabs`, no `Summary` sub-tab in `SettingsPanel`). They are functional, self-contained, and wired to the backend, but presently orphaned. See [Change Risks](#change-risks).

## Source Files

| File | Role |
|------|------|
| `src/components/session/SummaryTab.tsx` | Read-only display of `session.summary`; splits on `\n` into `<br/>`-separated lines; shows empty-state hint when no summary exists. |
| `src/components/session/SummarizeModal.tsx` | Modal (`SUMMARIZE_MODAL_ID = 'summarize-modal'`) to select/create/edit a prompt template, build the session context, and POST to the summarize endpoint. Exports `SUMMARIZE_MODAL_ID`. |
| `src/components/settings/SummaryPromptSettings.tsx` | Settings panel for CRUD on summary-prompt templates (name + prompt text, star one as default). |
| `src/lib/db.ts` *(supporting)* | Defines `DbSummaryPrompt` interface and the Dexie `summaryPrompts` table (`'++id, isDefault'`). |
| `src/types/api.ts` *(supporting)* | `SummarizeResponse { ok, summary }` and the request body type (`promptTemplate?`, `custom_prompt?`). |
| `server/apiRouter.ts` *(supporting)* | `POST /sessions/:id/summarize` handler, `summarizeSchema`, concurrency limiter (`MAX_CONCURRENT_SUMMARIZE = 2`). |
| `server/sessionStore.ts` *(supporting)* | `setSummary()` stores summary in memory + DB; `archiveSession()` flags the session archived. |
| `server/db.ts` *(supporting)* | `sessions.summary TEXT` column; `updateSessionSummary(id, summary)` prepared statement. |

## Implementation

### Constants & values

- `SUMMARIZE_MODAL_ID = 'summarize-modal'` (exported from `SummarizeModal.tsx`; the `activeModal` value in `useUiStore` that opens the modal).
- `MAX_CONCURRENT_SUMMARIZE = 2` (server) — caps simultaneous summarize requests; excess returns HTTP 429.
- Server summarize subprocess: `execFile('claude', ['-p', '--model', 'haiku'], { timeout: 60000, maxBuffer: 1024 * 1024 })` — 60s timeout, 1 MB max stdout.
- Server default prompt fallback: `'Summarize this Claude Code session in detail.'` (used when neither `custom_prompt` nor `promptTemplate` provided).
- Server prompt assembly: `` `${promptTemplate}\n\n--- SESSION TRANSCRIPT ---\n${context}` ``.
- `summarizeSchema = z.object({ context: z.string().min(1), promptTemplate: z.string().optional(), custom_prompt: z.string().max(10000).optional() })`.
- Template prompt preview truncation: 150 chars in modal list, 120 chars in settings list, 10000-char max for `custom_prompt`.

### Data structures / state

`DbSummaryPrompt` (IndexedDB, Dexie table `summaryPrompts`, indexed on `++id, isDefault`):

```ts
interface DbSummaryPrompt {
  id?: number;
  name: string;
  prompt: string;
  isDefault: number;   // 0 | 1 (Dexie can't index booleans)
  createdAt: number;   // Date.now()
  updatedAt: number;
}
```

`SummaryTab` props: `{ summary: string | undefined }`.

`SummarizeModal` local state: `prompts: DbSummaryPrompt[]`, `selectedPromptId`, `showCustomForm`, `editId`, `customName`, `customPrompt`, `running` (boolean guard). Reads `activeModal`/`closeModal` from `useUiStore`, `selectedSessionId`/`sessions` from `useSessionStore`.

`SummaryPromptSettings` local state: `prompts`, `editingId`, `name`, `promptText`.

`Session.summary?: string` (client type) ↔ `sessions.summary TEXT` (SQLite). `SummarizeResponse = { ok: boolean; summary: string }`.

### UI elements (labels + handlers)

**SummaryTab**
- Empty state: `No summary yet — click SUMMARIZE to generate one with AI` (rendered when `summary` is falsy).
- Populated: `summary` split on `\n`, each line a `<span>` with a trailing `<br/>` except the last (class `styles.summaryText` from `DetailPanel.module.css`).

**SummarizeModal**
- Title `Summarize Session`; close button (`×`) → `handleClose`.
- Prompt list: each row click → `setSelectedPromptId`; cyan border/highlight on selection; `DEFAULT` badge for `isDefault`.
  - `★` (`&#9733;`) → `handleSetDefault` (clears prior default, sets this one; toast `Default prompt set`).
  - `✎` (`&#9998;`) → `handleEdit` (loads template into form).
  - `×` (`&times;`) → `handleDelete` (toast `Prompt template removed`).
- Empty list message: `No prompt templates yet. Create one below.`
- Custom-prompt form (toggled by `CUSTOM PROMPT` / `HIDE FORM`): `Template name` input, `Write your summary prompt...` textarea.
  - `SAVE`/`UPDATE` → `handleSaveTemplate` (validates non-empty name+prompt; toast `Template saved`/`Template updated`; warning `Name and prompt are required`).
  - `USE ONCE` → `handleUseOnce` (runs summarize with the typed prompt without saving; warning `Write a prompt first`).
- `SUMMARIZE` button → `runSummarize(selectedPromptId, null)`; disabled when no selection or while `running`; label flips to `SUMMARIZING...` while in flight.
- Success toast: `AI summary generated & session archived` (if still on same session) or `Summary generated for session <id8>` (if user switched away). Failure toast: server `error` or `Summarize failed`.

**SummaryPromptSettings**
- Heading `Summary Prompt Templates`; hint `Manage templates for AI-generated session summaries. Star a template to make it the default.`
- Per-template row: star toggle (default = cyan), name (`escapeHtml`'d), `DEFAULT` chip, edit (`✎`), delete (`×`), and a 120-char prompt preview.
- Add/Edit form: `Template name` input, `Prompt template text...` textarea (4 rows); button `Add Template`/`Update Template` → `handleSave`; `Cancel` → `handleCancelEdit` (only while editing).
- Empty state: `No prompt templates`.

### Endpoints

- `POST /api/sessions/:id/summarize` — body `{ context: string, promptTemplate?: string, custom_prompt?: string }`.
  - Returns `{ ok: true, summary }` on success.
  - `429 { success: false, error: 'Too many concurrent summarize requests (max 2)' }` when over the concurrency cap.
  - `500 { success: false, error: 'Summarize failed' }` on subprocess error.

### Storage keys

- IndexedDB (Dexie `AascDb`): table `summaryPrompts` (`++id, isDefault`).
- SQLite (`server/db.ts`): `sessions.summary` column, written via `updateSessionSummary`.

### Step-by-step flows

**Run a summary (modal):**
1. Some caller sets `useUiStore.activeModal = SUMMARIZE_MODAL_ID`; modal opens (returns `null` if no `selectedSessionId`).
2. `useEffect` loads all templates via `db.summaryPrompts.toArray()` and auto-selects the one with `isDefault`.
3. User selects a template (or opens the custom form and types one).
4. On `SUMMARIZE`/`USE ONCE`, `runSummarize(promptId, customText)`:
   a. Guards against re-entry via `running`; captures `targetSessionId = selectedSessionId` (avoids stale-closure bug #6); sets `running`; closes the modal.
   b. `buildContext()` assembles a transcript string: `Project`, `Status`, `Started`/`Ended` ISO timestamps, then `--- PROMPTS ---` (from `session.promptHistory`), `--- TOOL CALLS ---` (from `session.toolLog`, `tool: input`), `--- RESPONSES ---` (from `session.responseLog`).
   c. Resolves `promptTemplate` from `customText` or by loading `db.summaryPrompts.get(promptId)`.
   d. `fetch('/api/sessions/<id>/summarize', POST { context, promptTemplate })`.
5. Server validates with `summarizeSchema`, picks `custom_prompt || promptTemplate || default`, builds `${prompt}\n\n--- SESSION TRANSCRIPT ---\n${context}`, runs `claude -p --model haiku` (writes prompt to stdin), and resolves with trimmed stdout.
6. Server calls `setSummary(sessionId, summary)` (memory + `updateSessionSummary` SQLite write, invalidates cache) and `archiveSession(sessionId, true)`, then returns `{ ok: true, summary }`.
7. Client shows a success/failure toast; if the user is still on `targetSessionId`, the toast notes the session was archived.

**Template CRUD (settings or modal):**
- Save: validates trimmed name+prompt; `db.summaryPrompts.add` (new) or `.put`/`.update` (edit) with `updatedAt = Date.now()`.
- Set default: iterates all templates, clears `isDefault` on others, sets `isDefault = 1` on the target (only one default at a time).
- Delete: `db.summaryPrompts.delete(id)` then reload.

## Dependencies & Connections

### Depends On
- [frontend/state-management.md](state-management.md) — `useUiStore` (`activeModal`/`closeModal`) gates the modal; `useSessionStore` provides `selectedSessionId` and the `sessions` Map whose `promptHistory`/`toolLog`/`responseLog` feed `buildContext`.
- [frontend/client-persistence.md](client-persistence.md) — Dexie `summaryPrompts` table for template storage/retrieval.
- [server/api-endpoints.md](../server/api-endpoints.md) — `POST /api/sessions/:id/summarize` handler, validation, and concurrency limiter.
- [server/session-management.md](../server/session-management.md) — `setSummary()` and `archiveSession()` mutate session state and broadcast.
- [server/database.md](../server/database.md) — `sessions.summary` column and `updateSessionSummary` statement persist the summary.
- [frontend/ui-primitives.md](ui-primitives.md) — `showToast` from `ToastContainer` for all user feedback.
- [frontend/settings-system.md](settings-system.md) — `SummaryPromptSettings` is a settings-panel sub-component (currently only referenced by a stale test mock).

### Depended On By
- [frontend/session-detail-panel.md](session-detail-panel.md) — historically hosted the Summary tab and the `SUMMARIZE` action; the `SummaryTab` is meant to render inside the detail panel's tab content.
- [frontend/conversation-view.md](conversation-view.md) — shares the same underlying session transcript data (`promptHistory`/`toolLog`/`responseLog`) that `buildContext` serializes.

### Shared Resources
- `session.summary` field — written by the server summarize flow, read by `SummaryTab`; persisted in both SQLite and the client `Session` object.
- `summaryPrompts` IndexedDB table — shared by `SummarizeModal` and `SummaryPromptSettings`; both perform CRUD and "set default" against it.
- `showToast` global toast queue.
- The `claude` CLI binary on the server host (invoked with `-p --model haiku`).

## Change Risks

- **Orphaned components.** `SummaryTab`, `SummarizeModal`, and `SummaryPromptSettings` are not imported by any live UI in the current `src` tree (`DetailTabs` has no Summary tab; `SettingsPanel`'s tab list — appearance/sound/hooks/apikeys/translation/shortcuts/advanced — does not include summary prompts). `SettingsPanel.test.tsx` still `vi.mock`s `./SummaryPromptSettings`, a stale reference. Re-wiring them (adding a Summary tab to `DetailTabs`, mounting `SummarizeModal`, adding a settings sub-tab) is required to surface this feature; until then, edits here have no user-visible effect.
- **Context size.** `buildContext` concatenates the entire `promptHistory`/`toolLog`/`responseLog`; very long sessions can exceed the server subprocess `maxBuffer` (1 MB) or the 60s `timeout`, causing `Summarize failed`.
- **CLI dependency.** The endpoint shells out to `claude -p --model haiku`. Renaming the model, changing the binary, or running on a host without the `claude` CLI breaks summarization. Changing flags here also affects cost/quality of every summary.
- **Archiving side effect.** Summarizing always calls `archiveSession(..., true)`. Any UI that filters archived sessions ([views-routing.md](views-routing.md), [project-browser.md](project-browser.md)) will hide a session immediately after it is summarized — surprising if "summarize" is ever decoupled from "archive".
- **`isDefault` is a number, not a boolean.** Dexie indexes it as `0|1`. Treating it as a boolean (e.g. `isDefault: true`) breaks the index query and the single-default invariant; both CRUD components must keep clearing the prior default before setting a new one.
- **Request shape coupling.** The client sends `promptTemplate` (camelCase); the server also accepts `custom_prompt` (snake_case) with precedence `custom_prompt > promptTemplate > default`. Renaming either field on one side without the other silently falls back to the generic default prompt.
- **Stale-closure guard.** `runSummarize` deliberately captures `targetSessionId` at invocation time; removing this reintroduces bug #6 (summary toast attributed to the wrong session when the user switches sessions mid-request).

# REVIEW Tab — Saved Explanations & Translations

> **Function** Persist every selection-popup / translate-toolbar action together
> with its surrounding context, capture the AI response when the floating
> session is closed, and surface the entire history in a dedicated nav tab for
> later review.

## Purpose

When the user is learning a topic via the [Floating Terminal Fork](./floating-terminal-fork.md)
feature, every explanation or translation they request is worth keeping — but
floating windows are ephemeral. The REVIEW tab is the persistent journal:

- Every spawn writes a draft entry with prompt context.
- Closing the float captures the AI output (ANSI-stripped) into the same entry.
- The user can browse, search, archive, annotate, and delete entries.

## Source Files

| File | Role |
|------|------|
| `src/lib/db.ts` | Adds `DbTranslationLog` interface + `translationLogs` table (Dexie v3 schema bump). |
| `src/lib/translationLog.ts` | CRUD helpers: `createLog`, `findByUuid`, `findByFloatTerminalId`, `updateLog`, `captureResponse`, `listLogs`, `setArchived`, `setNotes`, `deleteLog`. |
| `src/lib/ansi.ts` | Tiny ANSI escape stripper used by `captureResponse`. |
| `src/routes/ReviewView.tsx` | The new view: filters, list, expandable rows, notes textarea. |
| `src/styles/modules/ReviewView.module.css` | Themed styling. |
| `src/components/layout/NavBar.tsx` | Adds `REVIEW` link after `QUEUE`. |
| `src/App.tsx` | Lazy-loads + registers `<Route path="/review" />`. |
| `src/stores/floatingSessionsStore.ts` | On `close()`: GETs `/api/terminals/:id/output`, base64-decodes, calls `captureResponse(terminalId, raw)` to persist. |
| `src/components/translate/SelectionPopup.tsx` | Calls `createLog` after a successful spawn (modes 1, 2). |
| `src/components/terminal/TerminalContainer.tsx` | Calls `createLog` for `translate-answer`. |
| `src/components/session/ProjectTab.tsx` | Calls `createLog` for `translate-file`. |
| `server/apiRouter.ts` | Adds `GET /api/terminals/:id/output` (base64 ring-buffer snapshot). |

## Data Model

```ts
interface DbTranslationLog {
  id?: number;                  // Dexie auto id
  uuid: string;                 // stable id, generated client-side
  mode: 'explain-learning' | 'explain-native' | 'translate-answer' | 'translate-file';
  nativeLanguage: string;
  learningLanguage: string;
  selection: string;            // for explain-* modes
  contextLine: string;          // surrounding sentence
  filePath: string;             // for translate-file
  fileContent: string;          // truncated to 32 KB on save
  prompt: string;               // (reserved — not yet populated; could mirror server prompt)
  response: string;             // captured at float close, ANSI-stripped, ≤ 256 KB
  originSessionId: string;
  originProjectName: string;
  originSessionTitle: string;
  floatTerminalId: string;      // ties draft → response capture
  notes: string;                // user-authored
  archived: 0 | 1;
  createdAt: number;
  updatedAt: number;
}
```

Indexes: `++id, uuid, mode, createdAt, originSessionId, archived, floatTerminalId`.

## Capture Pipeline

```
User clicks 🔎 / 🌐 / Translate-answer / Translate-file
   │
   ▼
POST /api/sessions/spawn-floating  →  { terminalId, label }
   │                       │
   │                       ▼
   │                createLog({ mode, selection, contextLine, originSession…,
   │                            floatTerminalId: terminalId })
   ▼
floatingSessionsStore.open()    →  FloatingTerminalPanel renders
   ⋮  user reads the AI response in the floating window
   ▼
floatingSessionsStore.close(terminalId)
   ├─ GET /api/terminals/:id/output  →  { output: <base64> }
   ├─ atob → captureResponse(terminalId, raw)
   │       ├─ stripAnsi
   │       └─ db.translationLogs.update(…, { response, updatedAt })
   └─ DELETE /api/terminals/:id     (kills pty)
```

## REVIEW View

Live polling reload (every 4 s) plus immediate reload after local mutations.
Filters: `mode`, `archived` (active / archived / all), free-text `search`.

Each row:
- Header (always visible): mode icon + label, target language chip, origin
  project + session, relative time, source snippet.
- Expanded body: full source, file path (translate-file), surrounding line,
  full AI response (with copy button), notes textarea, archive / delete
  buttons, timestamps.

## Privacy

All data lives in the local browser IndexedDB (`claude-dashboard` /
`translationLogs`). Nothing is sent to a server we don't already use. Settings
panel does not yet expose an "export" button — Phase 2 if requested.

## Cross-Feature Dependencies

| Connected feature | Why |
|-------------------|-----|
| [Floating Terminal Fork](./floating-terminal-fork.md) | Drafts are created by every spawn; responses captured at float close. |
| [Client persistence](./client-persistence.md) | Adds a new table to the existing Dexie database; bumps version 2 → 3. |
| [API endpoints](../server/api-endpoints.md) | New `GET /api/terminals/:id/output` route. |
| [State management](./state-management.md) | `floatingSessionsStore.close()` now does response capture before pty kill. |

## Change Risks

* **DB migration**: Dexie auto-adds the new table at version 3. Existing
  installs upgrade transparently. Rolling back below v3 will leave the table
  intact but unused.
* **Response capture is best-effort**: terminal output ring buffer is only ~1MB
  and the AI may still be streaming when the user closes the float. We capture
  whatever's present at that moment. Phase 2 could expose a "refresh capture"
  button while the float is open.
* **ANSI stripping is pragmatic, not exhaustive** — if AI output ever uses
  unusual escape sequences (e.g. cursor save/restore that we don't match)
  artifacts could leak through. Add cases to `src/lib/ansi.ts` as needed.
* **Storage growth**: there's no auto-archive (per user preference). Each
  entry is capped at 256 KB response + 32 KB source content. With 1,000 entries
  ≈ 300 MB worst-case. Add manual export / clear-all if this becomes a
  concern.

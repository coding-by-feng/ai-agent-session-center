# Conversation View

## Function

The Conversation View renders the full interleaved transcript of a session — user prompts, assistant responses, tool calls, tool results, and lifecycle events — in chronological order inside the detail panel's **CONVERSATION** tab. It prefers the real Claude Code JSONL transcript fetched from the server (untruncated fidelity) and falls back to reconstructing the view from the session's in-memory logs when no transcript is available.

## Purpose

The in-memory session logs that drive most of the UI are truncated and split into separate buckets (`promptHistory`, `responseLog`, `toolLog`, `events`). To review a session the way a human reads a chat, those buckets must be merged back into a single chronological thread, and the real on-disk transcript gives a far more complete picture (every assistant turn and tool call, not just the capped in-memory slices). This feature provides that single readable thread, plus collapsible sections for prior sessions in the same project so resumed/continued work can be reviewed in one place.

## Source Files

| File | Role |
|------|------|
| `src/components/session/ConversationView.tsx` | React component: fetches transcript on mount, runs it through `transformEntries`, renders each entry (`EntryRow`), the per-entry `CopyButton`, collapsible `PrevSessionSection` and `SystemRow` blocks, and a sticky toolbar (role filter + jump-to-latest); shows loading / empty states. |
| `src/lib/transcript.ts` | Client helpers: `ConversationEntry` union type (incl. client-only `command`/`system` roles), `fetchTranscript()` (calls the server endpoint), and `reconstructFromLogs()` (in-memory fallback builder). |
| `src/lib/commandMessage.ts` | `transformEntries()` — rewrites Claude Code harness plumbing (`<command-name>` / `<command-args>` / `<local-command-stdout>` / `<local-command-caveat>`) in raw `user` entries into compact `command` chips (stdout folded in) and collapsible `system` rows. |
| `src/components/session/DetailPanel.tsx` | Host: passes session logs + `searchQuery` + `projectPath` into `ConversationView` as `promptsContent`, and drives search-match highlight/navigation over the rendered `.search-highlight` nodes. |
| `src/components/session/DetailTabs.tsx` | Defines the `conversation` tab (label `CONVERSATION`) and wraps `promptsContent` in a `tabScroll` container. |
| `src/components/session/LinkifiedText.tsx` | Renders entry text, turning file paths / URLs into clickable links (used for user/assistant/previous-session text). Clicking a path opens the [File-Open Chooser](./file-open-chooser.md) popover anchored at the cursor. |
| `server/extractPreviousAnswer.ts` | Server source of the transcript: `readClaudeTranscript()` parses the Claude JSONL into the matching `ConversationEntry[]` (also defines `readClaudeLastAssistant`). |
| `server/apiRouter.ts` | Hosts `GET /api/sessions/:id/transcript`, which calls `readClaudeTranscript` and never 500s (returns empty array on any error). |
| `src/styles/modules/DetailPanel.module.css` | All `conv*` / `prevSession*` styles (entry rows, role badges, tool name/input, copy button, collapsible headers, the sticky `convToolbar` filter pills + jump-to-latest, `convCommand*` chip, and `convSystemRow*` collapsible). |

## Implementation

### Data structure — `ConversationEntry` (discriminated union)

The first five roles are defined identically in `src/lib/transcript.ts` and `server/extractPreviousAnswer.ts` (kept in sync by convention). The `command` and `system` roles are **client-only** — the server never emits them; they are synthesized in the browser by `transformEntries` (`src/lib/commandMessage.ts`) from raw `user` entries:

```ts
type ConversationEntry =
  | { role: 'user';        text: string; timestamp: number }
  | { role: 'assistant';   text: string; timestamp: number }
  | { role: 'tool_use';    tool: string; input: string; timestamp: number }
  | { role: 'tool_result'; tool?: string; output: string; timestamp: number; isError?: boolean }
  | { role: 'event';       eventType: string; detail: string; timestamp: number }
  // client-only — synthesized by transformEntries():
  | { role: 'command';     name: string; args?: string; stdout?: string; timestamp: number }
  | { role: 'system';      text: string; timestamp: number }
```

### Harness-plumbing transform — `transformEntries` (`commandMessage.ts`)

Claude Code emits internal `user` messages wrapped in harness tags. Rendering them verbatim buries the real conversation, so on load every entry list is post-processed (both the fetched transcript and the in-memory fallback):

- A `user` entry containing `<command-name>…</command-name>` → a `command` entry: `name` (e.g. `/clear`), `args` (from `<command-args>`, only when non-empty), and `stdout` (from `<local-command-stdout>`, when present).
- A standalone `<local-command-stdout>` entry → folded into the immediately preceding `command` entry that has no `stdout` yet (spread into a new object); if there is none, it becomes its own `system` entry.
- A `<local-command-caveat>` entry (the "DO NOT respond…" boilerplate) → a `system` entry holding only the inner text.
- All other entries pass through unchanged; order is preserved.
- A cheap `RE_ANY_TAG` pre-check (`<command-name>|<local-command-caveat>|<local-command-stdout>`) skips regex work for ordinary messages.

### Component props — `ConversationViewProps`

`sessionId`, `transcriptPath?`, `prompts: PromptEntry[]`, `responses: ResponseEntry[]`, `toolCalls: ToolLogEntry[]`, `events: SessionEvent[]`, `previousSessions?: ArchivedSession[]`, `searchQuery?`, `projectPath?`. (`transcriptPath` is accepted in the prop interface but not currently consumed by the component — the fetch is keyed on `sessionId` only; the server resolves the path itself.)

### Local state

- `entries: ConversationEntry[]` — the rendered thread, already passed through `transformEntries` (`useState([])`).
- `loading: boolean` — true while the fetch is in flight (`useState(true)`).
- `filter: RoleFilter` — `'all' | 'user' | 'asst' | 'tool'` (starts `'all'`); drives the toolbar pills and `visibleEntries`.
- `atBottom: boolean` — whether the bottom sentinel is in view; disables the jump-to-latest button (starts `true`).
- `rootRef` / `bottomRef` — refs to the view root (for scroll-parent discovery) and the bottom sentinel `<div>` (scroll target + IntersectionObserver subject).
- `query` — `searchQuery?.toLowerCase() || ''`, used for highlight matching.
- `CopyButton`: `copied: boolean` (resets after **1500 ms**).
- `PrevSessionSection`: `collapsed: boolean` (starts `true` — collapsed by default).
- `SystemRow`: `collapsed: boolean` (starts `true` — caveat hidden by default).

### Role filter & jump-to-latest

- `FILTERS` = `[All, User, Asst, Tool]`. `matchesFilter(role, filter)`: **User** → `user` + `command`; **Asst** → `assistant`; **Tool** → `tool_use` + `tool_result`; **All** → everything. `system`/`event` and previous-session blocks only appear under **All**.
- `visibleEntries` (`useMemo`) is `entries` filtered by `matchesFilter` (or all of `entries` when `filter === 'all'`).
- `getScrollParent(el)` walks up from `rootRef` to the nearest ancestor whose computed `overflow-y` is `auto`/`scroll` and that actually overflows; used as the IntersectionObserver `root` so "at bottom" is measured against the real tab scroll container, not the viewport.
- An `IntersectionObserver` (guarded by `typeof IntersectionObserver !== 'undefined'`, re-created on `visibleEntries.length` change) observes `bottomRef` and sets `atBottom`. `jumpToLatest` calls `bottomRef.current.scrollIntoView({ block: 'end', behavior: 'smooth' })`.

### Constants & caps

Client (`transcript.ts`): no numeric caps — display truncation happens at render time in `EntryRow`:
- `tool_use` input rendered: truncated to **240** chars + `…`.
- `tool_result` output rendered: truncated to **400** chars + `…`.

Server (`extractPreviousAnswer.ts`, applied before the data is sent):
- `TOOL_INPUT_CAP = 2 * 1024` (2 KB per tool-call input).
- `TOOL_RESULT_CAP = 4 * 1024` (4 KB per tool result).
- `MAX_ENTRIES = 2000` (most recent entries kept to bound payload).

### UI elements (labels + handlers)

| Element | Label / content | Handler / behavior |
|---------|-----------------|--------------------|
| Role badge (`convRole`) | `USER`, `ASSISTANT`, `TOOL`, `TOOL RESULT`, `TOOL ERROR`, or the raw `eventType` for events | static |
| Filter pills (`convFilterPill` / `convFilterPillActive`) | `All` / `User` / `Asst` / `Tool` in the sticky `convToolbar` | `onClick` → `setFilter(key)` |
| Jump-to-latest (`convJumpLatest`) | `↓ latest` | `onClick` → `jumpToLatest()`; `disabled` while `atBottom` |
| Command chip (`convCommand`) | `⌘ {name}` (`convCommandName`) + optional `{args}` (`convCommandArgs`), and a folded `↳ {stdout}` line (`convCommandStdout`) | static; carries a `USER` badge |
| System row (`convSystemRow`) | `▶ system (1 hidden)` header (`convSystemHeader`); expands to raw caveat/plumbing text (`convSystemBody`) | `onClick` header toggles `collapsed` |
| Timestamp (`convTime`) | `formatTime(ts)` → `toLocaleTimeString('en-US', { hour12: false })`; empty string when `ts <= 0` | static |
| Copy button (`convCopy`) | `COPY` → `COPIED` (1.5 s) | `handleCopy`: `e.stopPropagation()`, `navigator.clipboard.writeText(text.trim())`; shown on user & assistant entries only |
| Tool name (`convToolName`) / input (`convToolInput`) | `entry.tool` + capped input/output | static; error results use `convToolFailed` class instead of `convTool` |
| Previous-session header (`prevSessionHeader`) | `Previous Session #{i+1} ({start} - {end}) · {n} prompts`, with ▶ toggle (`prevSessionToggle`) | `onClick` toggles `collapsed`; prompts listed newest-first, numbered `#{count - j}` |
| Loading state | `Loading transcript…` (`tabEmpty`) | shown while `loading && entries.length === 0` |
| Empty state | `No conversation yet` (`tabEmpty`) | shown when not loading, no entries, and no previous sessions |
| Per-section empty | `No prompts in this session` | inside an expanded previous-session block with no prompts |

### Search highlighting

`highlightClass(text, query)` appends the **global** class `search-highlight` (note: not a CSS-module class — it is a plain global selector in `src/styles/base.css`) to any entry whose text contains the lowercased query. DetailPanel owns search-match navigation: it queries `.search-highlight` nodes across the panel and toggles `search-highlight-active` on the current match as the user steps through results. The query string is built per entry by role (e.g. tool entries match against `` `${entry.tool} ${entry.input}` ``; tool results match against `entry.output`; events against `` `${entry.eventType} ${entry.detail}` ``).

### Endpoint

`GET /api/sessions/:id/transcript` → `{ success: true, data: ConversationEntry[] }`

- Server resolves the live session, then calls `readClaudeTranscript(session.sessionId || id, session.projectPath, session.transcriptPath ?? null)`.
- Returns `{ success: true, data: [] }` when the session is unknown, has no `projectPath`, or on any thrown error (logged via `log.warn('api', …)`) — it **never 500s**, so the client can always fall back to in-memory logs.
- Server transcript lookup order (in `readClaudeTranscript`/`findTranscriptFile`): (1) `transcriptPath` if it exists; (2) `<sessionId>.jsonl` under the encoded `~/.claude/projects/<encoded-project>` directory; (3) newest `.jsonl` in that directory. JSONL `system`/`summary` records are skipped; assistant `text` blocks → `assistant`, assistant `tool_use` blocks → `tool_use`, user content → `user`/`tool_result`. Timestamps come from each record's `timestamp` (falling back to the previous entry's timestamp when missing).

### Flow A — fetch real transcript (primary)

1. On mount and on every `sessionId` change, the `useEffect` sets `loading = true` and calls `fetchTranscript(sessionId)`.
2. `fetchTranscript` issues `GET /api/sessions/${encodeURIComponent(sessionId)}/transcript`. On non-ok response, malformed body, missing `success`, or thrown error it returns `[]`.
3. The raw list is `transcript` when non-empty, else `reconstructFromLogs(prompts, responses, toolCalls, events)` (in-memory fallback, captured at fetch time).
4. The raw list is run through `transformEntries(raw)` before `setEntries(...)`, so command/system synthesis applies to both the real transcript and the fallback.
5. `finally` → `setLoading(false)` (guarded by a `cancelled` flag so a fast session switch doesn't overwrite newer state).

> The effect deliberately depends on `sessionId` only (`exhaustive-deps` disabled); in-memory logs are the fallback captured at fetch time, so live prop updates do not re-run the fetch.

### Flow B — reconstruct from in-memory logs (fallback)

`reconstructFromLogs(prompts, responses, toolCalls, events)`:
1. Push each prompt as `user`, each response as `assistant`.
2. For each tool call push a `tool_use`; if `t.failed || t.error`, also push a `tool_result` with `isError: true` and `output = t.error || 'Tool failed'` (note: successful tool results are **not** reconstructed in fallback mode — only failures are surfaced).
3. Push each session event as `event` (`eventType = e.type`, `detail = e.detail`).
4. Sort all entries by `timestamp` ascending so the thread reads top-to-bottom.

### Flow C — render

1. The sticky `convToolbar` (role pills + `↓ latest`) renders first inside the view root.
2. Previous sessions (if any, and only when `filter === 'all'`) render next, **reversed** (most recent prior session first), each as a collapsed `PrevSessionSection`.
3. Then `visibleEntries` render: `system` entries via `SystemRow`, everything else via `EntryRow` (keyed `` `${entry.timestamp}-${i}` ``).
4. A bottom sentinel `<div ref={bottomRef} />` is the scroll target for jump-to-latest and the IntersectionObserver subject for `atBottom`.
5. If `visibleEntries` is empty: show `Loading transcript…` while loading; otherwise `No conversation yet` (filter `all`) or `No matching messages` (a narrowing filter is active) — unless previous sessions are shown, in which case nothing extra is shown.

## Dependencies & Connections

### Depends On

- [server/api-endpoints.md](../server/api-endpoints.md) — hosts `GET /api/sessions/:id/transcript` consumed by `fetchTranscript`.
- [server/floating-session-spawner.md](../server/floating-session-spawner.md) — `server/extractPreviousAnswer.ts` (the transcript reader and the canonical `ConversationEntry` type) is part of the floating-session/extract-previous-answer module.
- [frontend/session-detail-panel.md](./session-detail-panel.md) — DetailPanel/DetailTabs host the view, supply props (session logs, `projectPath`, `previousSessions`), and own the `searchQuery` and match-navigation logic.
- [frontend/state-management.md](./state-management.md) — `PromptEntry`, `ResponseEntry`, `ToolLogEntry`, `SessionEvent`, `ArchivedSession` come from the session store / shared types.

### Depended On By

- [frontend/session-detail-panel.md](./session-detail-panel.md) — renders `ConversationView` as the CONVERSATION tab content.
- [frontend/summary-tab.md](./summary-tab.md) — sibling detail tab over the same session; both reconstruct/summarize the conversation thread (Summary uses server-side summarization; this tab shows the raw transcript).

### Shared Resources

- **`ConversationEntry` union** — duplicated in `src/lib/transcript.ts` and `server/extractPreviousAnswer.ts`; the two **must stay in sync** (no shared import across the server/client boundary here).
- **Claude Code JSONL transcripts** — `~/.claude/projects/<encoded-project>/<sessionId>.jsonl`, read by the server; also the data source for last-assistant extraction used by floating sessions ([server/floating-session-spawner.md](../server/floating-session-spawner.md)).
- **Global `.search-highlight` / `.search-highlight-active` classes** (`src/styles/base.css`) — shared with DetailPanel's cross-tab search navigation.
- **`LinkifiedText`** — shared text renderer for clickable paths/URLs. File-path clicks call `uiStore.openFileChooser(path, projectPath, { x, y })` (cursor coords; keyboard Enter anchors to the link's bounding rect) to show the [File-Open Chooser](./file-open-chooser.md) popover instead of opening directly.

## Change Risks

- **`ConversationEntry` shape drift** — the **five base roles** must stay in sync across `src/lib/transcript.ts` and `server/extractPreviousAnswer.ts`: server fields the client doesn't render are dropped, and client expectations the server stops sending cause blank entries. The `command`/`system` roles are **client-only** (synthesized by `transformEntries`); the server must never emit them, and `EntryRow` returns `null` for any non-`event` role it doesn't explicitly handle (so a future client-only role won't render until a branch is added).
- **`transformEntries` tag coupling** — the parser keys off the literal Claude Code tags (`<command-name>`, `<command-args>`, `<local-command-stdout>`, `<local-command-caveat>`). If the CLI renames or restructures these, commands silently fall back to raw `user` text again. The pre-check `RE_ANY_TAG` and the per-tag regexes in `commandMessage.ts` must be updated together (covered by `src/lib/commandMessage.test.ts`).
- **Role filter hides content** — `User`/`Asst`/`Tool` deliberately drop `system`/`event` rows and previous-session blocks; only **All** shows everything. A stuck non-`all` filter can make the view look empty (`No matching messages`).
- **Jump-to-latest scroll root** — `getScrollParent` must find the real scrolling ancestor (`DetailTabs` `tabScroll`); if the tab's overflow styling changes so no ancestor reports `auto`/`scroll`, the IntersectionObserver falls back to the viewport `root` and `atBottom` (button enable/disable) can read incorrectly.
- **Endpoint contract** — `fetchTranscript` requires `{ success: true, data: [...] }`; any other shape (or a real 500) forces the in-memory fallback, which only shows failed tool results and truncated logs. Keep the endpoint returning an empty array (200) on error rather than throwing. Affects [server/api-endpoints.md](../server/api-endpoints.md).
- **`sessionId`-only effect dependency** — because the fetch is keyed on `sessionId`, prop updates to `prompts`/`responses`/`toolCalls`/`events` after mount do **not** refresh the view; the fallback snapshot is captured once. Reworking the effect deps changes refresh semantics and could cause flicker on every store update.
- **CSS-module vs global class** — the highlight class `search-highlight` is intentionally global; renaming it to a module class would silently break DetailPanel's match navigation (which queries the global selector). Affects [frontend/session-detail-panel.md](./session-detail-panel.md).
- **Render truncation caps (240 / 400)** and server caps (2 KB / 4 KB / 2000 entries) bound payload and DOM size; raising them risks large transcripts bloating memory/render time in the detail panel.
- **Transcript file resolution** depends on the `~/.claude/projects` directory-name encoding; changes to how Claude Code encodes project paths (or to `findTranscriptFile`'s candidates) can cause the view to silently fall back to in-memory logs. Affects [server/floating-session-spawner.md](../server/floating-session-spawner.md).

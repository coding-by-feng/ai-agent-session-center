# Command Autocomplete

## Function

Provides inline `/`-slash-command, `$`-Codex-skill and `@`-file autocomplete inside prompt textareas (queue editor, queue tab) by enumerating every available slash command and skill for the session's CLI (Claude / Codex / Gemini) and surfacing them in a grouped dropdown. A separate, lighter helper (`commandSuggestions.ts`) powers the launch-command comboboxes in the session-creation modals using a localStorage usage-frequency ranking.

## Purpose

When queuing or editing a prompt the user often wants to invoke a slash command (`/clear`, `/compact`, a project command, a plugin command, a skill) but can't remember the exact name, source, or plugin slug. The command index walks the on-disk command/skill directories for the active CLI (plus a hardcoded catalog of in-binary built-ins that aren't discoverable from disk) so the autocomplete can list, describe, and group them. This avoids forcing the user to switch to the terminal and type `/help`, and ensures plugin-namespaced names (`pluginName:command`) are spelled the way the CLI expects. The session-creation suggestions exist so the most-used launch commands float to the top of the New/Quick session combobox.

**Codex addresses skills with `$name`, not `/name`.** Its TUI has a dedicated `$` popup and its system prompt says "if the user names a skill with `$SkillName` … you must use that skill". A queued `/retouch-current-prompt` is therefore inert on a Codex session — the sigil is load-bearing, not cosmetic. The index consequently walks Codex's skill roots and the dropdown routes each entry to the sigil its CLI accepts.

## Source Files

| File | Role |
|------|------|
| `server/commandIndex.ts` | Server-side enumerator. Walks project/global/plugin command + skill directories per CLI, parses YAML frontmatter for descriptions, appends hardcoded built-in catalogs, caches results 30 s per `(cli, projectPath)`. Backing logic for `GET /api/commands`. |
| `src/lib/commandIndex.ts` | Client-side fetch + cache wrapper. Calls `GET /api/commands`, memoizes 30 s with in-flight dedupe, and provides `filterAndGroup` / `entryDisplayName` / `entrySourceLabel` / `entryPrefix` / `entryToken` helpers used by the dropdown. |
| `src/lib/autocompleteTrigger.ts` | Pure `parseTrigger(text, pos)` — finds the active `@` / `/` / `$` sigil before the caret. Extracted from the component so the precedence rule (last valid sigil wins) is unit-testable. |
| `src/components/ui/AutocompleteTextarea.tsx` | Controlled `<textarea>` React component. Detects `/`, `$` and `@` triggers, fetches commands (via `commandIndex`) and files (via `/api/files/search`), renders the grouped dropdown, and handles keyboard navigation + insertion. |
| `src/lib/commandSuggestions.ts` | Unrelated-but-adjacent helper for session-creation launch-command comboboxes: a static `DEFAULT_SESSION_COMMANDS` list plus localStorage usage-frequency ranking (`getCommandSuggestions` / `saveCommand`). |
| `server/apiRouter.ts` (route only) | Defines `GET /api/commands` which delegates to `getCommandIndex`. |
| `test/commandIndex.codex.test.ts` | Codex skill enumeration: `CODEX_HOME` override, `.system` builtins, `_`-dir skipping, symlinked skill dirs, project skills, prompts-vs-skills separation. |
| `src/lib/autocompleteTrigger.test.ts` | `parseTrigger` sigil precedence, whitespace anchoring, whitespace-terminated fragments, bare-sigil queries. |
| `src/components/ui/AutocompleteTextarea.test.tsx` | `$` menu is Codex-only, inserts with the `$`; `/` on Codex lists prompts but not skills; `/` on Claude still lists both. |

## Implementation

### Constants & values

- **Server `CACHE_TTL_MS = 30_000`** and **client `TTL_MS = 30_000`** — both cache the index for 30 seconds per `(cli, projectPath)` key (`${cli}|${projectPath || ''}`).
- **`DROPDOWN_MIN_DOWN_HEIGHT = 220`** (AutocompleteTextarea) — minimum px below the textarea before the dropdown is allowed to open downward; otherwise it opens upward.
- **File-search debounce = `150` ms** for `@` triggers; **cold-index retry = `300` ms** with **max `5` attempts** (`attempt < 5`) when the server responds `indexing: true`.
- **File results capped at `8`** (`.slice(0, 8)`).
- **Description length caps** — server slices descriptions to 240 chars; `firstNonEmptyLine` caps body fallback to 200 chars.
- **`isSafeProjectPath`** rejects empty, `>1024`-char, or NUL-containing paths and requires `statSync(p).isDirectory()`.
- **`COMMAND_USAGE_KEY = 'command-usage-counts'`** — localStorage key for the session-creation suggestion frequency map.
- **`DEFAULT_SESSION_COMMANDS`** — `claude`, `claude --resume`, `claude --continue`, `claude --model sonnet`, `claude --model opus`, `claude --dangerously-skip-permissions`, `claude --verbose`, `gemini`, `gemini --yolo`, `codex`, `codex --dangerously-bypass-approvals-and-sandbox`, `aider`.

### Data structures & types

- **`CommandEntry`** — `{ name, description, cli: 'claude'|'codex'|'gemini', kind: 'command'|'skill', source: 'project'|'global'|'plugin'|'builtin', sourcePath?, pluginName? }`. Defined in both `server/commandIndex.ts` and `src/lib/commandIndex.ts` (kept in sync manually).
- **`CommandKind`** = `'command' | 'skill'`; **`CommandSource`** = `'project' | 'global' | 'plugin' | 'builtin'`.
- **`CommandGroup`** (client) — `{ title, source, entries[] }`.
- **`TriggerType`** (`autocompleteTrigger.ts`) = `'command' | 'file' | 'skill'`; **`Trigger`** = `{ type, query, triggerStart }`.
- **`AcItem`** (component) — `{ label, insert, sub?, kind?: 'command'|'skill'|'file' }`.
- **`AcMenu`** (component state) — `{ type: TriggerType, query, items[], groups?, selectedIdx, triggerStart }`.
- Component state: `textarea` (element held as state, not a ref, to satisfy React 19 render rules), `acMenu`, `debounceRef`.

### Built-in command catalogs

Three hardcoded `BuiltinSpec[]` arrays enumerate in-binary slash commands not discoverable from disk:
- **`CLAUDE_BUILTINS`** (35): `add-dir`, `agents`, `bashes`, `bug`, `clear`, `compact`, `config`, `context`, `cost`, `doctor`, `export`, `fix-issue`, `help`, `hooks`, `ide`, `init`, `install-github-app`, `login`, `logout`, `mcp`, `memory`, `model`, `output-style`, `permissions`, `plugin`, `pr-comments`, `release-notes`, `resume`, `review`, `security-review`, `status`, `todos`, `update`, `usage`, `vim`.
- **`CODEX_BUILTINS`** (14): `approvals`, `clear`, `compact`, `diff`, `init`, `logout`, `mcp`, `mention`, `model`, `new`, `quit`, `resume`, `status`, `undo`.
- **`GEMINI_BUILTINS`** (21): `auth`, `bug`, `chat`, `clear`, `compress`, `copy`, `docs`, `editor`, `help`, `init`, `mcp`, `memory`, `model`, `privacy`, `quit`, `restore`, `settings`, `stats`, `theme`, `tools`, `vim`.

### Disk sources walked (server, per CLI)

- **claude**: `<project>/.claude/commands/*.md`, `<project>/.claude/skills/<slug>/SKILL.md`, `~/.claude/commands/*.md`, `~/.claude/skills/<slug>/SKILL.md`, plugin `<installPath>/commands/*.md` and `<installPath>/skills/<slug>/SKILL.md`. Plugins discovered via `~/.claude/plugins/installed_plugins.json` (`readInstalledPlugins` — `pluginName` is the key split on `@`, only entries whose `installPath` exists are kept).
- **codex**: `<project>/.codex/prompts/*.md` (project, `/name`), `<project>/.codex/skills/<slug>/SKILL.md` (project, `$name`), `$CODEX_HOME/prompts/*.md` (global, `/name`), `$CODEX_HOME/skills/<slug>/SKILL.md` (global, `$name`), `$CODEX_HOME/skills/.system/<slug>/SKILL.md` (**source `builtin`**, `$name`).
- **gemini**: `<project>/.gemini/commands/*.toml`, `~/.gemini/commands/*.toml`.

**`codexHome()`** resolves `process.env.CODEX_HOME || ~/.codex`, read per call rather than at module load so an env change needs no restart. Codex's own docs spell every skill path as `$CODEX_HOME/skills`, so hardcoding `homedir()` would miss skills entirely on an overridden setup.

**`.system/` is walked explicitly.** It holds the skills Codex preinstalls (`$imagegen`, `$skill-creator`, `$skill-installer`, `$openai-docs`, `$plugin-creator`, `$review-agent`) — as invocable as any other, but the dot prefix hides the whole tier from the ordinary walk. They are tagged `source: 'builtin'` so they group under "Built-in" and read as shipped-with-Codex. The generic `_`/`.` skip still applies to the *children* of whatever dir is passed, so `_shared/` (a resources dir, not a skill) stays excluded.

Skill dirs skip names starting with `_` or `.` and require a `SKILL.md`. Directory-ness is tested with **`statSync` (`isDirLike`), not `Dirent.isDirectory()`** — the latter reports `false` for a symlink, which silently hid skills linked in from another repo (this affects Claude skills too, not just Codex). Command file name = basename minus `.md`/`.toml`. Description = frontmatter `description` field (or skill `name`/`description`), else first non-empty non-`#` line of the body. Frontmatter parsing is a minimal YAML reader (`parseFrontmatter`) that handles `key: value`, quoted values, block scalars (`>` / `|`), and continuation lines.

### Endpoints

- **`GET /api/commands?cli=<claude|codex|gemini>&projectPath=<absolute>`** — returns `{ entries: CommandEntry[] }`. Validates `cli` (400 `{ error: 'cli must be one of claude|codex|gemini' }` otherwise). `projectPath` optional. 500 `{ error: 'failed to enumerate commands' }` on failure. Cached server-side 30 s per `(cli, projectPath)`.
- **`GET /api/files/search?root=<projectPath>&q=<fragment>`** — used for `@` file autocomplete; returns `{ results: Array<{ path, name, type }>, indexing?: boolean }`. An empty `q` (bare `@`) returns the shallowest workDir files/folders (server `listTopEntries`); `indexing: true` with empty `results` signals the index is still warming and drives the client's cold-index retry (see [File Browser](file-browser.md) / [File Index Cache](../server/file-index-cache.md)).

### Client cache behavior (`src/lib/commandIndex.ts`)

- `fetchCommandIndex(cli, projectPath)` returns cached entries within TTL, dedupes concurrent calls via an `inflight` map, caches successful results (including empty arrays as real results), and on transient fetch failure clears in-flight and returns `[]` **without** poisoning the cache (next call retries).
- `invalidateCommandIndex(cli, projectPath)` drops one cache key.
- `entryDisplayName(entry)` → `pluginName:name` for plugin entries, else bare `name`.
- `entrySourceLabel(entry)` → `'project' | 'global' | 'plugin: <name>' | 'built-in'`.
- `entryPrefix(entry)` → `'$'` when `cli === 'codex' && kind === 'skill'`, else `'/'`.
- `entryToken(entry)` → `entryPrefix(entry) + entryDisplayName(entry)` — exactly what the user should end up with in the prompt. The dropdown derives every label/insert from this, so the two menus can never disagree with what the CLI accepts.
- `filterAndGroup(entries, query, kind)` — filters by `kind`, matches on display name via `startsWith` or `includes` (case-insensitive; empty query matches all), sorts exact-prefix matches first then alpha, then buckets into ordered groups (`Built-in` → `Project` → `Global` → `Plugin: <name>` per plugin). `sourceRank`: builtin=0, project=1, global=2, plugin=3.

### UI elements (AutocompleteTextarea)

- **`<textarea>`** — controlled by `value`/`onChange`. `ref={setTextarea}` stores the element as state.
- **Dropdown** (`.acDropdown`) — `position: fixed`, `z-index: 10100`, width matches the textarea, position/direction computed in a `useMemo` from `getBoundingClientRect()`.
- **Group header** (`.acGroupHeader`) — sticky source title.
- **Item row** (`.acItem` / `.acItemSelected`) with **kind icon** (`.acKindIcon`): `★` for skill, `@` for file, `▸` for command; **label** (`.acLabel`); **sub** (`.acSub`, shows description or `skill`/`command`/file path).
- **Footer** (`.acFooter`) — `"<n> match(es)"` + hint `"↑↓ navigate · Enter select · Esc close"`. The dropdown width tracks the textarea, so in a docked-left panel it can be ~260 px — narrow enough that the two spans no longer fit on one line. `flex-shrink: 0` on the count plus `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` on the hint keeps the footer one line and ellipsizes the hint instead of wrapping it mid-phrase.
- Handlers: `handleChange` (trigger detection), `handleKeyDown` (ArrowDown/ArrowUp wrap-around, Enter inserts when no modifier, Escape closes; all other keys fall through to parent `onKeyDown`), `insertItem` (replaces from `triggerStart` to cursor with `item.insert + ' '`, repositions caret), `onMouseDown` on rows (preventDefault + insert so blur doesn't race), `onBlur` (defers `setAcMenu(null)` via `setTimeout(…, 0)`).

### Trigger parsing (`autocompleteTrigger.ts`)

`parseTrigger(text, pos)` scans the text before the caret for each of the three sigils (`@` file, `/` command, `$` skill) and returns the **last** qualifying one. A sigil qualifies only when it sits at index 0 or directly after whitespace (so `foo$bar`, `a/b`, `mail@example` stay inert) and its fragment holds no whitespace (a completed `$skill do the thing` has moved on; a newline ends the token exactly as a space does).

Last-sigil-wins is load-bearing. The original inline version checked `@` then `/` in a fixed order and only worked by accident — the "fragment has no space" rule happened to reject the earlier sigil. With a third sigil that coincidence breaks, so `/plan $reto` would have kept matching the stale `/`.

### Flow — `/` slash-command and `$` skill autocomplete (in order)

1. User types into the textarea; `handleChange` fires, calls `onChange(next)`, then `parseTrigger(next, cursorPos)`.
2. For a `command` **or** `skill` trigger: `sessionCli(sessionId)` resolves the CLI via `useSessionStore.getState().sessions.get(sessionId)` + `detectCli` (default `claude`).
3. **`$` is Codex-only** — on any other CLI the menu is cleared and no fetch is issued. Prompts are full of `$HOME`, `$1`, `$5.00`; a dropdown on each would be noise.
4. The menu is set optimistically (empty items) so the box appears instantly.
5. Async: `fetchCommandIndex(cli, projectPath)` → client cache or `GET /api/commands`.
6. Which kinds are listed depends on the sigil and CLI:
   - `$` (Codex) → `['skill']`
   - `/` on **Codex** → `['command']` only — its skills are `$`-invocable, so offering them here would queue a prompt the CLI silently ignores.
   - `/` on **Claude / Gemini** → `['command', 'skill']`, commands first (both tiers are `/`-invocable there).
7. `filterAndGroup` runs once per kind; `mergeGroups` merges the lists by title preserving the first list's order, then `commandEntriesToMenu` flattens groups into `AcItem[]` with `groupSpans` for sticky headers. Each item's `label`/`insert` = `entryToken(e)`.
8. The result is committed only if the menu is still the same type with the same `triggerStart` (guards against stale async writes).
9. ArrowUp/Down move `selectedIdx`; Enter (or row mousedown) calls `insertItem`, which splices `'<token> '` into the text and closes the menu. The trailing space matters on Codex: it closes the CLI's own `$`/`/` popup, so a queued prompt whose token is followed by text won't leave that popup swallowing the submitting Enter.

### Flow — `@` file autocomplete

1. Same `parseTrigger` path yields a `file` trigger. `@` autocomplete requires a `projectPath`: when it's missing the menu is cleared (silently skipped — no directory to search).
2. A **bare `@` (empty query) is intentionally NOT suppressed** anymore. As long as `projectPath` is set, the empty query is sent to the server, which returns the shallowest workDir files/folders (server `listTopEntries`), so the picker is useful before the user types a single character.
3. The fetch is factored into a `fetchFiles(attempt)` helper, first invoked after a 150 ms debounce via `debounceRef`: `GET /api/files/search?root=&q=` runs.
4. **Cold-index retry** — if the response is `{ results: [], indexing: true }` (the file index is still warming on a fresh workDir) and `attempt < 5`, `fetchFiles` reschedules itself through `debounceRef` after 300 ms with `attempt + 1`, so a bare `@` (or any query) isn't stuck showing an empty dropdown while the index builds (max 5 attempts).
5. Otherwise, up to 8 results map to `AcItem`s with `insert = '@' + path.replace(/^\//, '')` and `kind: 'file'`.
6. **Stale-response guard** — results are committed only if the menu is still a `file` menu with the same `triggerStart` (`prev.triggerStart === trigger.triggerStart`); a late response arriving after the user moved the trigger is discarded.

### Session-creation suggestions flow (`commandSuggestions.ts`)

1. `getCommandSuggestions()` reads `command-usage-counts` from localStorage, sorts commands by descending count, then appends any unused `DEFAULT_SESSION_COMMANDS`.
2. `saveCommand(cmd)` increments that command's count in localStorage. Consumed by `NewSessionModal` and `QuickSessionModal` comboboxes (saved on session launch).

### Storage keys

- localStorage **`command-usage-counts`** — `{ [command: string]: number }` frequency map (session-creation suggestions only).

## Dependencies & Connections

### Depends On
- [API Endpoints](../server/api-endpoints.md) — hosts `GET /api/commands` and `GET /api/files/search`.
- [File Index Cache](../server/file-index-cache.md) — backs `@` file search results.
- [File Browser](file-browser.md) — sibling consumer of the file-search endpoint.
- [State Management](state-management.md) — `useSessionStore` provides the session used to detect the CLI.

### Depended On By
- [Prompt Queue](prompt-queue.md) — three call sites embed `AutocompleteTextarea`: `QueueTab`'s compose row, and `QueueItemEditModal`'s MAIN prompt plus every before/after chain step. (A fourth — the inline once-item row editor — was removed when `EDIT` was unified onto the modal; its dropdown was clipped by `.queueBody` anyway.)
- [Queue Scheduler](queue-scheduler.md) — chain steps edited via the same autocomplete textarea.
- [Session Creation Modals](session-creation-modals.md) — `NewSessionModal` / `QuickSessionModal` use `getCommandSuggestions` / `saveCommand` for the launch-command combobox.
- [UI Primitives](ui-primitives.md) — `AutocompleteTextarea` lives alongside the shared `components/ui/` primitives.

### Shared Resources
- `cliDetect.detectCli` — shared CLI detection used here and across the app.
- `/api/files/search` — shared with the file browser / `@`-reference features.
- `installed_plugins.json` (`~/.claude/plugins/`) and the on-disk command/skill directories of each CLI.
- `CommandEntry` type is duplicated client + server and must stay in sync.

## Change Risks

- **Endpoint contract** — changing `GET /api/commands` query params or the `{ entries }` shape breaks `fetchCommandIndex`, hence the dropdown in QueueTab / QueueItemEditModal. The `cli` validation (claude|codex|gemini) is mirrored on the client; adding a new CLI requires edits in both files plus a new `*_BUILTINS` catalog and `build*Entries`.
- **`CommandEntry` drift** — the type is defined twice (server + client). Adding/renaming a field in one place without the other silently breaks grouping/display.
- **Built-in catalogs go stale** — `CLAUDE_BUILTINS` / `CODEX_BUILTINS` / `GEMINI_BUILTINS` are hand-maintained snapshots of each CLI's in-binary commands; upstream additions won't appear until these arrays are updated.
- **Sigil-per-CLI must stay in `entryPrefix`** — it is the single place that decides `$` vs `/`. Hardcoding `'/' + name` anywhere in the dropdown (as the component used to) silently reintroduces the bug where a Codex session queues `/skill-name`, which that CLI ignores with no error. Symmetrically, the kind filter in `handleChange` must keep skills out of Codex's `/` menu.
- **`$` must stay Codex-only** — dropping the `cli !== 'codex'` guard makes every `$HOME` / `$1` / `$5.00` in a Claude prompt pop a dropdown.
- **Disk-path assumptions** — relies on exact directory layouts (`.claude/commands`, `.claude/skills/<slug>/SKILL.md`, `.codex/prompts`, `.codex/skills/<slug>/SKILL.md`, `$CODEX_HOME/skills/.system/<slug>/SKILL.md`, `.gemini/commands/*.toml`, `installed_plugins.json` schema). Layout changes by any CLI break enumeration for that source. Codex 0.145 documents `$CODEX_HOME/skills` as *the* discovery root; the `<project>/.codex/skills` walk mirrors the existing `<project>/.codex/prompts` precedent and is a superset — if Codex does not read it, the entry is listed but unresolvable.
- **`Dirent.isDirectory()` vs `statSync`** — `listSkillDirs` must keep using `isDirLike` (statSync, follows symlinks). Reverting to the dirent check silently drops every symlinked skill dir with no error, for Claude as well as Codex.
- **Frontmatter parser** — `parseFrontmatter` is a minimal hand-rolled YAML reader; malformed frontmatter or unsupported YAML constructs yield empty/garbled descriptions but won't crash (wrapped in try/catch returning `''`).
- **Trigger parsing** — `parseTrigger` only fires after start-of-text or whitespace and stops at whitespace; loosening this would cause spurious dropdowns mid-word, tightening it would miss valid triggers. Adding a fourth sigil means adding it to `SIGILS` — the last-sigil-wins scan handles precedence, but a hand-rolled ordered check would not.
- **Dropdown positioning** — `dropdownStyle` reads `getBoundingClientRect()` in a `useMemo`; changing the textarea to a ref-only pattern would violate React 19 render rules (the element is intentionally held as state). `z-index: 10100` must stay above sibling panels/modals or the dropdown clips.
- **localStorage `command-usage-counts`** — clearing or corrupting it only degrades session-creation suggestion ordering (falls back to defaults); it does not affect the `/`-command index.
- **Caches** — both client and server cache 30 s; a newly saved project command won't appear until the TTL expires or `invalidateCommandIndex` / `clearCommandIndexCache` is called.

# Floating Session Spawner

> **Function** Server-side handler that builds a synthesized prompt for a
> selection-popup or "translate" toolbar action, then spawns a new fork-style
> CLI session in the origin's working directory.

## Purpose

Backs the [Floating Terminal Fork](../frontend/floating-terminal-fork.md)
frontend feature. Receives a small JSON payload from the dashboard, resolves
the user's previous answer (when needed), constructs a prompt, and launches the
same CLI kind as the origin session. Every mode forks the parent Claude/Codex
conversation when that parent has a resumable transcript (so the AI inherits
context); otherwise it falls back to a fresh launch with a self-contained prompt.

## Source Files

| File | Role |
|------|------|
| `server/floatingSessionSpawner.ts` | Resolve origin/parent, pick fresh-vs-fork launch, spawn the pty. Exports `spawnFloatingSession` (re-exports `FloatingMode`/`SpawnFloatingArgs` from `floatingPrompt.ts`). |
| `server/floatingPrompt.ts` | Pure, dependency-free prompt synthesis + labels. Exports `buildPrompt`, `floatLabel`, `customFloatLabel`, `MAX_PROMPT_BYTES`, and the `FloatingMode`/`SpawnFloatingArgs` types. Extracted so prompt logic is unit-testable without the db/pty module graph. |
| `server/extractPreviousAnswer.ts` | Read the last assistant message (`readClaudeLastAssistant`, for translate-answer) and the full ordered transcript (`readClaudeTranscript`, backs the [Conversation tab](../frontend/conversation-view.md)) from a Claude `~/.claude/projects/<encoded>/<sessionId>.jsonl` file. |
| `server/apiRouter.ts` | Mounts `POST /api/sessions/spawn-floating` (Zod-validated). |
| `src/lib/cliDetect.ts` | Frontend-side CLI detection that hides translate-answer for non-Claude origins before the request reaches this endpoint. The server's `resolveOriginCli` mirrors its `cliSource → command → model` precedence. |
| `hooks/dashboard-hook-gemini.sh` / `hooks/dashboard-hook-codex.sh` | Emit `cli_source` (`"gemini"` / `"codex"`) so the origin session carries an authoritative CLI family for `resolveOriginCli` to read. |

## API

`POST /api/sessions/spawn-floating`

Request body (Zod-validated):

```ts
{
  originSessionId: string,            // required (1–200 chars) — root/origin session
  spawnTerminalId?: string,           // optional (≤ 200) — host terminal the selection
                                      //   came from; resolves the recursive fork parent
  mode: 'explain-learning' | 'explain-native' | 'vocab-native' |
        'translate-selection-learning' | 'translate-selection-native' |
        'translate-answer' | 'translate-file' | 'custom',
  selection?: string,                 // required for explain-*/vocab/translate-selection/custom (≤ 64 KB)
  contextLine?: string,               // optional surrounding line (≤ 2 KB)
  fileContent?: string,               // required for translate-file (≤ 256 KB)
  filePath?: string,                  // optional, for prompt context (≤ 2048)
  customPrompt?: string,              // required for `custom` mode (≤ 64 KB)
  nativeLanguage: string,             // required (1–64) e.g. "简体中文"
  learningLanguage: string,           // required (1–64) e.g. "English"
  inheritContext?: boolean,           // opt out of forking; defaults true client-side
}
```

Response:

```ts
// success — spreads SpawnFloatingResult { terminalId, label }
{ ok: true, terminalId: 'term-…', label: 'Explain (中文)' }

// error
{ error: '<message>' }   // 400 status
```

Note: `label` is the bare mode label (e.g. `Translate → English`); the origin
title is appended only into the spawned session's `sessionTitle`, not the
response `label`.

## Spawn Pipeline

```
spawnFloatingSession(args)
  ├─ getSession(originSessionId)                           [throws on miss]
  ├─ if mode = translate-answer:
  │     readClaudeLastAssistant(sessionId, projectPath, transcriptPath)
  │     [throws if non-Claude origin, no projectPath, or no transcript]
  ├─ buildPrompt(args, prevAnswer)        [throws if required input missing]
  ├─ enforce ≤ MAX_PROMPT_BYTES (256 KB)
  ├─ resolveOriginCli(origin)                         [claude | codex | gemini]
  │     cliSource (authoritative) → command → model → 'claude'
  ├─ resolve fork parent:
  │     spawnParent = spawnTerminalId ? getSessionByTerminalId(...) : null
  │     forkParentSession = spawnParent ?? origin
  │     forkParentId      = spawnParent ? spawnParent.sessionId : originSessionId
  ├─ shouldInheritContext =
  │       inheritContext !== false
  │       && cli ∈ {claude, codex}
  │       && forkParentSession.promptHistory.length > 0
  ├─ baseLaunchCmd = shouldInheritContext
  │                    ? buildForkCommand(cli, forkParentId, prompt)
  │                    : buildLaunchCommand(cli, prompt)            [shell-escaped]
  ├─ permsCmd  = claude ? reconstructPermissionFlags(base, origin.permissionMode)
  │                     : base
  ├─ launchCmd = applyClaudeLaunchFlags(permsCmd, origin.model, origin.effortLevel)
  │     [model is run through sanitizeModelId — strips ANSI/[1m] junk, drops the
  │      flag if no safe token remains, so a contaminated origin can't break the
  │      unquoted --model flag]
  ├─ build TerminalConfig (SSH passthrough or localhost), inheriting
  │     { model: sanitizeModelId(origin.model), effortLevel, characterModel }
  ├─ createTerminal(config)
  ├─ consumePendingLink(workingDir)
  ├─ createTerminalSession(terminalId, { command: launchCmd, sessionTitle,
  │       isFork: true, isFloating: true, originSessionId })
  ├─ writeWhenReady(terminalId, prefix + launchCmd + '\r')
  └─ if claude && origin.effortLevel === 'ultracode':
        injectClaudeCommandsWhenReady(terminalId, ['/effort ultracode'])
```

`spawnParent` enables **recursive forks**: a popup opened from inside a floating
terminal forks from that terminal's session (resolved via `spawnTerminalId` →
`getSessionByTerminalId`), so context chains down (root → A → B → …). Selections
with no host terminal (e.g. the project-tab markdown viewer) fork from
`originSessionId`. `originSessionId` always stays the root for client-side float
scoping.

## Prompt Templates

```
explain-learning:
  Explain the following in {learningLanguage}. Cover meaning, nuance,
  related concepts, and short examples. Be concise.
  Surrounding line: "{contextLine}"
  Selected text:
  """
  {selection}
  """

explain-native:
  Explain the following in {nativeLanguage}. Use {nativeLanguage} for the
  explanation. Cover meaning, nuance, and any technical concepts. Be concise.
  Surrounding line: "{contextLine}"
  Selected text:
  """
  {selection}
  """

translate-answer:
  Translate the following text into {nativeLanguage}. Preserve markdown,
  code blocks, lists, and structure. Output translation only, no commentary.
  """
  {prevAnswer}
  """

translate-selection-learning / translate-selection-native:
  Translate the following text into {learningLanguage|nativeLanguage}.
  Output ONLY the translation — no explanations, no notes, no surrounding quotes.
  Preserve original formatting (line breaks, code, lists, markdown).
  """
  {selection}
  """

translate-file:
  Translate the following markdown file into {nativeLanguage}. Preserve
  markdown syntax exactly (headings, code blocks, lists, links, images, tables).
  Output translation only.
  File: {filePath}
  """
  {fileContent}
  """

vocab-native:
  Act as a bilingual dictionary. Explain the following word or phrase as a
  vocabulary entry, written in {nativeLanguage}.
  Include: part of speech; pronunciation (IPA) for a single word; a clear
  definition in {nativeLanguage}; 2–3 example sentences in {learningLanguage},
  each followed by its {nativeLanguage} translation; common synonyms or related
  words; and what it means specifically as used in the surrounding line. Be
  concise and well structured.
  Surrounding line: "{contextLine}"
  Word or phrase:
  """
  {selection}
  """

custom:
  {customPrompt}
  Surrounding line: "{contextLine}"   # only when contextLine present
  Selected text:
  """
  {selection}
  """
```

`explain-*` prompts also prepend an optional `Source file: {filePath}` hint when
`filePath` is supplied.

## CLI Detection & Launch

The popup spawns the **same CLI as its parent**. `resolveOriginCli(origin)`
(exported for unit tests) resolves the CLI family with the same precedence as the
canonical frontend detector `src/lib/cliDetect.ts`, so backend and frontend agree:

```ts
resolveOriginCli(origin) →
  1. origin.cliSource              // AUTHORITATIVE — set from the hook's cli_source
                                   //   (codex & gemini hooks emit it) or inferCliSource()
  2. detectCliFromCommand(startupCommand || sshCommand || sshConfig.command)
                                   // regex tolerates a leading path, e.g. /usr/bin/codex
  3. detectCliFromModel(origin.model)   // gpt/codex/o1/o3/o4 → codex; gemini/gemma → gemini;
                                        //   claude/opus/sonnet/haiku → claude
  4. 'claude'                      // historical default when nothing matches

buildLaunchCommand(cli, prompt) →
  'gemini'           → `gemini -p '<escapedPrompt>'`
  'claude' / 'codex' → `<cli> '<escapedPrompt>'`
```

**Why precedence matters (the gpt-5.5 bug):** the previous detector only sniffed
the command string and ignored `cliSource`. Because `sshCommand` defaults to
`'claude'` (`sessionStore.ts`), a Codex/Gemini parent was misdetected as Claude —
so the popup launched `claude` *and*, believing it was Claude, ran
`applyClaudeLaunchFlags` which injected the parent's inherited Codex model as a
Claude flag (`claude --model gpt-5.5 '…'`). Leading with `cliSource` fixes both:
the popup now launches `codex`/`gemini`, and the claude-only flag helpers no-op on
non-Claude commands so a Codex model never leaks onto a Claude launch.

Single-quote escaping (`shellEscapeSingle`) uses the standard pattern:
`'` → `'"'"'`.

### Fork-mode (Claude/Codex)

When `shouldInheritContext` holds (see Spawn Pipeline) and the origin is a Claude
or Codex session, the spawner replaces the fresh-launch command with a
`buildForkCommand(cli, forkParentId, prompt)` fork that rehydrates the prior
conversation, so the AI can ground its answer in the user's existing context:

```
claude --resume '<forkParentId>' --fork-session '<escapedPrompt>'
codex fork '<forkParentId>' '<escapedPrompt>'
```

If `forkParentId` looks like a dashboard-internal placeholder
(`term-…` prefix or fails the `^[a-zA-Z0-9_\-]+$` regex), the spawner falls back
to:

```
claude --continue --fork-session '<escapedPrompt>'
codex fork --last '<escapedPrompt>'
```

`--continue` / `codex fork --last` use the most recent session in the cwd when
the dashboard only has an internal `term-*` id. Claude's `--fork-session` and
Codex's `fork` subcommand ensure the original transcript is not mutated by the
user's follow-ups.

`reconstructPermissionFlags(cmd, origin.permissionMode)` is applied to Claude
commands so the forked session inherits the same permission posture (e.g.
`--dangerously-skip-permissions`). Codex fork commands are left as Codex-native
commands.

The popup also **inherits the origin session's `model` and `effortLevel`**: they
are forwarded into the new `TerminalConfig` and applied to the launch command via
`applyClaudeLaunchFlags` (`--model`/`--effort` flags), so they take effect before
the popup's first prompt runs. The inherited model is first run through
`sanitizeModelId` (`config.ts`) — both for the persisted `TerminalConfig.model`
and inside `applyClaudeLaunchFlags`. This guards a long-standing bug: an older
session could store a model polluted with a stripped ANSI bold escape (e.g.
`claude-opus-4-8[1m]`), and because `--model <model>` is interpolated **unquoted**,
zsh treated `[1m]` as a glob (`no matches found: claude-opus-4-8[1m]`) and the
popup failed to launch. The sanitizer strips the junk (recovering
`claude-opus-4-8`) or drops the flag if nothing safe remains, and a one-time
`db.ts` migration cleans already-stored contaminated models on startup. `ultracode` launches as `--effort xhigh` (its valid
base level — the raw `ultracode` value is rejected by the flag) and is then
upgraded to true ultracode via a `/effort ultracode` slash command once Claude
Code is ready (`injectClaudeCommandsWhenReady` in `sshManager.ts`). `characterModel` is forwarded too so the popup's
robot icon matches the parent.

**Per-mode policy**: **all** popup modes fork the origin Claude/Codex session to
inherit its conversation context, gated by the `inheritContext` Settings toggle
(`translationInheritContext`, default on) **and by the parent having a resumable
conversation**. A brand-new session with no prompts yet has no transcript, so
`claude --resume <id> --fork-session` would fail with "No conversation found" —
the spawner detects this (`forkParentSession.promptHistory.length > 0`) and falls
back to a fresh launch (the popup prompt is self-contained). Gemini origins always
use the fresh-launch path (no fork support); Codex uses `codex fork`.

| Mode | Fork? | Notes |
|------|-------|-------|
| `explain-learning` / `explain-native` | yes | Inherited history grounds the explanation. |
| `vocab-native` | yes | Surrounding conversation sharpens word/phrase sense. |
| `translate-selection-learning` / `translate-selection-native` | yes | Surrounding conversation improves terminology. |
| `translate-answer` | yes | Prompt still carries the prior answer; the fork adds conversation context. |
| `translate-file` | yes | Whole-file translation; the fork supplies project/terminology context. |
| `custom` | yes (Claude/Codex) | Forks when the parent supports it; Gemini custom stays fresh. |

> The runtime decision (`shouldInheritContext`) is uniform across modes — it does
> not special-case `vocab-native`/`custom`, even though their type comments in
> `floatingPrompt.ts` describe them as "self-contained, never inherits context".
> The fork still produces a correct answer because each prompt is fully
> self-contained regardless.

## Transcript Reading (translate-answer)

`server/extractPreviousAnswer.ts` exposes two readers; both resolve the JSONL
transcript in this order:

1. The explicit `transcriptPath` from the Session, when set and existing. This
   check lives in each reader (`readClaudeLastAssistant` / `readClaudeTranscript`),
   *before* it calls `findTranscriptFile` — which itself takes no `transcriptPath`
   parameter and only does steps 2-3.
2. `<sessionId>.jsonl` in the encoded project dir. `projectDirCandidates`
   tries three encodings: leading-dash + slashes→dashes, no leading dash, and
   dashes for both slashes and dots.
3. Fallback: newest `.jsonl` in that directory.

`readClaudeLastAssistant(sessionId, projectPath, transcriptPath?)` reverse-scans
the file and returns the first assistant message it finds — used here for
`translate-answer`. Multiple message-shape variants are accepted (legacy
`content` strings, new content-block arrays via `extractText`/`blocksToText`).

`readClaudeTranscript(...)` parses the whole file into an ordered
`ConversationEntry[]` (user / assistant / tool_use / tool_result / event),
capping tool input at `TOOL_INPUT_CAP = 2 KB`, tool result at
`TOOL_RESULT_CAP = 4 KB`, and the entry list at `MAX_ENTRIES = 2000` (most
recent, file order preserved). This backs the
[Conversation tab](../frontend/conversation-view.md), not the spawner itself.

Codex and Gemini transcripts are not yet supported. The frontend hides the
translate-answer button for non-Claude origins; direct endpoint calls still
return a 400 with a user-readable error.

## Cross-Feature Dependencies

| Connected feature | Why |
|-------------------|-----|
| [Floating Terminal Fork](../frontend/floating-terminal-fork.md) | Frontend client that builds the payload and renders the spawned float; this module is its server backend. |
| [Session management](./session-management.md) | Reads `Session` via `getSession`/`getSessionByTerminalId`; inherits `model`/`effortLevel`/`characterModel`/`permissionMode`; calls `createTerminalSession` to register the spawn (`isFork: true` for the kill-guard + `isFloating: true` to hide it from the session lists). |
| [Session matching](./session-matching.md) | Inserts a pending-link entry (`consumePendingLink`) via the same path as fork/clone. |
| [Terminal/SSH](./terminal-ssh.md) | `createTerminal`, `writeWhenReady`, `injectClaudeCommandsWhenReady`, and pendingLink wiring all live in `sshManager.ts`. |
| [API endpoints](./api-endpoints.md) | Route `POST /api/sessions/spawn-floating`. |
| [Settings system](../frontend/settings-system.md) | `translationInheritContext` toggle gates whether the spawner forks the parent. |
| [Conversation view](../frontend/conversation-view.md) | Reuses `readClaudeTranscript` from `extractPreviousAnswer.ts` (folded into this doc's source set). |
| [Hook system](./hook-system.md) | The spawned session emits the standard SessionStart hook so it appears in the dashboard. |

## Change Risks

* **Argv length cap (256 KB).** Big translate-file requests will fail with a
  user-readable error. To support larger payloads, switch to bracketed-paste
  injection after the CLI banner is detected.
* **Shell-quote escaping.** Only single-quotes are escaped; the prompt is
  wrapped in single-quotes. Anything that breaks single-quote semantics (e.g.
  ANSI escape sequences from terminal scrollback) will land in the CLI prompt
  literally — generally fine but worth knowing.
* **Transcript path encoding** can drift between Claude versions. The
  resolver tries three encoded variants plus a "newest jsonl" fallback;
  unknown encodings will fall back to the newest transcript in the dir.
* **cwd resolution.** SSH origins reuse `sshConfig.workingDir`; local origins use
  `origin.projectPath`. Either falls back to `~` when empty.
* **Effort/model inheritance.** `model` and `effortLevel` apply as `--model` /
  `--effort` launch flags. `ultracode` launches as `--effort xhigh` (its valid
  base level) and is upgraded to true ultracode via `/effort ultracode` once
  Claude Code is ready.
* **CLI misdetection leaks the parent's model.** `applyClaudeLaunchFlags` only
  rewrites commands that start with `claude`, so correct CLI detection is what
  prevents a Codex/Gemini model (e.g. `gpt-5.5`) from being injected as a Claude
  `--model` flag. `resolveOriginCli` leads with `cliSource`; if that field is ever
  unset for a non-Claude session (e.g. a Gemini hook that predates the
  `cli_source` addition and whose `startup_command` wasn't captured), detection
  falls through to the command/model sniff. Reinstall hooks (`npm run install-hooks`)
  so Gemini sessions carry `cli_source`.
* **Recursive forks** depend on `spawnTerminalId` resolving to a live session. If
  the host terminal's session is gone, the spawner falls back to forking the
  root `originSessionId`.

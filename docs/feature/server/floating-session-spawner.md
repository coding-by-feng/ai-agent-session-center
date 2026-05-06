# Floating Session Spawner

> **Function** Server-side handler that builds a synthesized prompt for a
> selection-popup or "translate" toolbar action, then spawns a new fork-style
> CLI session in the origin's working directory.

## Purpose

Backs the [Floating Terminal Fork](../frontend/floating-terminal-fork.md)
frontend feature. Receives a small JSON payload from the dashboard, resolves
the user's previous answer (when needed), constructs a prompt, and launches a
fresh `claude` / `codex` / `gemini` process — pre-loaded with that prompt as
a positional argument.

## Source Files

| File | Role |
|------|------|
| `server/floatingSessionSpawner.ts` | Build prompt + spawn pty. Single exported function `spawnFloatingSession`. |
| `server/extractPreviousAnswer.ts` | Read the last assistant message from a Claude `~/.claude/projects/<encoded>/<sessionId>.jsonl` transcript. |
| `server/apiRouter.ts` | Mounts `POST /api/sessions/spawn-floating` (Zod-validated). |

## API

`POST /api/sessions/spawn-floating`

Request body (Zod-validated):

```ts
{
  originSessionId: string,            // required
  mode: 'explain-learning' | 'explain-native' | 'translate-answer' | 'translate-file',
  selection?: string,                 // required for explain-* (≤ 64 KB)
  contextLine?: string,               // optional surrounding line (≤ 2 KB)
  fileContent?: string,               // required for translate-file (≤ 256 KB)
  filePath?: string,                  // optional, for prompt context
  nativeLanguage: string,             // e.g. "简体中文"
  learningLanguage: string,           // e.g. "English"
}
```

Response:

```ts
// success
{ ok: true, terminalId: 'term-…', label: 'Explain (中文) · …' }

// error
{ error: '<message>' }   // 400 status
```

## Spawn Pipeline

```
spawnFloatingSession(args)
  ├─ getSession(originSessionId)                           [throws 400 on miss]
  ├─ if mode = translate-answer:
  │     readClaudeLastAssistant(sessionId, projectPath, transcriptPath)
  │     [throws 400 if no transcript or non-Claude origin]
  ├─ buildPrompt(args, prevAnswer)                          [throws 400 if missing inputs]
  ├─ enforce ≤ 256 KB
  ├─ detectCli(origin.startupCommand)                       [claude | codex | gemini]
  ├─ buildLaunchCommand(cli, prompt) → shell-escaped
  ├─ createTerminal({ workingDir = origin.projectPath, command: '' })
  ├─ consumePendingLink(workingDir)
  ├─ createTerminalSession(terminalId, { command, sessionTitle })
  └─ writeWhenReady(terminalId, prefix + launchCmd + '\r')
```

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

translate-file:
  Translate the following markdown file into {nativeLanguage}. Preserve
  markdown syntax exactly (headings, code blocks, lists, links, images, tables).
  Output translation only.
  File: {filePath}
  """
  {fileContent}
  """
```

## CLI Detection & Launch

```ts
detectCli(startupCommand) →
  startupCommand starts with 'codex'   → 'codex'
  startupCommand starts with 'gemini'  → 'gemini'
  otherwise                            → 'claude'

buildLaunchCommand(cli, prompt) →
  'gemini'           → `gemini -p '<escapedPrompt>'`
  'claude' / 'codex' → `<cli> '<escapedPrompt>'`
```

Single-quote escaping uses the standard pattern: `'` → `'"'"'`.

### Fork-mode (Claude only, explain-* modes)

When `inheritContext` is true (the default) and the origin is a Claude
session, the spawner replaces the fresh-launch command with a fork that
rehydrates the prior conversation, so the AI can ground its explanation in
the user's existing context:

```
claude --resume '<originSessionId>' --fork-session '<escapedPrompt>'
```

If `originSessionId` looks like a dashboard-internal placeholder
(`term-…` or fails the `^[a-zA-Z0-9_\-]+$` regex), the spawner falls back
to:

```
claude --continue --fork-session '<escapedPrompt>'
```

`--continue` resumes the most-recent session in the cwd; `--fork-session`
ensures the original transcript isn't mutated by the user's follow-ups.

`reconstructPermissionFlags(cmd, origin.permissionMode)` is then applied so
the forked session inherits the same permission posture (e.g.
`--dangerously-skip-permissions`).

**Per-mode policy**:

| Mode | Fork? | Why |
|------|-------|-----|
| `explain-learning` / `explain-native` | yes | Selection often depends on the conversation; inherited history grounds the explanation. |
| `translate-answer` | no | Source text is already in the prompt; forking would prime continuation instead of translation. |
| `translate-file` | no | File is unrelated to the conversation; forking adds noise. |

Codex and Gemini origins always use the fresh-launch path — those CLIs
don't expose a comparable fork primitive.

## Previous-Answer Resolution (translate-answer)

`server/extractPreviousAnswer.ts` resolves the JSONL transcript in this order:

1. Use the explicit `transcriptPath` from the Session if it exists.
2. `~/.claude/projects/-<dashed-projectPath>/<sessionId>.jsonl`
3. Fallback: newest `.jsonl` in that directory.

It then reverse-scans the file and returns the first assistant message it
finds. Multiple message-shape variants are accepted (legacy `content` strings,
new content-block arrays).

Codex and Gemini transcripts are not yet supported — the endpoint returns a
400 with a user-readable error.

## Cross-Feature Dependencies

| Connected feature | Why |
|-------------------|-----|
| [Session management](./session-management.md) | Reads `Session` object via `getSession`; calls `createTerminalSession` to register the spawn. |
| [Session matching](./session-matching.md) | Inserts a pending-link entry via the same path as fork/clone. |
| [Terminal/SSH](./terminal-ssh.md) | Pty creation, `writeWhenReady`, and pendingLink wiring all live in `sshManager.ts`. |
| [API endpoints](./api-endpoints.md) | New route `POST /api/sessions/spawn-floating`. |
| [Hook system](./hook-system.md) | New session emits the standard SessionStart hook so it appears in the dashboard. |

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
* **`origin.projectPath`** is the only `cwd` source. If a session has no
  project path the spawner falls back to `~`.

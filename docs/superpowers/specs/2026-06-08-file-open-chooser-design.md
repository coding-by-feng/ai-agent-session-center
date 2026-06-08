# File-Open Chooser — Design Spec

**Date:** 2026-06-08
**Status:** Approved (pending spec review)
**Author:** Brainstorm session

## Problem

When the assistant lists file paths (e.g. PDFs) in its output, or when paths appear
in raw terminal output, clicking a path silently opens it in the in-app viewer
(`ProjectTab`). The user wants an explicit chooser on click so they can decide
**per click** whether to open the file in the app, hand it to the OS default
application, or reveal it in the OS file manager.

## Goals

- Clicking a file-path link shows a small chooser with three actions:
  1. **Open in app** — current in-app viewer behavior (unchanged path).
  2. **Open with default app** — OS default application (PDF → Preview, etc.).
  3. **Reveal in Finder/Explorer** — highlight the file in the OS file manager.
- Works in **both** surfaces:
  - Conversation / assistant rendered output (`LinkifiedText`).
  - Raw xterm terminal output (existing file-path link provider).
- Chooser is an **anchored popover at the cursor** (context-menu style), dismissed
  by clicking outside or pressing Esc. Shown on **every** click (no remembered
  preference in this iteration).

## Non-Goals (YAGNI)

- No "remember my choice" / default-action preference (explicitly deferred).
- No live terminal `cwd` tracking — relative paths resolve against the session's
  `projectPath`, same as today's click handler.
- No support for absolute paths outside the project root (server path scoping
  already rejects these; matches current in-app behavior).
- No change to URL link handling in the terminal (https links keep opening in a
  browser tab / `shell.openExternal`).

## Current State (verified in code)

Both click surfaces already funnel through one store action, which is what makes
this change small:

- `src/components/session/LinkifiedText.tsx:53-63` — `onClick` / `onKeyDown` call
  `useUiStore.getState().openFileInProject(clean, projectPath || '')`.
- `src/hooks/useTerminal.ts:582-618` — a custom xterm `registerLinkProvider`
  matches file paths with the same regex; its `activate()` (lines 609-613) calls
  `useUiStore.getState().openFileInProject(clean, pp || '')`.
- `src/stores/uiStore.ts:88-89` — `openFileInProject` sets `pendingFileOpen`;
  `clearPendingFileOpen` clears it.
- `DetailPanel.tsx` (~449) and `ProjectTabContainer.tsx` (~59) consume
  `pendingFileOpen` to switch to the Project tab and load the file.
- `server/apiRouter.ts:2304-2336` — `POST /api/files/reveal` already implements
  OS reveal via `execFile` (macOS `open -R`, Windows `explorer /select,`,
  Linux `xdg-open` on the dir), guarded by `isAllowedProjectRoot` +
  `resolveProjectPath` (lines 1763-1786).
- `src/lib/fileSystemProvider.ts` — `reveal(root, relPath)` is an HTTP POST to
  `/api/files/reveal`; defined on the `FileSystemProvider` interface (line 71)
  and implemented by the API + Local providers.
- The internal viewer already renders PDFs (native `<iframe>` + blob URL from
  `/api/files/stream`), images, video, audio, Excel, code, markdown, LaTeX — so
  "Open in app" already works for the file types in scope.

Net: the only genuinely new capability is "Open with default app" (a server
endpoint) and the chooser UI; everything else is re-wiring existing calls.

## Design

### 1. `uiStore.ts` — new transient chooser state

Mirror the `pendingFileOpen` pattern exactly:

```ts
interface PendingFileChooser {
  filePath: string;
  projectPath: string;
  anchor: { x: number; y: number }; // viewport coords for the popover
}

// state
pendingFileChooser: PendingFileChooser | null;

// actions
openFileChooser: (filePath, projectPath, anchor) =>
  set({ pendingFileChooser: { filePath, projectPath, anchor } }),
clearFileChooser: () => set({ pendingFileChooser: null }),
```

`openFileInProject` / `clearPendingFileOpen` stay as-is — the chooser's
"Open in app" action reuses them.

### 2. Two call-site swaps (the chokepoints)

**`LinkifiedText.tsx`** — replace the two `openFileInProject` calls. `onClick`
passes the DOM event's `{ x: e.clientX, y: e.clientY }`. For keyboard `Enter`,
anchor to the target element's `getBoundingClientRect()` (bottom-left) since there
is no cursor. Update the `title` tooltip to "Click to choose how to open".

**`useTerminal.ts`** — widen the link object's `activate` type from
`() => void` to `(event: MouseEvent) => void` (xterm invokes
`ILink.activate(event, text)`), capture `event.clientX/clientY`, and call
`openFileChooser(clean, pp || '', { x, y })`. Update the link `tooltip`.

### 3. `FileOpenChooser.tsx` (new) + CSS module

- Rendered **once** at the DetailPanel root (always mounted; cheap when idle).
- Subscribes to `pendingFileChooser`. Returns `null` when it's `null`.
- Renders a `position: fixed` popover at `anchor`, clamped to the viewport
  (reuse the clamp approach used by `SelectionPopup`). Portaled to `document.body`
  to avoid clipping by transformed ancestors (same reason `ProjectTab` fullscreen
  is portaled).
- Buttons: **Open in app**, **Open with default app**, **Reveal in Finder**
  (label adapts to platform: "Reveal in Explorer" on Windows), divider, **Cancel**.
- Dismissal: `useClickOutside` + Esc keydown both call `clearFileChooser()`.
- Actions (each calls `clearFileChooser()` after dispatch):
  - Open in app → `openFileInProject(filePath, projectPath)` (existing flow).
  - Open with default app → `provider.openExternal(projectPath, filePath)`.
  - Reveal → `provider.reveal(projectPath, filePath)`.
- Accessibility: `role="menu"`, focusable items, Enter/Space activate, Esc closes.
  Focus the first item on open.
- Styling: new `src/styles/modules/FileOpenChooser.module.css` following the dark
  navy + neon accent theme; visual language consistent with existing small menus.

Provider access: `reveal`/`openExternal` are plain HTTP POSTs that must run on the
server host, so the chooser obtains a provider instance the same way other
components do (confirm the exact accessor — `getFileSystemProvider()` / context —
during planning) rather than threading one through props.

### 4. `POST /api/files/open-external` (new server endpoint)

Near-exact copy of the `reveal` handler, same validation, no reveal flag:

```ts
// after the reveal handler in apiRouter.ts
router.post('/files/open-external', (req, res) => {
  const root = str(req.body?.root);
  if (!root) return res.status(400).json({ error: 'root required' });
  if (!isAllowedProjectRoot(root)) return res.status(400).json({ error: 'Invalid project root' });

  const body = filePathSchema.safeParse({ path: req.body?.path || '/' });
  if (!body.success) return res.status(400).json({ error: 'Invalid path' });

  const fullPath = resolveProjectPath(root, body.data.path);
  if (!fullPath) return res.status(400).json({ error: 'Path outside project root' });
  if (!existsSync(fullPath)) return res.status(404).json({ error: 'Path not found' });

  const platform = process.platform;
  let cmd: string; let args: string[];
  if (platform === 'darwin')      { cmd = 'open';     args = [fullPath]; }
  else if (platform === 'win32')  { cmd = 'cmd';      args = ['/c', 'start', '', fullPath]; }
  else                            { cmd = 'xdg-open'; args = [fullPath]; }

  execFile(cmd, args, (err) => { if (err) log.error('files-open-external', err.message); });
  res.json({ ok: true });
});
```

Security notes:
- Reuses `isAllowedProjectRoot` + `resolveProjectPath` — no traversal, no shallow
  roots, path must exist and be within the project root.
- `execFile` (not `exec`) — args passed as an array, no shell interpolation, so the
  path cannot inject commands.
- Windows: `start` is a `cmd` builtin; invoked as `cmd /c start "" <path>` with the
  empty string as the (ignored) window-title argument.

### 5. `fileSystemProvider.ts` — `openExternal`

Add to the `FileSystemProvider` interface and both implementations, mirroring
`reveal`:

```ts
openExternal(projectRoot: string, relPath: string): Promise<void>;

// ApiFileSystemProvider (and LocalFileSystemProvider delegates the same way —
// OS-open must happen server-side)
async openExternal(projectRoot, relPath) {
  await fetch('/api/files/open-external', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: projectRoot, path: relPath }),
  }).catch(() => {});
}
```

## Data Flow

```
click path (conversation link OR terminal link)
  → openFileChooser(filePath, projectPath, anchor)   [uiStore]
  → <FileOpenChooser> renders popover at anchor
      ├─ Open in app        → openFileInProject(...) → pendingFileOpen → ProjectTab loads file
      ├─ Open w/ default app→ provider.openExternal → POST /api/files/open-external → execFile(open)
      └─ Reveal in Finder   → provider.reveal       → POST /api/files/reveal       → execFile(open -R)
  → clearFileChooser()
```

## Error Handling

- Endpoint: validation failures return 400/404 with a short message; `execFile`
  errors are logged server-side (the OS open is best-effort — a missing default
  app shouldn't crash anything).
- Client: provider calls `.catch(() => {})` (same as `reveal`), optionally surfacing
  a toast on rejection via the existing `showToast` used by `handleRevealInFinder`.
- Browser mode: external/reveal act on the **server host** machine. Documented as
  expected for single-user localhost.

## Testing

- **Unit (`uiStore`)**: `openFileChooser` sets state with anchor; `clearFileChooser`
  nulls it; `openFileInProject` untouched.
- **Unit (endpoint)**: mock `execFile`/`existsSync`; assert 400 on bad root,
  400 on traversal (`../`), 404 on missing file, and correct `cmd`/`args` per
  `process.platform` (darwin/win32/linux).
- **Component (`FileOpenChooser`)**: renders 3 actions + cancel; each button calls
  the right target and then `clearFileChooser`; Esc and outside-click dismiss;
  popover clamps within viewport.

## Files Touched

| File | Change |
|------|--------|
| `src/stores/uiStore.ts` | add `pendingFileChooser` state + `openFileChooser`/`clearFileChooser` |
| `src/components/session/LinkifiedText.tsx` | swap `openFileInProject` → `openFileChooser` (click + Enter), update tooltip |
| `src/hooks/useTerminal.ts` | widen link `activate` to receive `MouseEvent`; swap to `openFileChooser`; update tooltip |
| `src/components/session/FileOpenChooser.tsx` | **new** anchored popover component |
| `src/styles/modules/FileOpenChooser.module.css` | **new** styles |
| `src/components/session/DetailPanel.tsx` | mount `<FileOpenChooser />` once |
| `src/lib/fileSystemProvider.ts` | add `openExternal` to interface + providers |
| `server/apiRouter.ts` | add `POST /api/files/open-external` |
| `docs/feature/...` | update session-detail-panel.md / terminal-ui.md / api-endpoints.md |

## Open Questions

None blocking. Confirm the exact provider accessor used by globally-mounted
components during implementation planning.

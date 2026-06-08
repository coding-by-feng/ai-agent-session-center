# Terminal UI (xterm.js)

## Function
Full terminal emulation using xterm.js 5 with dual transport (IPC for Electron, WebSocket for browser), bookmarks, fork/clone, select-to-translate, hold-to-speak TTS, and scroll preservation.

## Purpose
Interactive PTY terminal within the dashboard. Users can type commands, view output, and interact with AI CLI sessions directly.

## Source Files
| File | Role |
|------|------|
| `src/hooks/useTerminal.ts` (~53KB, largest hook) | xterm lifecycle, dual transport, attach/detach, output buffering, link providers, scroll preservation, `readRecentText` |
| `src/components/terminal/TerminalContainer.tsx` | Composes toolbar + xterm + bookmarks + fullscreen overlay; hosts `SelectionPopup`, owns hold-to-speak TTS state, gates translate-answer to Claude origins, and accepts `onFork?` / `onClone?` |
| `src/components/terminal/TerminalToolbar.tsx` | Theme `Select` + icon buttons (ESC, paste, arrows ↑↓, Enter, auto-scroll, scroll-to-bottom, refresh, bookmark, clone, fork, translate-previous-answer, hold-to-speak mic, fullscreen, reconnect). All buttons use the shared `Tooltip` wrapper |
| `src/components/terminal/themes.ts` | 7 named themes + `auto` theme built from CSS variables (`buildAutoTheme`) |
| `src/components/translate/SelectionPopup.tsx`, `src/hooks/useSelectionPopup.ts`, `src/lib/selectionExtractors.ts` | Select-to-translate/explain popup wired into TerminalContainer (the xterm extractor) |
| `src/stores/floatingSessionsStore.ts`, `src/lib/translationLog.ts` | Floating-session orchestration + Dexie translation log used by translate-answer and select-to-translate |
| `src/lib/cliDetect.ts` | CLI detection used to hide translate-answer for non-Claude origins |

## Implementation
- xterm config: JetBrains Mono (fallbacks Cascadia/Fira/Menlo), responsive font (11px ≤480, 12px ≤640, else 14px), lineHeight 1.15, bar cursor non-blinking, `scrollback: 100_000` (xterm allocates lazily, so memory tracks actual output), 200ms ResizeObserver debounce, `allowProposedApi: true`
- Addons: `FitAddon`, `Unicode11Addon` (`unicode.activeVersion = '11'`). **No WebLinksAddon** — link detection is done by two custom `registerLinkProvider` callbacks:
  - **URL link provider**: matches `https?://…`, concatenates wrapped-line groups (up to `MAX_URL_GROUP_LEN = 4096`) so long URLs stay clickable, strips trailing punctuation, validates via `new URL()`, opens via `window.open(url, '_blank')` (Electron routes through `setWindowOpenHandler` → `shell.openExternal`)
  - **File-path link provider**: regex `FILE_PATH_RE` → `useUiStore.getState().openFileInProject(clean, projectPath)`
- Input sanitation: `stripTerminalResponses()` (regex `TERMINAL_RESPONSE_RE`) drops terminal-response escape sequences (Focus In/Out `\x1b[I`/`\x1b[O`, Primary/Secondary Device Attributes replies) from `onData`/`onBinary` before they reach the PTY
- Dual transport: `isPtyHostTerminal(terminalId)` returns true when `terminalId` starts with `pty-` and `window.electronAPI?.writePty` exists. IPC: `writePty`/`resizePty`/`subscribePty`/`unsubscribePty`/`onPtyData`/`onPtyExit`. WebSocket: `terminal_input`/`terminal_resize`/`terminal_subscribe`/`terminal_disconnect` out; `terminal_output`/`terminal_ready`/`terminal_closed` in
- Subscription tracking: `subscribedTerminalIdRef` prevents double-subscribe (#74); on WS reconnect or attach of a new terminal, the previous terminal is `terminal_disconnect`'d before the new `terminal_subscribe`. PTY-host terminals subscribe via `subscribePty()` (which returns a replay `buffer`) and never use WS for subscription
- Attach lifecycle: skip re-attach to same terminal; save outgoing terminal's scroll offset + per-terminal auto-scroll state; clear stale pending output; subscribe via transport; `setupWhenReady` (60 retries × 50ms RAF+timeout, then IntersectionObserver fallback for always-mounted hidden tabs like COMMANDS); create xterm; load addons; register link providers; `attachCustomKeyEventHandler`; `onData`/`onBinary`; ResizeObserver; visibility IntersectionObserver; `forceCanvasRepaint` (also sets `layoutReady`); flush buffered output (double-RAF) merging up to 500 chunks via `mergeChunks`; safety-net repaint at 150ms
- Detach lifecycle: save scroll offset to `term-scroll:<terminalId>` in localStorage; clear the active terminal's batched output buffer; for PTY-host terminals call `electronAPI.unsubscribePty(terminalId)` so the Electron main process stops streaming `pty:data` for this session (WS terminals send `terminal_disconnect` on the next attach instead); disconnect ResizeObserver + visibility observer; dispose xterm; remove `terminal-focused` body class
- Output buffering: inactive terminals queue up to 500 base64 chunks per terminal (`pendingOutputRef`), stale buffers evicted after 60s (`pendingOutputTtlRef`), flushed + merged into one `term.write()` on attach. Active terminal writes are batched per `requestAnimationFrame` (`outputRafRef`) and also merged via `mergeChunks` to avoid N parser runs / N repaints / N GC allocations
- Scroll preservation: saved as "lines above bottom". On attach the offset is read from `savedScrollRef` (in-memory) with a `term-scroll:<id>` localStorage fallback, stored as `pendingScrollRestore` on `ActiveTerminal`, and applied after buffered data is written — surviving the full setup/flush cycle regardless of when data arrives. `pendingScrollRestore` is guarded in the ResizeObserver, visibility observer, safety-net repaint, `handleTerminalReady`, and the active output handler. If no buffered data appears in the double-RAF, the flag is left set for the active output handler with a 1s fallback timeout
- Auto-scroll mode: per-terminal (`autoScrollMapRef`), disabled by default, toggleable; when on, `scrollToBottom` runs after each RAF-batched write
- Bookmarks: `TerminalBookmark {id, terminalId, scrollLine, selectedText, note, timestamp, selStartX/Y, selEndX/Y}`, persisted to `term-bookmarks:<terminalId>` in localStorage; panel can render inline or via portal into `bookmarkPortalTarget`; jump highlights the original selection for 2s
- Fork (toolbar `onFork`): `DetailPanel.handleFork` POSTs `/api/sessions/:id/fork` for Claude and Codex sessions. Server builds the command: Claude uses `claude --resume '<id>' --fork-session` (or `--continue --fork-session`) and preserves the source `permissionMode` via `reconstructPermissionFlags` (e.g. `--dangerously-skip-permissions`, auto-edit/full-auto modes); Codex uses `codex fork <SESSION_ID>` or `codex fork --last`. On success the forked session is auto-assigned to the source session's room via `useRoomStore.getState().addSession`. **In-place fork path — distinct from the floating-fork below.**
- Clone (toolbar `onClone`): `DetailPanel.handleClone` POSTs the clone endpoint; server strips session-specific flags (`--resume`/`--continue`/`--fork-session`) and starts a fresh session running the same startup command + config, also added to the source room
- Floating-fork (translate-previous-answer): `TerminalContainer.handleTranslateAnswer` POSTs `/api/sessions/spawn-floating` with `{ originSessionId, mode: 'translate-answer', nativeLanguage, learningLanguage }`, records a draft log via `createLog`, then opens the result via `useFloatingSessionsStore.open({ terminalId, label, originSessionId })`. The toolbar button is only passed when `translationEnabled && originSessionId && detectCli(originSession) === 'claude'` (that mode reads Claude transcripts). Floating-terminal hosts pass `originSessionId={null}` to suppress both the popup and the translate-answer button (prevents recursion). See [Floating Terminal Fork](./floating-terminal-fork.md)
- Select-to-translate popup: `useSelectionPopup` watches the terminal wrapper for completed selections (mouseup + click-outside, trigger modes `auto`/`alt`/`off`), extracts via `extractXtermSelection`, and renders `SelectionPopup`. The popup offers Explain (learning/native), Translate → (learning/native), Vocabulary (native), and a custom-prompt row — each POSTs `/api/sessions/spawn-floating` and opens a floating session. Full popup behavior is documented in [Floating Terminal Fork](./floating-terminal-fork.md)
- Paste: 3-strategy fallback — Strategy 1 full Clipboard API (`navigator.clipboard.read`, supports text **and images**), Strategy 2 hidden-textarea `execCommand('paste')`, Strategy 3 `window.prompt`. Trailing newlines stripped. Pasted images are uploaded via `POST /api/queue-images` and the returned file path(s) are sent as text. WS transport chunks at 4096 bytes with 5ms delays between chunks
- Canvas repaint workaround (`forceCanvasRepaint`): RAF → save `viewportY` → `fit()` → `sendResize` → `refresh(0, rows-1)` → restore scroll. Never auto-scrolls. Required when a container transitions `display:none` → visible (tab switch) or after reparent
- Fullscreen: xterm element reparented (`reparent`) between inline and a body-portal overlay (overlay always mounted, toggled via `display`); toolbar duplicated in the overlay topbar; `term-fullscreen` body class set so the DetailPanel overlay hides behind it; toggled via toolbar button or **Alt+F11**
- Custom keys (`attachCustomKeyEventHandler`): Escape → `\x1b`; Shift+Enter → `\x1b\n`; Cmd/Ctrl+Alt+Digit0-9 returns `false` so xterm ignores them and they bubble to the global session-switch shortcut handler; Cmd/Ctrl+V intercepted (preventDefault) to strip trailing newlines and support image paste
- `useTerminal` exposes `readRecentText({ lines?, sinceAbsLine? }): { text, absBottom }` — reads plain text from `term.buffer.active` (default last 30 lines), strips control characters, collapses whitespace. Also exposes `getXtermSelection()` / `hasXtermSelection()` (used by the select-to-translate extractor) and listens for the `terminal:scrollToBottom` document event (fired by a keyboard shortcut)
- Hold-to-speak (TTS): effective only when `settingsStore.ttsEnabled` **and** a non-empty `googleTtsApiKey` is configured. The toolbar shows a mic button and `TerminalContainer` installs capture-phase `keydown`/`keyup` + `blur` listeners. Holding **Space** while focus is inside the terminal wrapper (or pointer-holding the mic) speaks the last 20 buffer lines via `ttsEngine.speak(readRecentText(...))`, then polls every 1.2s for new lines via `readRecentText({ sinceAbsLine })`. Release/blur/disable calls `ttsEngine.stop()`. See [TTS Voice Output](../multimedia/tts-voice-output.md)

## Dependencies & Connections

### Depends On
- [WebSocket Client](./websocket-client.md) — terminal I/O relay (browser transport)
- [Electron IPC Transport](../electron/ipc-transport.md) — terminal I/O relay (desktop transport)
- [State Management](./state-management.md) — `uiStore.openFileInProject` for clickable paths; `sessionStore` for origin lookup; `roomStore.addSession` for fork/clone room assignment
- [Settings System](./settings-system.md) — TTS + translation settings consumed here
- [UI Primitives](./ui-primitives.md) — `Select` (theme picker) and `Tooltip` (every toolbar button)
- [Floating Terminal Fork](./floating-terminal-fork.md) — `SelectionPopup`, `useSelectionPopup`, `selectionExtractors`, `floatingSessionsStore`, `translationLog`, translate-answer/explain modes
- [Server Terminal/SSH](../server/terminal-ssh.md) — server manages PTY processes
- [Server API Endpoints](../server/api-endpoints.md) — `/api/sessions/:id/fork`, `/api/sessions/spawn-floating`, `/api/queue-images`, `/api/terminals/*`
- [Electron PTY Host](../electron/pty-host.md) — `subscribePty`/`writePty`/`onPtyData` IPC

### Depended On By
- [Session Detail Panel](./session-detail-panel.md) — `TerminalContainer` in TERMINAL and COMMANDS tabs; owns the fork/clone handlers
- [File Browser](./file-browser.md) — clickable paths in terminal open files in the Project tab
- [TTS Voice Output](../multimedia/tts-voice-output.md) — consumes `readRecentText()` for hold-to-speak

### Shared Resources
- WebSocket for terminal relay; localStorage for `terminal-theme`, `term-bookmarks:<id>`, `term-scroll:<id>`; document.body classes `terminal-focused` and `term-fullscreen`; document event `terminal:scrollToBottom`

## Change Risks
- Largest hook (~53KB). Adding `useState` inside xterm callbacks causes stale-closure bugs — read from refs instead
- Breaking dual-transport detection (`isPtyHostTerminal`) blocks the terminal in one environment
- `scrollback: 100_000` is intentional (lazy allocation). Lowering it truncates scrollback context; raising it risks memory blowup on a runaway process
- Canvas repaint workaround is fragile — removal causes blank terminals; `forceCanvasRepaint` must never auto-scroll
- `pendingScrollRestore` on `ActiveTerminal` prevents race conditions during session switch — removing it makes the terminal jump to top when switching sessions
- The two custom link providers replace WebLinksAddon; the URL provider's wrapped-line grouping is what keeps long OAuth URLs clickable — do not swap it back to WebLinksAddon
- Skipping `unsubscribePty` on detach (Electron path) leaves the renderer receiving `pty:data` for unviewed terminals. No correctness bug (data is buffered in `pendingOutputRef`), but typing latency on the active terminal degrades with the number of background sessions — the original perf bug this path fixes

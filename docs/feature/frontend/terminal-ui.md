# Terminal UI (xterm.js)

## Function
Full terminal emulation using xterm.js 5 over the server's WebSocket (an Electron IPC transport exists for `pty-*` terminals, which nothing creates any more), fork/clone, select-to-translate, hold-to-speak TTS, and scroll preservation.

## Purpose
Interactive PTY terminal within the dashboard. Users can type commands, view output, and interact with AI CLI sessions directly.

## Source Files
| File | Role |
|------|------|
| `src/hooks/useTerminal.ts` (~66KB, largest hook) | xterm lifecycle, dual transport, attach/detach, output buffering, link providers, scroll preservation, `readRecentText` |
| `src/hooks/useTerminal.wsSubscribeRace.test.ts` | The pop-out subscribe race at the hook level: `readyState` flipping in place, a store-only open with no parent re-render, a socket that opens before setup finishes, and exactly one subscribe (no replayed scrollback) |
| `src/hooks/useTerminal.geometry.test.ts` | `isSaneGeometry`/`MIN_SANE_COLS` (rejects near-zero measurements) and `verifySettled` (rejects non-zero-but-transitional ones — see Change Risks) |
| `src/components/terminal/TerminalContainer.tsx` | Composes toolbar + xterm + bookmarks + fullscreen overlay; hosts `SelectionPopup`, owns hold-to-speak TTS state, and accepts `onFork?` / `onClone?` / `onPopOut?` (passed to the main toolbar only) |
| `src/components/terminal/TerminalToolbar.tsx` | Theme `Select` + icon buttons (ESC, paste, arrows ↑↓, Enter, ✨ AI-popup toggle (`termAiPopupOn`/`Off`), pan/wrap width-mode toggle (`termWrapOn`/`Off` — see "Line-width mode" below), auto-scroll, scroll-to-bottom, refresh, clone, fork, pop-out-to-window, hold-to-speak mic (cloud TTS), fullscreen, reconnect). The `⧉` pop-out button renders only when `onPopOut` is provided (Electron main/commands terminals). All buttons use the shared `Tooltip` wrapper |
| `src/components/terminal/themes.ts` | 8 named themes (`default`, `dark`, `monokai`, `dracula`, `solarized-dark`, `nord`, `windows-xp`, `github-dark`) + `auto` theme built from CSS variables (`buildAutoTheme`). `windows-xp` is the XP-era cmd.exe palette — silver-on-black with the classic 16 console colours — and is independent of the app-wide `windows-xp` UI theme, which is a light theme; picking one does not select the other |
| `src/components/translate/SelectionPopup.tsx`, `src/hooks/useSelectionPopup.ts`, `src/lib/selectionExtractors.ts` | Select-to-translate/explain popup wired into TerminalContainer (the xterm extractor) |
| `src/stores/floatingSessionsStore.ts`, `src/lib/translationLog.ts` | Floating-session orchestration + Dexie translation log used by the select-to-translate popup (imported by `SelectionPopup`, not by `TerminalContainer` directly) |
| `src/lib/terminalLinkHandler.ts`, `src/lib/terminalLinkHandler.test.ts` | Shared HTTP(S)-only terminal hyperlink opener, xterm OSC 8 handler, and regression coverage for direct external-browser activation without xterm's confirmation dialog |
| `src/lib/terminalTransport.ts`, `src/lib/terminalTransport.test.ts` | Transport-aware terminal close: Electron `killPty` for `pty-*`, followed by server-registration cleanup; unit coverage for IPC and browser paths |

## Implementation
- xterm config: JetBrains Mono (fallbacks Cascadia/Fira/Menlo), responsive font (11px ≤480, 12px ≤640, else 14px), lineHeight 1.15, bar cursor non-blinking, `scrollback` from the `terminalScrollbackLines` setting (default **5 000**, clamped 1 000–200 000; xterm allocates lazily but never reclaims a written line), 200ms ResizeObserver debounce, `allowProposedApi: true`
- Addons: `FitAddon`, `Unicode11Addon` (`unicode.activeVersion = '11'`). **No WebLinksAddon** — link detection is done by two custom `registerLinkProvider` callbacks:
  - **URL link provider**: matches `https?://…`, concatenates wrapped-line groups (up to `MAX_URL_GROUP_LEN = 4096`) so long URLs stay clickable, and strips trailing punctuation before calling `openTerminalUrl()`
  - **File-path link provider**: detects paths with the shared `createFilePathRegex()` (`src/lib/filePathLink.ts`, Unicode-aware so non-English paths like `客户版-业务流程确认.md` are clickable) and derives the link's column range from `mapLineColumns(line)` (so double-width CJK cells stay aligned — `match.index`/`length` are UTF-16 offsets, not columns). `activate(event)` calls `useUiStore.getState().openFileChooser(clean, projectPath, { x: event.clientX, y: event.clientY })`, showing the [File-Open Chooser](./file-open-chooser.md) popover (open in app / OS default app / reveal in Finder)
- Terminal hyperlink activation is centralized in `openTerminalUrl()`: it validates with `new URL()`, accepts only `http:` and `https:`, then calls `window.open(url, '_blank', 'noopener,noreferrer')`. In Electron, the existing `setWindowOpenHandler` denies in-app navigation and forwards the URL to `shell.openExternal`; in a browser it opens a new tab. The xterm constructor also sets `linkHandler: TERMINAL_LINK_HANDLER`, so CLI-emitted OSC 8 hyperlinks use this path instead of xterm's built-in `confirm()` warning. `allowNonHttpProtocols: false` prevents xterm from delivering non-HTTP(S) OSC 8 targets to the handler.
- Input sanitation: `stripTerminalResponses()` (regex `TERMINAL_RESPONSE_RE`) drops terminal-response escape sequences (Focus In/Out `\x1b[I`/`\x1b[O`, Primary/Secondary Device Attributes replies) from `onData`/`onBinary` before they reach the PTY
- Dual transport: `isPtyHostTerminal(terminalId)` returns true when `terminalId` starts with `pty-` and `window.electronAPI?.writePty` exists. IPC: `writePty`/`resizePty`/`subscribePty`/`unsubscribePty`/`onPtyData`/`onPtyExit`. WebSocket: `terminal_input`/`terminal_resize`/`terminal_subscribe`/`terminal_disconnect` out; `terminal_output`/`terminal_ready`/`terminal_closed` in. In practice every terminal is `term-*` on the WebSocket path: nothing in the renderer creates `pty-*` terminals (see [IPC Transport](../electron/ipc-transport.md#transport-selection))
- Subscription tracking: one subscribe per `(socket, xterm)`, recorded in `subscribedTerminalIdRef` + `subscribedSocketRef`. Each `terminal_subscribe` makes the server replay the whole scrollback to that socket, so a second one duplicates the screen. `attach()` clears `subscribedSocketRef` (a fresh xterm needs its own replay) and subscribes inline when the socket is already open; otherwise the ws effect subscribes once it is. That effect's deps are `[ws, ws?.readyState, wsConnected, activeTerminalId]` — `wsConnected` (`useWsStore`) re-renders the hook when the socket opens, since the parent's re-render stops at `memo(TerminalContainer)`, and `activeTerminalId` re-runs it when setup finishes after the socket opened. When switching terminals the previous one is `terminal_disconnect`'d first (#74). PTY-host terminals subscribe via `subscribePty()` (which returns a replay `buffer`) and never use WS for subscription
- Missing-terminal handling: an IPC `subscribePty()` result with `ok: false` and a browser `terminal_closed` response both mark the active terminal closed. Electron broadcasts PTY exits globally, so `useTerminal` updates the scalar close state only when the event belongs to the currently attached terminal; an unrelated exit cannot erase an existing unavailable overlay. `TerminalContainer` renders `Terminal unavailable` (or `Terminal disconnected` for an exit) over the xterm even when no reconnect handler exists, instead of leaving a toolbar and blank cursor.
- Terminal close: `closeManagedTerminal()` calls Electron's `killPty()` for `pty-*` IDs, then `DELETE /api/terminals/:id` to remove the server registration. Single-session and room KILL modals share this path and prefer the canonical terminal ID returned by the kill endpoint; browser/server-owned `term-*` terminals use the DELETE only.
- Attach lifecycle: skip re-attach to same terminal; save outgoing terminal's scroll offset + per-terminal auto-scroll state; clear stale pending output; subscribe via transport; `setupWhenReady` (60 retries × 50ms RAF+timeout, then IntersectionObserver fallback for always-mounted hidden tabs like COMMANDS); create xterm; load addons; register link providers; `attachCustomKeyEventHandler`; `onData`/`onBinary`; the initial `fitAddon.fit()` (gated by `verifySettled` — see Change Risks below, doesn't send to the PTY until a second reading a frame later agrees); ResizeObserver; visibility IntersectionObserver; `forceCanvasRepaint` (also sets `layoutReady`); flush buffered output (double-RAF) merging up to 500 chunks via `mergeChunks`; safety-net repaint at 150ms
- Detach lifecycle: save scroll offset to `term-scroll:<terminalId>` in localStorage; clear the active terminal's batched output buffer; for PTY-host terminals call `electronAPI.unsubscribePty(terminalId)` so the Electron main process stops streaming `pty:data` for this session (WS terminals send `terminal_disconnect` on the next attach instead); disconnect ResizeObserver + visibility observer; dispose xterm; remove `terminal-focused` body class
- Output buffering: inactive terminals queue up to 500 base64 chunks per terminal (`pendingOutputRef`), stale buffers evicted after 60s (`pendingOutputTtlRef`), flushed + merged into one `term.write()` on attach. Active terminal writes are batched per `requestAnimationFrame` (`outputRafRef`) and also merged via `mergeChunks` to avoid N parser runs / N repaints / N GC allocations
- Scroll preservation: saved as "lines above bottom". On attach the offset is read from `savedScrollRef` (in-memory) with a `term-scroll:<id>` localStorage fallback, stored as `pendingScrollRestore` on `ActiveTerminal`, and applied after buffered data is written — surviving the full setup/flush cycle regardless of when data arrives. `pendingScrollRestore` is guarded in the ResizeObserver, visibility observer, safety-net repaint, `handleTerminalReady`, and the active output handler. If no buffered data appears in the double-RAF, the flag is left set for the active output handler with a 1s fallback timeout
- Auto-scroll mode: per-terminal (`autoScrollMapRef`), disabled by default, toggleable; when on, `scrollToBottom` runs after each RAF-batched write
- Fork (toolbar `onFork`): `DetailPanel.handleFork` POSTs `/api/sessions/:id/fork` for Claude and Codex sessions. Server builds the command: Claude uses `claude --resume '<id>' --fork-session` (or `--continue --fork-session`) and preserves the source `permissionMode` via `reconstructPermissionFlags` (e.g. `--dangerously-skip-permissions`, auto-edit/full-auto modes); Codex uses `codex fork <SESSION_ID>` or `codex fork --last`. On success the forked session is auto-assigned to the source session's room via `useRoomStore.getState().addSession`. **In-place fork path — distinct from the floating fork the select-to-translate popup spawns below (`/api/sessions/spawn-floating`).**
- Clone (toolbar `onClone`): `DetailPanel.handleClone` POSTs the clone endpoint; server strips session-specific flags (`--resume`/`--continue`/`--fork-session`) and starts a fresh session running the same startup command + config, also added to the source room
- Select-to-translate popup: `useSelectionPopup({ enabled: translationEnabled && !!originSessionId, … })` watches for completed selections (mouseup + click-outside, trigger modes `auto`/`alt`/`off`), extracts via `extractXtermSelection`, and renders `SelectionPopup`. Floating-terminal hosts pass `originSessionId={null}` to suppress the popup (prevents recursion). A bare click never opens the popup: `onMouseUp` requires a drag of more than `CLICK_DRAG_THRESHOLD_PX = 4` px from mousedown, or a multi-click (`e.detail >= 2`). Surfaces that keep a STALE selection after a click (the Claude Code TUI captures mouse events, so xterm doesn't clear its selection) would otherwise re-open the popup when the user only clicked into the input. The mouseup listener binds to **`document`** and is scoped by `scopeSelector: '.xterm'` (not to the terminal wrapper): fullscreen mode reparents the xterm element into a body-level overlay outside `rootRef`, so a wrapper-bound listener silently stopped firing there and the popup never appeared in distraction-free mode. Per-terminal `extract` (checks *this* terminal's `hasXtermSelection()`) disambiguates when several terminals are mounted; the popup's `z-index: 10050` sits above the fullscreen overlay (10000) so it's visible in that mode. **Mouse-tracking TUIs** (Claude Code's fullscreen renderer, vim, htop enable DECSET 1000/1002/1006) capture a plain drag as mouse reports, so no selection forms and the popup can't fire. Two-layer defense: (1) dashboard-spawned PTYs set **`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`** (`withClaudeTuiEnvDefaults` in `server/sshManager.ts` + `electron/ptyHost.ts`, see [Terminal/SSH → Environment](../server/terminal-ssh.md)) so Claude Code ≥ 2.1.150 stays on its classic renderer and never captures the mouse — plain drag-select and the popup work as before; (2) the terminal is created with **`macOptionClickForcesSelection: true`** so for TUIs that still capture the mouse (vim, htop, a user fullscreen override, `claude` bg-attach sessions which are always fullscreen) the user holds **Option(⌥)-drag** to force a real xterm selection — `extractXtermSelection` reads only `hasXtermSelection()`, and xterm sets `user-select: none` so a browser-native fallback is impossible (verified). Set this at **construction** — assigning `term.options.macOptionClickForcesSelection` afterwards is ignored by xterm. The popup offers Explain (learning/native), Translate → (learning/native), Vocabulary (native), a Model/Effort quick-settings row (blank means inherit from the origin session), and a custom-prompt row — each POSTs `/api/sessions/spawn-floating` and opens a floating session. Full popup behavior, including the quick-settings row, is documented in [Floating Terminal Fork](./floating-terminal-fork.md)
- Paste: 3-strategy fallback — Strategy 1 full Clipboard API (`navigator.clipboard.read`, supports text **and images**), Strategy 2 hidden-textarea `execCommand('paste')`, Strategy 3 `window.prompt`. Trailing newlines stripped. Pasted images are uploaded via `POST /api/queue-images` and the returned file path(s) are sent as text. WS transport chunks at 4096 bytes with 5ms delays between chunks
- Canvas repaint workaround (`forceCanvasRepaint`): RAF → save `viewportY` → `fit()` → `sendResize` → `refresh(0, rows-1)` → restore scroll. Never auto-scrolls. Required when a container transitions `display:none` → visible (tab switch) or after reparent
- Fullscreen: xterm element reparented (`reparent`) between inline and a body-portal overlay (overlay always mounted, toggled via `display`); toolbar duplicated in the overlay topbar; `term-fullscreen` body class set so the DetailPanel overlay hides behind it; toggled via toolbar button or **Alt+F11**
- Custom keys (`attachCustomKeyEventHandler`): Escape → `\x1b`; Shift+Enter → `\x1b\n`; Cmd/Ctrl+Alt+Digit0-9 returns `false` so xterm ignores them and they bubble to the global session-switch shortcut handler; Cmd/Ctrl+V intercepted (preventDefault) to strip trailing newlines and support image paste
- `useTerminal` exposes `readRecentText({ lines?, sinceAbsLine? }): { text, absBottom }` — reads plain text from `term.buffer.active` (default last 30 lines), strips control characters, collapses whitespace. Also exposes `getXtermSelection()` / `hasXtermSelection()` (used by the select-to-translate extractor) and listens for the `terminal:scrollToBottom` document event (fired by a keyboard shortcut)
- Hold-to-speak (cloud TTS): effective only when `settingsStore.ttsEnabled` **and** a non-empty `googleTtsApiKey` is configured. The toolbar shows a mic button and `TerminalContainer` installs capture-phase `keydown`/`keyup` + `blur` listeners. Holding **Space** while focus is inside the terminal wrapper (or pointer-holding the mic) speaks the last 20 buffer lines via `ttsEngine.speak(readRecentText(...))`, then polls every 1.2s for new lines via `readRecentText({ sinceAbsLine })`. Release/blur/disable calls `ttsEngine.stop()`. See [TTS Voice Output](../multimedia/tts-voice-output.md)
- **Point-and-click line speaker — REMOVED (Aug 2026).** A third Kokoro path used to show a floating 🔊 icon beside the hovered terminal line and speak just that line. Removed at the user's request: the icon appeared under the pointer during ordinary reading of output, and it had already required two rounds of fixes (icon anchoring, then a hover-flicker/unclickable-icon pair). Deleted with it: `useLineSpeaker.ts`, `terminalHoverPosition.ts` and `terminalLineText.ts` (each with its test), `useTerminal`'s `getHoveredLine`/`getLineText`, `.lineSpeakBtn`, and `tooltips.termSpeakLine`. The toolbar's click-to-toggle continuous narration and the Google hold-to-speak mic are untouched — only this surface is gone.

## Dependencies & Connections

### Depends On
- [WebSocket Client](./websocket-client.md) — terminal I/O relay (browser transport)
- [Electron IPC Transport](../electron/ipc-transport.md) — terminal I/O relay (desktop transport)
- [State Management](./state-management.md) — `wsStore.connected` (re-renders the hook when its socket opens — see the blank pop-out section); `uiStore.openFileChooser` for clickable paths (the chooser then calls `openFileInProject` on the in-app option); `sessionStore` for origin lookup; `roomStore.addSession` for fork/clone room assignment
- [Settings System](./settings-system.md) — TTS + translation settings consumed here
- [UI Primitives](./ui-primitives.md) — `Select` (theme picker) and `Tooltip` (every toolbar button)
- [Floating Terminal Fork](./floating-terminal-fork.md) — `SelectionPopup`, `useSelectionPopup`, `selectionExtractors`, `floatingSessionsStore`, `translationLog`, explain / translate-selection / vocab / custom modes
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
- Largest hook (~66KB). Adding `useState` inside xterm callbacks causes stale-closure bugs — read from refs instead
- Breaking dual-transport detection (`isPtyHostTerminal`) blocks the terminal in one environment
- Electron PTYs are owned by the main process, not `sshManager`; deleting only the REST terminal record does not stop them. Kill/close actions must keep using `closeManagedTerminal()`.
- `scrollback` is a user setting (`terminalScrollbackLines`, Settings ▸ ADVANCED ▸ Terminal), read through `scrollbackLinesRef` so changing it never tears down a live terminal. xterm applies `scrollback` at construction, so a new value affects **newly opened** terminals only — same rule as the replay buffer.
- The former hard-coded `100_000` was the largest single renderer cost: xterm allocates lazily, but each *written* line holds roughly `cols × 12` bytes (Uint32Array, 3 uint32/cell) for the life of the terminal, so one busy agent could retain >100 MB with no way to reclaim it. The 5 000 default is still deeper than the replay buffer can restore; 20 000 / 50 000 / 100 000 remain selectable.
- Canvas repaint workaround is fragile — removal causes blank terminals; `forceCanvasRepaint` must never auto-scroll
- `pendingScrollRestore` on `ActiveTerminal` prevents race conditions during session switch — removing it makes the terminal jump to top when switching sessions
- The two custom link providers replace WebLinksAddon; the URL provider's wrapped-line grouping is what keeps long OAuth URLs clickable — do not swap it back to WebLinksAddon. Keep `TERMINAL_LINK_HANDLER` configured at xterm construction time, or OSC 8 OAuth links fall back to xterm's confirmation dialog. Do not enable non-HTTP protocols.
- Skipping `unsubscribePty` on detach (Electron path) leaves the renderer receiving `pty:data` for unviewed terminals. No correctness bug (data is buffered in `pendingOutputRef`), but typing latency on the active terminal degrades with the number of background sessions — the original perf bug this path fixes
- **(Historical) The point-and-click line speaker is gone (Aug 2026).** Its icon-anchoring bug and later hover-flicker fixes lived in `terminalHoverPosition.ts` / `useLineSpeaker.ts`, both deleted. Retained only as precedent: an overlay positioned from a constant container offset rather than the content it points at will look detached on short rows and overlap on full-width ones — and a `document.body`-portaled overlay is not a DOM descendant of the element whose `mouseleave` you are listening to.
- **The narrow-column PTY-corruption bug has recurred three times — `MIN_SANE_COLS` alone does not close it.** `fitAddon.fit()` measures the container's live CSS width; if that measurement is taken while a remount's layout is still settling, `cols` can land at a small-but-plausible value (e.g. ~20-30) that clears `MIN_SANE_COLS` easily and is indistinguishable from a genuinely narrow terminal by value alone. Sending it to the PTY is permanent: Claude Code hard-wraps its own output at `process.stdout.columns`, and xterm can re-flow only its *own* soft wraps, never PTY-emitted hard newlines — so the corrupted scrollback never heals, even once the container reaches its real width. `verifySettled` (`useTerminal.ts`) is the fix: re-measure one frame later and only send the geometry if two consecutive readings agree; a disagreement means the layout is still moving, and the (200ms-debounced) `ResizeObserver` will catch the eventually-settled size on its own — skipping is always safe, sending a premature value is not. It gates the two call sites confirmed to run right after a remount: the initial `fit()` in the attach lifecycle (a fresh `doSetup()`, e.g. after DetailTabs' PROJECT split/stacked toggle moves the terminal to a new JSX parent) and `forceCanvasRepaint`'s resize-send after `reparent()` (fullscreen toggle) — its repaint/scroll/`layoutReady` side effects stay unconditional (idempotent), only the PTY resize is gated. Four other `fitAddon.fit()` call sites (`applyPendingScroll`, the 150ms safety-net repaint, `handleTerminalReady`, `refitTerminal`) remain unguarded even by a basic `offsetWidth`/`offsetHeight` check — not yet confirmed as a live trigger for this exact bug, but the same fix pattern applies if one of them turns out to be.

## Line-width mode: pan vs wrap (narrow devices)

A PTY spawns at **120 columns**; a phone in portrait fits about **49**. Those
cannot both be satisfied, and the two ways of reconciling them fail very
differently:

| Approach | Result |
|---|---|
| Resize the PTY to 49 | **Permanent corruption, every device.** Claude Code wraps its own output to `process.stdout.columns` and emits real newlines; xterm can re-flow only the lines *it* wrapped. All later scrollback stays hard-wrapped at 49 and never heals. |
| Soft-wrap 120 into 49 locally | Ugly but harmless — lines break mid-word (`--oneli` / `ne`), box drawing and tables lose alignment. |
| Render at 120 and pan | Nothing wraps; alignment survives; the user swipes for long lines. |

So the narrow device never takes the first option. `src/lib/terminalGeometry.ts`
holds both rules as pure functions:

- **`mayDrivePtyGeometry(isMobile)`** — may this device push its viewport width
  to the shared PTY? False on a phone **even while it holds the control baton**.
  The server already blocks a spectator (`holdsControl` gates `TERMINAL_RESIZE`),
  so the remaining hole was a phone that takes control *to type* and reflows the
  Mac's scrollback as an unrequested side effect.
- **`resolveRenderCols(mode, fittedCols, ptyCols)`** — how wide the local canvas
  draws. `'pan'` pins to the PTY's width, `'wrap'` uses the fitted width. Either
  way the PTY is untouched.

### Where the rules are enforced

Both are installed at a **single choke point**, deliberately:

- `deviceMayDrivePty` is **module-scoped** in `useTerminal.ts`, not a parameter.
  "Is this a phone" describes the device, not the terminal, and there are a
  dozen `sendResize` call sites — one missed site costs a permanently
  hard-wrapped PTY with nothing logged.
- The width rule wraps the **FitAddon instance where it is constructed**
  (`installWidthModeFit`), rather than editing the twelve `fit()` calls.
  CLAUDE.md already records four `fit()` sites that stayed unguarded across
  three separate debugging passes, so "remember to call the helper" is not a
  guarantee this file has earned.

### How the client learns the PTY's width

`terminal_geometry` (`{ terminalId, cols, rows }`) is sent to the joining socket
on `TERMINAL_SUBSCRIBE` and re-broadcast to every subscriber after a successful
resize, so a panning phone re-pins instead of silently clipping. It is read from
`pty.cols` live (`getTerminalGeometry`), never a cached copy, so it stays correct
whoever performed the resize. Delivery failure is silent by design: a client that
never receives it falls back to fitting its container, which is the pre-existing
behavior.

### UI

`TerminalToolbar` shows a wrap/pan toggle **only where panning is the default**
(`useIsMobile()`), since a desktop terminal already fits its container and the
button would be a no-op. Pan mode adds `.panMode` to the container:

```css
.container.panMode { overflow-x: auto; overflow-y: hidden; }
.container.panMode :global(.xterm) { width: max-content; min-width: 100%; }
```

Both overflow axes are declared because **a `visible` axis computes to `auto`
when the other is `auto`** — omitting `overflow-y` creates a second vertical
scroller outside xterm's own viewport. The `width` rules are needed because
`.xterm` is a block and would otherwise clip its own background at the
container's width while its `.xterm-screen` child renders far wider.

### Desktop is unaffected

`defaultWidthMode(false)` is `'wrap'` and `resolveRenderCols` ignores `ptyCols`
in that mode, so desktop behavior is byte-identical to before. One deliberate
consequence: a desktop *browser* dragged narrower than 480px also stops driving
the PTY — the same rule applied consistently, not an oversight.

Verified with a real xterm at 390px: fitted 54 → rendered 120, container
`scrollWidth` 799 vs `clientWidth` 378, vertical scrolling and horizontal pan
both working with no second scrollbar. Unit coverage in
`src/lib/terminalGeometry.test.ts`.


## CJK selection: paint-layer drift and word-boundary over-selection

Two independent bugs in text selection on lines mixing CJK and Latin text,
found and fixed together because a user's report of one ("the blue highlight
looks like a display glitch") led to isolating both via a harness.

### Bug 1 — selection highlight visually drifts from the glyphs it covers

xterm's default DOM renderer forces each CJK glyph's `<span>` to exactly 2
cell-widths using compensating CSS `letter-spacing`, because the fallback CJK
font's real glyph advance width never matches the assumed monospace cell
width. The selection-highlight overlay is a separate DOM element positioned
from idealized `column * cellWidth` math that has no knowledge of that
compensation — so on any row where CJK text precedes a Latin selection, the
highlight box visibly diverges from the real glyph position.

Measured directly (not eyeballed) via a harness reproducing the app's exact
font/options: selecting a 9-character word after CJK text produced a
**uniform 13px drift across the whole box** — same width, rigidly shifted,
confirming a translation error rather than accumulating per-character noise.
`term.getSelection()` (the buffer-level API) was correct throughout in both
tests — this is purely how the selection *paints*, never what it contains.

**Fix**: load `@xterm/addon-canvas` (`src/hooks/useTerminal.ts`, alongside the
existing `FitAddon`/`Unicode11Addon`). The canvas renderer paints glyphs and
the selection overlay from the same direct pixel math, eliminating the
compensation mismatch entirely — confirmed via the same harness at 0px
measurable drift. Loaded in a `try/catch` matching the Unicode11 pattern: a
construction failure (no GPU context) falls back to the DOM renderer rather
than breaking the terminal.

Verified NOT to affect two things before shipping:
- **The pan/wrap terminal-width feature** (`terminalGeometry.ts`) — its CSS
  targets `.xterm` / `.xterm-viewport` / `.xterm-screen`, all of which still
  exist under canvas mode; the addon only replaces how row *content* paints.
- **Select-to-translate** (`extractXtermSelection` in `selectionExtractors.ts`)
  — reads `term.getSelection()`, not DOM text, so it is renderer-agnostic.

### Bug 2 — double-click over-selects across CJK punctuation

Found while isolating Bug 1, confirmed independent of it (reproduces
identically under both renderers): xterm's default double-click word-boundary
character set doesn't include fullwidth CJK punctuation. Double-clicking a
Latin word immediately followed by a fullwidth comma selected the word *and*
the next one — `"Claudekit、Anthropic"` from a double-click squarely on
"Claudekit", confirmed via `term.getSelectionPosition()`, not just a visual
guess.

**Fix**: `wordSeparator` in the `Terminal` constructor options is
`DEFAULT_WORD_SEPARATOR + CJK_WORD_SEPARATORS`. `DEFAULT_WORD_SEPARATOR` is
xterm's own default, verified byte-for-byte against a real `Terminal`
instance's `options.wordSeparator` rather than hand-transcribed — additive,
so existing ASCII word-selection (splitting on brackets/quotes) is untouched.

**A real hazard hit while writing `CJK_WORD_SEPARATORS`**: typing its curly
quotes (’“” etc.) directly into a single string literal had them silently
normalized to straight ASCII quotes by the editing tool, which closed the
string early and broke the build. Caught only by re-running `tsc`, not by
reading the diff — the corruption is invisible to the eye at normal
proofreading speed. The constant is split across two concatenated literals;
verify with `[...str].map(c => c.codePointAt(0))` after ever touching this
line, don't trust that a clean `tsc` run alone proves the characters are the
ones intended.

Neither bug has unit-test coverage — there's no meaningful unit-test surface
for sub-pixel rendering or a real double-click's pixel-to-column path.
Verification is the harness methodology itself: build a real `xterm.js`
instance with the app's exact font/constructor options, write the reproducing
CJK+Latin text, drive it with a genuine `page.mouse.dblclick()` (not
`term.select()`, which bypasses the mouse-pixel-to-column translation where
Bug 1 actually lives), and measure `getBoundingClientRect()` deltas or
`term.getSelection()` content rather than trust a screenshot glance.


## Toolbar changes (Aug 2026): two removals, one addition

**Removed — 🔊 Read output aloud (offline Kokoro TTS).** The last consumer of
the Kokoro stack; `src/lib/kokoroTts.ts`, `kokoroWorker.ts` and both test files
are deleted, along with the `ttsLocalEnabled`/`ttsLocalVoice` settings and the
"Local Voice" section of `SoundSettings`. The per-line 🔊 speaker had already
been removed in Aug 2026, so nothing else referenced it. **The 🎤 hold-to-speak
mic (Google Cloud TTS) is a different button and stays.**

**Removed — 🔖 Terminal bookmarks.** The panel, its `localStorage` persistence
(`term-bookmarks:<terminalId>`), `getTerminalBookmark`/`jumpToBookmark` in
`useTerminal`, the `terminalBookmark` keyboard shortcut, and the
`bookmarkPortalTarget` plumbing in `DetailPanel`. Two unrelated features share
the word "bookmark" and were left untouched: the **saved-prompts 🔖** in the
queue compose row (`PromptSnippetPicker`, Dexie `promptSnippets`) and the
**file-viewer line bookmarks** in Project Browser (`.bookmarkedLine`). A naive
grep for "bookmark" hits 15 files; only the 7 carrying `TerminalBookmark*` /
`termBookmark` were in scope.

**Added — per-session AI popup toggle (✨).** Controls whether selecting
terminal text opens the Explain / Translate menu. Some sessions don't want it;
it stays **on by default**.

- Feeds the `enabled` flag that `useSelectionPopup` already exposed, so this is
  wiring into an existing gate, not new interception.
- **Server-backed and synced**: `sessions.ai_popup_enabled`, `PUT
  /api/sessions/:id/ai-popup`, and a `SESSION_UPDATE` broadcast so the phone
  and the desktop agree. The setting belongs to the session, not the device.
- The client flip is optimistic (same shape as `MUTE`/`ALERT`/`SHARED`).

### The default-ON inversion is load-bearing

`aiPopupEnabled` unset means **enabled**, the opposite of `remoteVisible`,
whose unset means hidden. Both obey "the absent state must be the safe state" —
the safe states just differ. Remote viewing is a new capability (deny by
default); the AI popup already shipped on for every session (leaving it on
changes nothing).

The column is therefore `ai_popup_enabled INTEGER DEFAULT 1`: `ALTER TABLE`
back-fills existing rows with the default, and a `DEFAULT 0` would have turned
the feature off for every session the user already had.

**Always read through `isAiPopupEnabled(session)`** (`src/lib/aiPopup.ts`).
The raw field is `undefined` on every pre-toggle session, and `!undefined` is
`true`, so `!session.aiPopupEnabled` makes the first click "enable" something
already enabled — a button that visibly does nothing. Covered by
`aiPopup.test.ts` and the `toggleAiPopup` tests; reverting to the raw read
turns 3 of them red.


## Blank pop-out terminal: a WebSocket reference-identity race, not a layout bug

**Symptom:** popping a terminal into its own window (`PopoutTerminalView`) produced
a window whose toolbar rendered normally and whose xterm instance visibly
mounted (blinking cursor), but which never displayed any content — no error,
no "Terminal disconnected" overlay, just permanently empty.

**Two hypotheses were investigated and disproven before the real cause was
found** — recorded here so they don't get retried:

1. **The WS auth gate rejecting the popup.** Plausible on the surface (a
   password had been set that week), but the server's own log showed multiple
   simultaneous WS clients connecting *hours after* the password was enabled —
   popouts clearly could and did authenticate. A live probe against the
   running server (a tokenless loopback socket) also confirmed the gate's
   actual behavior matched its code.
2. **`layoutReady` / a zero-size initial container blocking the buffered-output
   flush.** The more seductive theory, because `useTerminal.ts` has legitimate,
   documented history of zero-size-measurement bugs (see the narrow-column
   entry above) and a `layoutReady` field that *sounds* like a gate. It isn't:
   `grep -n '\.layoutReady' src/hooks/useTerminal.ts` shows it is written in
   **exactly one place** (`forceCanvasRepaint`) and **read in zero** — nothing
   in the file ever checks its value. Separately, `setupWhenReady` already
   retries up to 60×50ms (then falls back to an `IntersectionObserver`) before
   ever calling `doSetup()`, so `doSetup()` — and therefore xterm construction —
   never runs against a zero-size container to begin with.

**The actual cause:** `WsClient` (`src/lib/wsClient.ts`) assigns
`this.ws = new WebSocket(url)` exactly once per `connect()` call; `onopen`
only flips a status flag via callback, it never reassigns `this.ws`. So across
the CONNECTING → OPEN transition of the *first* connection after mount, the
`ws` object reference passed into `useTerminal` never changes — only its
`readyState` mutates, from 0 to 1, in place. The effect that re-subscribes to
the terminal on socket-ready was keyed on `useEffect(() => {...}, [ws])`
alone, which compares via `Object.is()` and sees no change, so it silently
never re-ran for this transition.

This already worked correctly for a genuine **reconnect** — `scheduleReconnect()`
calls `connect()` again, constructing a real new `WebSocket` object, so the
`[ws]`-only effect correctly fires there. The bug is isolated to the very
first connect. That's also why it's invisible in the main window: its socket
has typically been open for minutes before any terminal is ever attached, so
`attach()`'s own inline subscribe (inside `attach()` itself, separate from this
effect) already succeeds by the time it runs. A freshly-opened
`PopoutTerminalView` has no such head start — it constructs its `WsClient` and
calls `attach()` in the same render pass, so the socket is still CONNECTING
when `attach()` runs, correctly skips subscribing (`readyState !== 1`), and
nothing was ever going to retry afterwards.

**Fix:** add `ws?.readyState` as a second dependency —
`}, [ws, ws?.readyState]);`. The primitive value differs across the render
that follows `onopen` (which flips the `connected` flag in the WS store and was
assumed to cascade a re-render down through `PopoutTerminalView` →
`TerminalContainer` — it does not; see the next section), even though the
object reference does not.

**Confirmed against the real hook, not reasoned about.** A test harness
constructs the actual `useTerminal` hook (real xterm.js against a jsdom
container — jsdom needs `matchMedia`, `ResizeObserver`, and
`IntersectionObserver` polyfilled for this to run at all), passes a fake
socket object, mutates its `readyState` in place, and re-renders with the SAME
reference. Before the fix this sent zero `terminal_subscribe` messages; after,
it sent one. Covered permanently by `useTerminal.wsSubscribeRace.test.ts`,
which also pins: a genuinely new object arriving already open must still
resubscribe (the reconnect path must not regress), and a re-render for an
unrelated reason with neither `ws` nor `readyState` changed must NOT resend
(the fix must not turn this into a resubscribe-on-every-render loop).

### The August fix was incomplete: `memo()` stopped the re-render (fixed Sep 2026)

`TerminalContainer` is `memo()`'d, and after `onopen` its props are identical —
same `terminalId`, same `ws` object — so `PopoutTerminalView`'s re-render stops
at the memo boundary and `useTerminal`'s effect never re-evaluates
`ws?.readyState`. The pop-out subscribed only when some *unrelated* update
re-rendered `TerminalContainer` after the socket opened (settings arriving from
IndexedDB, for instance). That lands in the same ~10–30 ms window as the
WebSocket handshake, so the window came up blank on some opens and fine on
others. The harness above missed it because `renderHook(...).rerender()` re-runs
the hook directly and never meets `memo`.

`useTerminal` now reads `useWsStore((s) => s.connected)` itself, so the store
flip re-renders the hook whatever the parent does. That makes the effect run
more often, so it is now idempotent: `subscribedSocketRef` records the socket
the current xterm is already subscribed on, and the effect skips a repeat,
because `setWsClient` replays the whole scrollback on every subscribe.
`attach()` clears the record, since a fresh xterm needs its own replay.
`activeTerminalId` is a dependency too: once the store flip has run the effect
early (socket open, xterm not yet set up), only setup finishing can re-run it.

Coverage: `PopoutTerminalView.test.tsx` renders the real memo'd tree and expects
one subscribe after the store reports the socket open (0 before the fix);
`useTerminal.wsSubscribeRace.test.ts` adds the store-only open, a socket that
opens before setup finishes, and exactly one subscribe for an already-open
socket.

# Terminal UI (xterm.js)

## Function
Full terminal emulation using xterm.js 5 with dual transport (IPC for Electron, WebSocket for browser), bookmarks, fork, and scroll preservation.

## Purpose
Interactive PTY terminal within the dashboard. Users can type commands, view output, and interact with AI CLI sessions directly.

## Source Files
| File | Role |
|------|------|
| `src/hooks/useTerminal.ts` (~50KB, largest hook) | xterm lifecycle, dual transport, attach/detach, output buffering |
| `src/components/terminal/TerminalContainer.tsx` | Composes toolbar + xterm + bookmarks + fullscreen overlay |
| `src/components/terminal/TerminalToolbar.tsx` | Theme selector, buttons (ESC, paste, arrows, auto-scroll, bookmark, fork, mic/hold-to-speak, fullscreen, reconnect) |
| `src/components/terminal/themes.ts` | 7 named themes + auto theme from CSS variables |

## Implementation
- xterm config: JetBrains Mono, responsive font (11/12/14px), 5000 lines scrollback, bar cursor non-blinking, 200ms resize debounce
- Addons: FitAddon, Unicode11Addon (activeVersion '11'), WebLinksAddon
- Custom file path link provider: regex detection -> openFileInProject()
- Dual transport: isPtyHostTerminal() checks window.electronAPI?.hasPty. IPC: writePty/resizePty/subscribePty/**unsubscribePty**/onPtyData. WebSocket: terminal_input/terminal_resize/terminal_subscribe/terminal_disconnect/terminal_output
- Attach lifecycle: skip re-attach to same terminal, save scroll position, clear stale output, subscribe via transport, setupWhenReady (60 retries x 50ms, IntersectionObserver fallback), create xterm, load addons, register key handler, ResizeObserver, forceCanvasRepaint, flush buffered output, restore scroll, safety-net repaint at 150ms
- Detach lifecycle: save scroll offset to localStorage, clear batched output, **call `electronAPI.unsubscribePty(terminalId)`** for PTY-host terminals so the Electron main process stops streaming `pty:data` IPC for this session (for WS terminals, `terminal_disconnect` is already sent on the attach-of-next-terminal path). Then dispose the ResizeObserver and xterm instance.
- Output buffering: inactive terminals queue up to 500 items per terminal, stale buffers evicted after 60s, flushed on attach
- Batched output writes via requestAnimationFrame
- Scroll preservation: saved as "lines above bottom" to savedScrollRef on detach, restored on attach via pendingScrollRestore flag on ActiveTerminal — ensures saved offset survives the full setup/flush cycle regardless of when buffered data arrives. Guards on pendingScrollRestore in: ResizeObserver, safety-net repaint, handleTerminalReady, and active output handler. If no buffered data in double-RAF, pendingScrollRestore is left set for the active output handler with a 1s fallback timeout
- Auto-scroll mode: disabled by default, toggleable, scrollToBottom after RAF-batched writes
- Bookmarks: TerminalBookmark {id, terminalId, scrollLine, selectedText, note, timestamp, selStartX/Y, selEndX/Y}, persisted to localStorage per terminal
- Fork: POST /api/sessions/:id/fork with --continue --fork-session, only for Claude sessions. The forked command preserves the source session's `permissionMode` via `reconstructPermissionFlags` (e.g. `--dangerously-skip-permissions`, `--permission-mode auto-edit|full-auto`), so the child inherits the same permission posture. On success, the forked session is auto-selected and assigned to the same room as the source session (via `roomStore.addSession`)
- Paste: 3-strategy fallback (Clipboard API -> execCommand('paste') -> window.prompt), trailing newlines stripped, WS chunked 4KB with 5ms delays
- Canvas repaint workaround: RAF -> save scroll -> fit -> sendResize -> refresh -> restore scroll
- Fullscreen: reparent xterm to body portal, display toggle, toolbar duplicated, Alt+F11
- Custom keys: Escape -> \x1b, Shift+Enter -> \x1b\n, Cmd+Alt+1-9 passthrough, Cmd+V intercepted
- `useTerminal` exposes `readRecentText({ lines?, sinceAbsLine? }): { text, absBottom }` — reads plain text from `term.buffer.active`, strips control characters, collapses whitespace. Used by hold-to-speak TTS
- Hold-to-speak (TTS): when `settingsStore.ttsEnabled`, the toolbar shows a mic button and `TerminalContainer` installs a capture-phase `keydown`/`keyup`/`blur` listener. Holding **Space** while focus is inside the terminal wrapper (or pointer-holding the mic) calls `ttsEngine.speak(readRecentText(...))` with the last ~20 buffer lines, then polls every 1.2s for new lines via `readRecentText({ sinceAbsLine })`. Release/blur/disable calls `ttsEngine.stop()`. See [TTS Voice Output](../multimedia/tts-voice-output.md)

## Dependencies & Connections

### Depends On
- [WebSocket Client](./websocket-client.md) — terminal I/O relay (browser transport)
- [Electron IPC Transport](../electron/ipc-transport.md) — terminal I/O relay (desktop transport)
- [State Management](./state-management.md) — uiStore.openFileInProject for clickable paths
- [Server Terminal/SSH](../server/terminal-ssh.md) — server manages PTY processes

### Depended On By
- [Session Detail Panel](./session-detail-panel.md) — TerminalContainer in TERMINAL and COMMANDS tabs
- [File Browser](./file-browser.md) — clickable paths in terminal open files
- [TTS Voice Output](../multimedia/tts-voice-output.md) — consumes `readRecentText()` for hold-to-speak

### Shared Resources
- WebSocket for terminal relay, localStorage for theme + bookmarks + scroll position, document.body classes (terminal-focused, term-fullscreen)

## Change Risks
- Largest hook (50KB). Adding useState inside xterm callbacks causes stale closure bugs
- Breaking dual transport detection blocks terminal in one environment
- Changing scrollback from 5000 affects memory (~1MB per terminal)
- Canvas repaint workaround is fragile — removal causes blank terminals
- forceCanvasRepaint must not auto-scroll
- pendingScrollRestore on ActiveTerminal prevents race conditions during session switch — do not remove or the terminal will jump to top when switching sessions
- Skipping `unsubscribePty` on detach (Electron path) leaves the renderer receiving `pty:data` for terminals the user is no longer viewing. No correctness bug (data is just buffered in `pendingOutputRef`), but typing latency on the active terminal degrades proportionally to the number of background sessions — the original perf bug this path fixes.

## Floating Terminal Fork
TerminalContainer hosts the surface-agnostic SelectionPopup (xterm extractor)
and the "Translate previous answer" toolbar button when `originSessionId` is
set. See [Floating Terminal Fork](./floating-terminal-fork.md).

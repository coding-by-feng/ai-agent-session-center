# Shared UI Primitives

## Function — what it does

A small library of reusable, framework-agnostic React building blocks (`Modal`, `Select`, `Combobox`, `Tabs`, `Tooltip`, `ResizablePanel`, `ToastContainer`, `SearchInput`) plus two utility modules (`useClickOutside` hook, `format`/`tooltips` libs) that every other frontend feature composes from instead of re-implementing native widgets. They provide themed, accessible, viewport-aware replacements for native `<select>`, `<datalist>`, `<dialog>`, browser tooltips, and toast notifications.

## Purpose — why it exists

Native browser controls cannot be styled to match the dark-navy / neon-accent cyberdrome theme, are clipped by `overflow:hidden` / stacking contexts, and have inconsistent keyboard behavior across browsers and Electron. These primitives centralize the theming, ARIA roles, keyboard navigation, click-outside / Escape handling, portal-based positioning, debouncing, and localStorage persistence so that dozens of consumer components (settings panels, modals, toolbars, detail tabs, the file browser, the selection popup, the queue) stay visually and behaviorally consistent and DRY. `tooltips.ts` further centralizes all icon-button hover copy so wording is consistent and editable in one place.

## Source Files

| File | Role |
|------|------|
| `src/components/ui/Modal.tsx` | Overlay dialog driven by `uiStore.activeModal`; ESC-to-close, focus trap, overlay-click close. |
| `src/components/ui/Select.tsx` | Custom styled `<select>` replacement with keyboard nav, click-outside, and auto-flip-up. |
| `src/components/ui/Combobox.tsx` | Filterable dropdown input (replaces HTML5 `<datalist>`): arrow shows all, typing filters. |
| `src/components/ui/Tabs.tsx` | Headless tab strip + panel switcher with inline-style fallbacks and class overrides. |
| `src/components/ui/Tooltip.tsx` | Themed hover/focus tooltip rendered via portal with viewport-aware placement flipping. |
| `src/components/ui/ResizablePanel.tsx` | Drag-to-resize side panel with per-tab + global width persistence and fullscreen mode. |
| `src/components/ui/ToastContainer.tsx` | Module-level toast bus (`showToast`) + auto-dismissing notification renderer. |
| `src/components/ui/SearchInput.tsx` | Debounced search box with clear button and controlled/uncontrolled value support. |
| `src/hooks/useClickOutside.ts` | Reusable hook: invoke a handler on `mousedown` outside a referenced element. |
| `src/lib/format.ts` | Pure formatting helpers: `formatDuration`, `escapeHtml`, `getSourceLabel`, `getStatusLabel`. |
| `src/lib/tooltips.ts` | Centralized tooltip copy registry (`tooltips`, `TooltipCopy`, `TooltipKey`) for icon buttons. |

CSS modules: `Modal.module.css` (also used by `ToastContainer`), `Select.module.css`, `Combobox.module.css`, `Tooltip.module.css`, `DetailPanel.module.css` (used by `ResizablePanel`).

## Implementation

### Modal (`Modal.tsx`)

- **State source**: not local — reads `activeModal` / `closeModal` from `uiStore` (`src/stores/uiStore.ts`). `isOpen = activeModal === modalId`. Open is triggered elsewhere via `uiStore.openModal(modalId)` (`openModal: (id) => set({ activeModal: id })`, `closeModal: () => set({ activeModal: null })`). Only one modal can be open at a time (single `activeModal` string).
- **Props**: `modalId` (string, required), `children`, `title?`, `onClose?`, `panelClassName?`.
- **Refs**: `overlayRef`, `contentRef`.
- **Flows**:
  1. ESC keydown (while open) → `e.stopPropagation()` → `handleClose()` (= `closeModal()` then `onClose?.()`).
  2. Focus trap: on open, query `contentRef` for focusable elements (`button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])`), focus the first, and Tab/Shift+Tab cycle within the list.
  3. Overlay click: closes only when `e.target === overlayRef.current` (clicks inside the panel do not close).
- **UI**: overlay `div` (`styles.overlay`), panel `div` with `role="dialog"`, `aria-modal="true"`, `aria-label={title}`. Optional header `<h3>{title}</h3>` + close button (`styles.closeBtn`, label `x`, `aria-label="Close"`).

### Select (`Select.tsx`)

- **Exported type**: `SelectOption = { value: string; label: string }`.
- **Props**: `value`, `onChange`, `options: SelectOption[]`, `placeholder?`, `className?`, `style?`, `title?`.
- **State**: `isOpen`, `highlightedIndex`, `flipUp`. Refs: `wrapperRef`, `listRef`, `triggerRef`.
- **Constants/values**: flip-up threshold — `setFlipUp(spaceBelow < 220 && rect.top > 220)` (220px below the trigger and 220px available above).
- **Flows**:
  1. `selectedLabel` memoized from matching option (`' '` non-breaking space rendered if empty and no placeholder).
  2. Click-outside (own `mousedown` listener) closes when open.
  3. On open: highlight set to index of current value (or 0). `checkFlip()` runs before open to decide upward rendering.
  4. Keyboard: ArrowDown/ArrowUp navigate (wrap-around), Enter / Space select highlighted (or open if closed), Escape closes + refocuses trigger + `stopPropagation`, Tab closes.
  5. `handleSelect` calls `onChange`, closes, refocuses trigger.
- **UI**: trigger `<button role="combobox" aria-haspopup="listbox" aria-expanded aria-activedescendant>` with caret `▾`. Dropdown `<ul role="listbox">` (`styles.dropdownUp` when `flipUp`); items `<li role="option" id="sel-item-{i}">` with `itemHighlighted` / `itemSelected` classes; `onMouseDown` preventDefault + select, `onMouseEnter` highlights.

### Combobox (`Combobox.tsx`)

- **Props**: `value`, `onChange`, `items: string[]`, `placeholder?`, `className?`.
- **State**: `isOpen`, `highlightedIndex`, `showAll`. Refs: `wrapperRef`, `listRef`, `inputRef`.
- **Filtering**: `visibleItems` = all items if `showAll` or empty value, else case-insensitive substring match (`item.toLowerCase().includes(value.trim().toLowerCase())`).
- **Flows**:
  1. Arrow button → toggles open; opening sets `showAll=true` and focuses input (shows full list).
  2. Typing → `onChange`, sets `showAll=false` (re-enables filtering), opens if closed.
  3. Keyboard: ArrowDown/Up (open + `showAll`, wrap-around highlight), Enter selects highlighted, Escape closes + `stopPropagation`.
  4. Highlight reset to -1 on `visibleItems` change; highlighted item scrolled into view within the dropdown only.
- **UI**: `<input role="combobox" aria-expanded aria-autocomplete="list" aria-activedescendant>` + arrow `<button ▾ aria-label="Toggle dropdown" tabIndex=-1>`. Dropdown `<ul role="listbox">` with `<li id="cb-item-{i}" role="option">`; empty state renders `No matches`.

### Tabs (`Tabs.tsx`)

- **Type**: `Tab = { id: string; label: string; content: ReactNode }`.
- **Props**: `tabs: Tab[]`, `activeTab`, `onTabChange(tabId)`, plus optional class overrides: `containerClassName`, `panelClassName`, `tabListClassName`, `tabClassName`, `activeTabClassName`.
- **Behavior**: renders `<div role="tablist">` of `<button role="tab" aria-selected>` buttons; the panel `<div role="tabpanel">` renders `tabs.find(t => t.id === activeTab)?.content`. When class overrides are absent, falls back to inline styles using theme CSS variables (`--accent-cyan #00e5ff`, `--text-secondary #8888aa`, `--border-subtle`, `--bg-accent`, `--font-mono`).

### Tooltip (`Tooltip.tsx`)

- **Exported type**: `TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'`.
- **Props**: `label` (required), `description?`, `shortcut?`, `placement?` (default `'top'`), `delay?` (default `350` ms), `children`, `disabled?`.
- **Constants**: `VIEWPORT_PAD = 8`, `GAP = 8`.
- **Positioning (`computePosition`)**: tries `[preferred, opposite, ...perpendicular]` and picks the first side that fits within the viewport (with `VIEWPORT_PAD`/`GAP`); falls back to preferred. Final `left`/`top` are clamped into the viewport.
- **Flows**: hover/focus on the wrapping `<span>` → `show()` starts a `delay`-ms timer → `setOpen(true)`. `useLayoutEffect` measures trigger + tooltip rects and recomputes position. Hides on `scroll` (capture), `resize`, Escape keydown, mouseleave/blur. Pending timer cleared on unmount.
- **UI**: trigger `<span>` with `aria-describedby`. Tooltip rendered via `createPortal(..., document.body)` so it is never clipped: `<div role="tooltip" class={styles.tooltip styles.placement_{side}}>` containing `styles.label`, optional `styles.description`, optional `styles.shortcut` (`<kbd>`), and an `styles.arrow` span. Initial offscreen position `{left: -9999, top: -9999}` before measurement.

### ResizablePanel (`ResizablePanel.tsx`)

- **Storage key**: `STORAGE_KEY = 'detail-panel-width'`. Per-tab variant: `detail-panel-width:{activeTab}` (e.g. `detail-panel-width:terminal`, `detail-panel-width:project`).
- **Props**: `children`, `initialWidth?` (400), `minWidth?` (280), `maxWidth?` (800), `side?` (`'left' | 'right'`, default `'right'`), `className?`, `activeTab?`, `fullscreen?` (false).
- **`loadSavedWidth(fallback, min, max, tabKey?)`**: tries `localStorage[detail-panel-width:{tabKey}]` first, then global `detail-panel-width`; clamps to `[min,max]`; falls back to `initialWidth`. Wrapped in try/catch (ignores storage errors).
- **Flows**:
  1. Initial width loaded into `savedWidth` ref via `loadSavedWidth`.
  2. When `activeTab` changes, restores that tab's saved width by setting `panel.style.width`.
  3. Drag: `handleMouseDown` records `startX`/`startWidth`, sets `document.body.cursor='col-resize'` and `userSelect='none'`; `onMouseMove` computes delta by `side` (right: `startX - clientX`, left: `clientX - startX`), clamps to `[minWidth,maxWidth]`; `onMouseUp` persists the rounded final width to both global and per-tab keys.
- **UI**: panel `div` (`styles.panel`, `styles.resizing`, `styles.panelFullscreen`); resize handle `div` (`styles.resizeHandle` + `styles.active`) positioned at `-3px` on the inner edge; handle hidden when `fullscreen`.

### ToastContainer (`ToastContainer.tsx`)

- **Type**: `Toast = { id; message; type: 'info'|'success'|'error'|'warning'; duration }`.
- **Constant**: `DEFAULT_DURATION = 3000` ms.
- **Bus**: module-level `Set<ToastListener>`. Exported `showToast(message, type='info', duration=3000)` builds a toast (`id = ${Date.now()}-${random base36}`) and notifies all listeners — callable from anywhere (stores, hooks, non-React code).
- **Color map (`typeMap`)**: `info → --accent-cyan #00e5ff`, `success → --accent-green #00ff88`, `error → --accent-red #ff3355`, `warning → --accent-orange #ff9100` (applied as `borderColor`).
- **Flows**: the mounted container registers `addToast` as a listener on mount (removes on unmount); each toast schedules a `setTimeout(duration)` to filter itself out; returns `null` when no toasts. Renders `styles.toastContainer` with `styles.toast` (border colored by type) + `styles.toastMsg`.
- **Consumers of `showToast`**: WorkdirLauncher, Header, QuickSessionModal/NewSessionModal, NotesTab, QueueTab/QueueHistorySheet, AlertModal, KillConfirmModal, SummarizeModal, ProjectTab, SessionControlBar, HistoryView, QueueView, `useGlobalQueueScheduler`, `useKeyboardShortcuts`, WorkspaceLoadingOverlay.

### SearchInput (`SearchInput.tsx`)

- **Props**: `value?` (controlled), `onChange`, `placeholder?` (`'Search...'`), `debounceMs?` (300), `className?`, `inputClassName?`.
- **State**: local `localValue` (mirrors controlled value via effect), `timerRef` for debounce.
- **Flows**: typing updates `localValue` immediately and debounces `onChange` by `debounceMs`; clear button resets to `''`, clears the timer, and fires `onChange('')` synchronously; timer cleared on unmount.
- **UI**: text input with `data-search-input` attribute (focus target for keyboard shortcuts) and inline-style fallback (theme vars). Clear `<button x aria-label="Clear search">` shown only when `localValue` is non-empty.

### useClickOutside (`useClickOutside.ts`)

- **Signature**: `useClickOutside(ref: RefObject<HTMLElement|null>, handler: () => void, enabled = true)`.
- Adds a `document` `mousedown` listener (when `enabled`) that calls `handler()` if the click target is outside `ref.current`. (Note: `Modal`, `Select`, and `Combobox` each implement their own inline click-outside/ESC logic rather than this hook.)

### format (`format.ts`)

- `formatDuration(ms)`: returns `''` for falsy/NaN/negative; else `Xh Ym` / `Xm Ys` / `Xs`.
- `escapeHtml(str)`: escapes `& < > " '` (last → `&#39;`).
- `getSourceLabel(source)`: maps editor/terminal source IDs via `SOURCE_LABELS` (`vscode→VS Code`, `jetbrains→JetBrains`, `iterm→iTerm`, `warp→Warp`, `kitty→Kitty`, `ghostty→Ghostty`, `alacritty→Alacritty`, `wezterm→WezTerm`, `hyper→Hyper`, `terminal→Terminal`, `tmux→tmux`); falls back to the raw value.
- `getStatusLabel(status)`: `ended→DISCONNECTED`, `approval→APPROVAL NEEDED`, `input→WAITING FOR INPUT`, `waiting→WAITING`, else `status.toUpperCase()`.

### tooltips (`tooltips.ts`)

- **Types**: `TooltipCopy = { label; description?; shortcut? }`; `tooltips` is a `satisfies Record<string, TooltipCopy>` object; `TooltipKey = keyof typeof tooltips`.
- **Grouped registry** (keys) covering icon buttons across the app:
  - DetailTabs split/float/search: `mergeProjectTerminal`, `splitProjectTerminal`, `stackProjectTerminal`, `unstackProjectTerminal`, `floatProject`, `unfloatProject`, `searchPrev`, `searchNext`, `searchClose`.
  - FloatingProjectPanel: `floatMinimize`, `floatMaximize`, `floatRestore`, `floatClose`, `floatExpand`.
  - TerminalToolbar: `termTheme`, `termSendEsc`, `termPaste`, `termSendUp`, `termSendDown`, `termSendEnter`, `termScrollBottom`, `termRefresh`, `termNewSession`, `termFork`, `termSpeak`, `termReconnect`, `termAutoScrollOn`, `termAutoScrollOff`, `termBookmark`, `termClone`, `termFullscreen`, `termFullscreenExit`, `termThemePicker`.
  - Selection popup (translate/explain): `selExplainLearning`, `selExplainNative`, `selVocabNative`, `selTranslateLearning`, `selTranslateNative`, `selCustomPrompt`, `termTranslateAnswer`, `projTranslateFile`, `floatTerminalClose`.
  - ProjectTab toolbar: `projSearchFiles`, `projSearchContent`, `projFindInFile`, `projNewFile`, `projNewFolder`, `projOpenInTab`, `projOpenExternal`, `projRevealInFinder`, `projCopyPath`, `projFormat`, `projOutline`, `projBookmark`, `projWordWrap`, `projFullscreen`, `projCollapseAll`, `projRefresh`, `projCloseTab`, `projImageZoomOut`, `projImageZoomReset`, `projImageFit`, `projImageZoomIn`, `projFullscreenClose`, `projDeleteBookmark`, `projRemoveFromCollection`, `projMdEditEnter`, `projMdEditExit`, `projTexPreview`, `projTexSource`, `projCollectAdd`, `projCollectManage`, `projRecentFiles`.
  - SessionControlBar: `ctrlResume`, `ctrlKill`, `ctrlMute`, `ctrlUnmute`, `ctrlAlertOff`, `ctrlAlertOn`.
- Conventions (from the file header): label ≤ 4 words, description one sentence (≤ 120 chars). Entries include optional `shortcut` hints (e.g. `searchNext` → `Enter`, `projSearchContent` → `Cmd+F`, `termFullscreen` → `Alt+F11`).

## Dependencies & Connections

### Depends On

- [state-management.md](state-management.md) — `Modal` reads `activeModal` and `openModal`/`closeModal` from `uiStore`.
- React + ReactDOM (`createPortal` in `Tooltip`), CSS modules under `src/styles/modules/`.

### Depended On By

- [settings-system.md](settings-system.md) — `Select`, `Combobox`, `Tabs`, `Tooltip`, toasts across settings tabs.
- [session-detail-panel.md](session-detail-panel.md) — `ResizablePanel` (per-tab width), `Tabs`, `Tooltip` in detail tabs/control bar.
- [terminal-ui.md](terminal-ui.md) — `Tooltip` + `tooltips` registry for the terminal toolbar; `ResizablePanel` width.
- [file-browser.md](file-browser.md) — `SearchInput`, `Tooltip`/`tooltips` for the ProjectTab toolbar; `Modal` for dialogs.
- [project-browser.md](project-browser.md) — file search and toolbar tooltips.
- [session-creation-modals.md](session-creation-modals.md) — `Modal`, `Select`, `Combobox`, `showToast`.
- [prompt-queue.md](prompt-queue.md) / [queue-scheduler.md](queue-scheduler.md) — `Modal`, `Select`, toasts in queue UI and scheduler feedback.
- [keyboard-shortcuts.md](keyboard-shortcuts.md) — fires `showToast`; `data-search-input` is a focus target.
- [floating-terminal-fork.md](floating-terminal-fork.md) — `Tooltip` copy for fork/translate buttons; `FloatingProjectPanel` tooltips.
- [views-routing.md](views-routing.md) — `showToast` used across History/Queue views; `Tabs` for view headers.
- [summary-tab.md](summary-tab.md), [agenda.md](agenda.md), [setup-wizard.md](setup-wizard.md), [auth-ui.md](auth-ui.md) — assorted `Modal`/`Select`/`Tooltip`/toast usage.

### Shared Resources

- `uiStore.activeModal` (single-active-modal contract) — see [state-management.md](state-management.md).
- localStorage keys `detail-panel-width` and `detail-panel-width:{tab}` — see [client-persistence.md](client-persistence.md).
- Module-level `showToast` bus — global, callable from any module.
- Theme CSS variables (`--accent-cyan/green/red/orange`, `--text-*`, `--bg-*`, `--border-subtle`, `--font-mono`) shared with all visual components.

## Change Risks

- **uiStore modal contract**: `Modal` assumes a single `activeModal` string. Changing `uiStore` to allow stacked modals, or renaming `openModal`/`closeModal`, breaks every `Modal` consumer (NewSession/QuickSession modals, KillConfirm, Summarize, queue/loop modals).
- **`showToast` signature / bus**: it is imported widely and called from non-React code (stores, scheduler, shortcut hooks). Changing the argument order, the listener `Set` pattern, or `typeMap` colors affects all notification call sites and theming.
- **localStorage keys in ResizablePanel**: renaming `detail-panel-width` (or the `:{tab}` suffix scheme) silently resets saved panel widths and must be coordinated with client-persistence docs.
- **`tooltips` keys**: keys are referenced by string across toolbars (`TerminalToolbar`, `ProjectTab`, `SessionControlBar`, `SelectionPopup`, `DetailTabs`, `FloatingProjectPanel`). Removing/renaming a key removes its tooltip with no compile error at the call site unless callers use `TooltipKey`. Editing copy here changes hover text app-wide.
- **`SelectOption` / `Tab` shapes**: changing these exported interfaces ripples to every `Select` options array and `Tabs` config.
- **`format.ts` label maps**: `getStatusLabel` mirrors the session state machine; if a new status is added without an entry it falls through to `.toUpperCase()`. `getSourceLabel` must track new editor/terminal source IDs.
- **`data-search-input` attribute**: used as a keyboard-shortcut focus target; renaming it breaks focus-search shortcuts (see keyboard-shortcuts).
- **Portal/positioning in Tooltip**: changes to `VIEWPORT_PAD`/`GAP`/`computePosition` or the `document.body` portal affect tooltip placement everywhere; CSS class names (`placement_top` etc.) are coupled to `Tooltip.module.css`.

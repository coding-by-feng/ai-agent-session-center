/**
 * Centralized tooltip copy for all icon/action buttons in the detail-panel area.
 *
 * Each entry is { label, description?, shortcut? } and is consumed by the
 * <Tooltip> component. Keep label short (≤ 4 words). Description is one
 * sentence (≤ 120 chars) explaining what the action does and when to use it.
 */

export interface TooltipCopy {
  label: string;
  description?: string;
  shortcut?: string;
}

export const tooltips = {
  // ---- DetailTabs: split / float toggles + search ----
  mergeProjectTerminal: {
    label: 'Merge with Terminal',
    description: 'Show Terminal and Project side-by-side in this tab with a draggable divider.',
  },
  splitProjectTerminal: {
    label: 'Separate tabs',
    description: 'Stop the side-by-side view and return Terminal and Project to individual tabs.',
  },
  stackProjectTerminal: {
    label: 'Stack over Terminal',
    description: 'Show Terminal on top and Project below in this tab, split by a draggable horizontal divider.',
  },
  unstackProjectTerminal: {
    label: 'Separate tabs',
    description: 'Stop the stacked view and return Terminal and Project to individual tabs.',
  },
  floatProject: {
    label: 'Open Project in a window',
    description: 'Open the Project browser in its own OS window you can drag to another monitor.',
  },
  searchPrev: {
    label: 'Previous match',
    description: 'Jump to the previous search hit in the current tab.',
    shortcut: 'Shift+Enter',
  },
  searchNext: {
    label: 'Next match',
    description: 'Jump to the next search hit in the current tab.',
    shortcut: 'Enter',
  },
  searchClose: {
    label: 'Close search',
    description: 'Hide the search bar and clear the current query.',
    shortcut: 'Esc',
  },

  termPopOut: {
    label: 'Pop out to a window',
    description: 'Open this terminal in a separate window you can drag to another monitor.',
  },

  // ---- TerminalToolbar ----
  termTheme: {
    label: 'Terminal theme',
    description: 'Pick a color theme for this terminal. Per-session preference is remembered.',
  },
  termSendEsc: {
    label: 'Send Escape',
    description: 'Press the Esc key inside the terminal — useful to dismiss menus or cancel input.',
  },
  termPaste: {
    label: 'Paste from clipboard',
    description: 'Paste the system clipboard into the terminal at the cursor.',
  },
  termSendUp: {
    label: 'Send Up arrow',
    description: 'Step backward through the shell history without leaving the mouse.',
  },
  termSendDown: {
    label: 'Send Down arrow',
    description: 'Step forward through the shell history without leaving the mouse.',
  },
  termSendEnter: {
    label: 'Send Enter',
    description: 'Submit the current line in the terminal (equivalent to pressing Return).',
  },
  termScrollBottom: {
    label: 'Scroll to bottom',
    description: 'Jump to the latest output. New output keeps you pinned at the bottom from now on.',
  },
  termRefresh: {
    label: 'Refresh terminal',
    description: 'Clear the rendered buffer and replay the ring-buffer snapshot from the server.',
  },
  termNewSession: {
    label: 'New session like this',
    description: 'Start a new session reusing this session’s command, working directory, and config.',
  },
  termFork: {
    label: 'Fork this session',
    description: 'Create a new Claude session that branches from the current conversation history.',
  },
  termSpeak: {
    label: 'Speak latest output',
    description: 'Hold to read the most recent terminal output aloud via TTS. Hold Space when focused.',
  },
  termReconnect: {
    label: 'Reconnect terminal',
    description: 'Re-establish the PTY/SSH connection if it dropped. Buffer is restored on reconnect.',
  },
  termAutoScrollOn: {
    label: 'Auto-scroll on',
    description: 'Auto-scroll is enabled — output stays pinned to the bottom. Click to disable.',
  },
  termAutoScrollOff: {
    label: 'Auto-scroll off',
    description: 'Auto-scroll is disabled — your scroll position stays put. Click to re-enable.',
  },
  termBookmark: {
    label: 'Terminal bookmarks',
    description: 'Select text in the terminal first, then click to save it. Click again to open the bookmark panel.',
  },
  termClone: {
    label: 'Clone session',
    description: 'Start a new session reusing this command, working directory, and config.',
  },
  termFullscreen: {
    label: 'Fullscreen terminal',
    description: 'Maximize the terminal to take over the panel.',
    shortcut: 'Alt+F11',
  },
  termFullscreenExit: {
    label: 'Exit fullscreen',
    description: 'Return the terminal to its normal size.',
    shortcut: 'Alt+F11',
  },
  termThemePicker: {
    label: 'Terminal theme',
    description: 'Pick a color theme for this terminal. The choice is remembered per session.',
  },

  // ---- Selection popup (translate / explain) ----
  selExplainLearning: {
    label: 'Explain (learning language)',
    description: 'Open a forked session that explains the selected text in your learning language. Same language — deeper unpacking.',
  },
  selExplainNative: {
    label: 'Explain (native language)',
    description: 'Open a forked session that explains the selected text in your native language. Use when there\'s a language gap.',
  },
  selVocabNative: {
    label: 'Vocabulary (native language)',
    description: 'Open a session that explains the selected word or phrase as a dictionary entry in your native language — part of speech, definition, examples, synonyms, and its meaning in context.',
  },
  selTranslateLearning: {
    label: 'Translate (learning language)',
    description: 'Direct translation of the selection into your learning language. No explanation, no commentary — just the equivalent text.',
  },
  selTranslateNative: {
    label: 'Translate (native language)',
    description: 'Direct translation of the selection into your native language. No explanation, no commentary — just the equivalent text.',
  },
  selCustomPrompt: {
    label: 'Custom prompt',
    description: 'Type your own instruction; it\'s combined with the selected text to start a fresh floating session. Enter or ⌘/Ctrl+Enter to run.',
  },
  floatTerminalClose: {
    label: 'Close floating session',
    description: 'Close this floating terminal. The underlying session is killed.',
  },

  // ---- ProjectTab toolbar ----
  projSearchFiles: {
    label: 'Search files by name',
    description: 'Fuzzy-search for files in this project by filename.',
  },
  projSearchContent: {
    label: 'Search file contents',
    description: 'Search inside files for text matches across the project.',
    shortcut: 'Cmd+F',
  },
  projFindInFile: {
    label: 'Find in current file',
    description: 'Search inside the file open in the viewer.',
    shortcut: 'Cmd+F',
  },
  projNewFile: {
    label: 'New file',
    description: 'Create a new empty file in the currently selected folder.',
  },
  projNewFolder: {
    label: 'New folder',
    description: 'Create a new folder in the currently selected folder.',
  },
  projOpenInTab: {
    label: 'Open project in new tab',
    description: 'Open the project root in the standalone Project Browser view.',
  },
  projOpenExternal: {
    label: 'Open external path',
    description: 'Browse a directory outside this project (e.g. ~/.config/…) without changing the project root.',
  },
  projRevealInFinder: {
    label: 'Reveal in Finder',
    description: 'Show the current file or folder in the OS file manager.',
  },
  projCopyPath: {
    label: 'Copy file path',
    description: 'Copy the absolute path of the current file to the clipboard.',
  },
  projFormat: {
    label: 'Format file',
    description: 'Pretty-print JSON or XML in the current file viewer.',
  },
  projOutline: {
    label: 'Markdown outline',
    description: 'Toggle the heading outline for the current Markdown file.',
  },
  projWordWrap: {
    label: 'Word wrap',
    description: 'Wrap long lines in the file viewer instead of horizontal scrolling.',
  },
  projFullscreen: {
    label: 'Open fullscreen',
    description: 'Open the current file in a distraction-free fullscreen viewer.',
  },
  projCollapseAll: {
    label: 'Collapse all',
    description: 'Collapse every expanded folder in the file tree.',
  },
  projRefresh: {
    label: 'Refresh',
    description: 'Re-scan the file tree and reload the open file from disk.',
  },
  projCloseTab: {
    label: 'Close tab',
    description: 'Close this file tab. Unsaved edits are discarded.',
  },
  projImageZoomOut: {
    label: 'Zoom out',
    description: 'Decrease zoom on the current image.',
    shortcut: '−',
  },
  projImageZoomReset: {
    label: 'Reset zoom',
    description: 'Restore the image to 100% size.',
    shortcut: '0',
  },
  projImageFit: {
    label: 'Fit to screen',
    description: 'Scale the image so the whole frame fits the viewer.',
    shortcut: 'F',
  },
  projImageZoomIn: {
    label: 'Zoom in',
    description: 'Increase zoom on the current image.',
    shortcut: '+',
  },
  projFullscreenClose: {
    label: 'Close fullscreen',
    description: 'Exit the fullscreen viewer.',
    shortcut: 'Esc',
  },
  projMdEditEnter: {
    label: 'Edit markdown',
    description: 'Switch the current Markdown file into inline edit mode. Save with Cmd+S.',
  },
  projMdEditExit: {
    label: 'Exit edit mode',
    description: 'Discard unsaved edits and return to the rendered preview.',
  },

  // ---- SessionControlBar ----
  ctrlResume: {
    label: 'Resume session',
    description: 'Re-attach to a disconnected session — replays history and restores the working dir.',
  },
  ctrlKill: {
    label: 'Kill session',
    description: 'Terminate the underlying process and close this session. Cannot be undone.',
  },
  ctrlMute: {
    label: 'Mute session',
    description: 'Silence sound alerts for this session only.',
  },
  ctrlUnmute: {
    label: 'Unmute session',
    description: 'Re-enable sound alerts for this session.',
  },
  ctrlAlertOff: {
    label: 'Enable alerts',
    description: 'Get sound + visual alerts when this session needs your attention (idle, approval, finished).',
  },
  ctrlAlertOn: {
    label: 'Disable alerts',
    description: 'Stop alerting for this session’s state changes.',
  },
} satisfies Record<string, TooltipCopy>;

export type TooltipKey = keyof typeof tooltips;

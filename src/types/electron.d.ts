// src/types/electron.d.ts
// Shared IPC contract between Electron main process and React renderer.
// Both electron-main (IPC handlers) and frontend (wizard UI) implement against this.

export interface DepCheckResult {
  ok: boolean
  version?: string
  hint?: string
}

export interface SetupConfig {
  port: number
  enabledClis: ('claude' | 'codex')[]
  hookDensity: 'high' | 'medium' | 'low'
  debug: boolean
  sessionHistoryHours: number
  passwordHash?: string
  /**
   * Plaintext, write-only, and never persisted: `setup:save-config` hashes it
   * in the main process (scrypt is Node-crypto-only, so the renderer cannot
   * produce a hash `verifyPassword` would accept) and stores the result as
   * `passwordHash`. Present on the payload sent TO the IPC, never on the
   * config read back out.
   */
  password?: string
}

export interface InstallResult {
  ok: boolean
  error?: string
}

/** Mirrors `UpdateState` in electron/autoUpdateRules.ts. */
export interface AppUpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  error?: string
  autoCheck: boolean
}

export interface AppUpdatesAPI {
  getState(): Promise<AppUpdateState>
  /** Check now and show the result in a dialog (like the app menu's Check for Updates…). */
  check(): Promise<void>
  /** Ask to restart and install a downloaded update; Later leaves it for the next quit. */
  install(): Promise<void>
  onState(cb: (state: AppUpdateState) => void): () => void
}

export interface ElectronAPI {
  platform: 'darwin' | 'win32'

  // Setup wizard IPC
  isSetup():          Promise<boolean>
  checkDeps():        Promise<Record<string, DepCheckResult>>
  saveConfig(cfg: SetupConfig): Promise<{ ok: boolean }>
  installHooks(cfg: Pick<SetupConfig, 'hookDensity' | 'enabledClis'>): Promise<InstallResult>
  completeSetup():    Promise<{ ok: boolean; port: number }>
  onInstallLog(cb: (line: string) => void): () => void

  // Dashboard IPC
  getPort():          Promise<number>
  openInBrowser():    void
  rerunSetup():       void

  // Lifecycle IPC
  onBeforeClose(cb: () => Promise<void>): () => void
  closeReady():       void
  quitApp():          void

  // Pop a floating terminal out into its own native window (draggable to another
  // monitor). Optional — only present under Electron.
  openTerminalWindow?(opts: { terminalId: string; originSessionId?: string; label?: string }): Promise<{ ok: boolean }>
  // Open the PROJECT tab in its own native window (draggable to another monitor)
  // on the standalone /project-browser route. Electron-only; de-duped by path.
  openProjectWindow?(opts: { path: string; file?: string; label?: string }): Promise<{ ok: boolean }>
  /** Fires (in the main window) when a popped-out terminal window is closed, so
   *  the in-app float can re-dock. Returns an unsubscribe fn. */
  onPopoutClosed?(cb: (terminalId: string) => void): () => void

  /** Pop one session's QUEUE panel out into its own native window, draggable to
   *  another monitor, on the standalone `?popout=queue` view. The docked panel is
   *  left alone (both stay live). De-duped by sessionId. Electron-only. */
  openQueueWindow?(opts: { sessionId: string; label?: string }): Promise<{ ok: boolean }>

  /** Pop a whole session (all DetailTabs — Project/Terminal/Commands/Conversation/
   *  AI Popups/Notes/Queue) out into its own native window, draggable to another
   *  monitor. De-duped by sessionId. Electron-only. */
  openSessionWindow?(opts: { sessionId: string; label?: string }): Promise<{ ok: boolean }>
  /** Called FROM a popped-out session window: focuses the main window, tells it
   *  to return to the session list (deselects the session), then closes the
   *  calling popout. Electron-only. */
  returnToMain?(): Promise<{ ok: boolean }>
  /** Fires (in the main window) when a popped-out session's `returnToMain` runs,
   *  so the main window can deselect back to the session list. Returns an
   *  unsubscribe fn. Electron-only. */
  onReturnToList?(cb: () => void): () => void

  /** Show a system notification for one session (Nov 8 2026: a "proceed" owed). Clicking it brings the
   *  main window forward and fires `onOpenSession` there. Main window only; Electron-only. */
  notify?(notice: { sessionId: string; title: string; body: string }): Promise<{ ok: boolean }>
  /** Fires (in the main window) when one of its notifications is clicked. Returns an unsubscribe fn. */
  onOpenSession?(cb: (sessionId: string) => void): () => void

  /** Open the native OS folder picker and resolve to the chosen absolute
   *  directory path, or null if the user cancelled. Electron-only — the browser
   *  sandbox can't return an absolute path, so this is undefined there. */
  selectDirectory?(opts?: { defaultPath?: string }): Promise<string | null>

  /** Remote computers: other AASC desktops this app is paired with (Oct 28 2026). Electron-only. */
  remotes?: RemoteComputersAPI

  /** Mac auto-update (electron/autoUpdate.ts). Present in every desktop window; only a packaged Mac app
   *  ever leaves `idle`. */
  updates?: AppUpdatesAPI
  /** A Client's home page only: the app brought this window back on screen. Returns how to stop listening. */
  onHomeShown?: (listener: () => void) => () => void
}

/** One paired remote AASC, as the local UI sees it. Never its device token. */
export interface RemoteComputer {
  id: string
  /** The remote's name from its pairing link (its hostname). */
  name: string
  /** Private home-network address from the link, or null. */
  lan: string | null
  /** Tailscale address: from the link, or later from the remote's signed /paths answer. */
  tailnet: string | null
  /** A public IPv4 from the link's `pub=` (Oct 28 2026), reached over plain HTTP; absent when none. */
  publicAddress?: string
  httpsOrigin?: string
  port: number
  /** pending: waiting for Allow on the remote; active: allowed; revoked: the remote removed it. */
  status: 'pending' | 'active' | 'revoked'
  /** While pending: the 6-digit code the remote shows beside its Allow button. */
  confirmCode: string | null
  addedAt: number
  /** Last time a sign-in succeeded (ms), or null. */
  lastSeenAt: number | null
}

/** A remote's live state from `check`. */
export interface RemoteComputerCheck {
  /** online: signed in; pending: reachable, not allowed yet; revoked; offline: no address answered. */
  state: 'online' | 'pending' | 'revoked' | 'offline'
  /** The address that answered: 'lan', 'tailnet' or 'public' (unencrypted, over the Internet). */
  via: 'lan' | 'tailnet' | 'public' | 'https' | null
  /** Sessions the remote shares (GET /api/sessions), when online. */
  sharedSessions: number | null
  /** A short reason when offline or refused. */
  message: string | null
}

export type RemoteResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface RemoteComputersAPI {
  list(): Promise<RemoteComputer[]>
  /** Pair from the link the remote's devices panel shows (https://aasc.work/pair#…); `label` is this computer's name there. */
  add(link: string): Promise<RemoteResult<RemoteComputer>>
  /** Sign in (or ask while pending) and report; updates status, tailnet and lastSeenAt. With its window open and signed in, asks with that window's session and updates nothing. */
  check(id: string): Promise<RemoteResult<RemoteComputerCheck>>
  /** Sign in and open the remote's own UI in its own window. */
  open(id: string): Promise<RemoteResult<null>>
  /** Unpair on the remote when it answers, then forget it here either way. */
  remove(id: string): Promise<RemoteResult<{ unpairedRemotely: boolean }>>
  rename(id: string, name: string): Promise<RemoteResult<RemoteComputer>>
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

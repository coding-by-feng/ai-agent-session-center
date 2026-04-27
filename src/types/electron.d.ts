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
  enabledClis: ('claude' | 'gemini' | 'codex')[]
  hookDensity: 'high' | 'medium' | 'low'
  debug: boolean
  sessionHistoryHours: number
  passwordHash?: string
}

export interface InstallResult {
  ok: boolean
  error?: string
}

export interface PtyCreateConfig {
  workingDir?: string
  command?: string
  label?: string
  sessionTitle?: string
  apiKey?: string
  enableOpsTerminal?: boolean
  /** Effort level to auto-apply after Claude Code starts (min/low/medium/high/max) */
  effortLevel?: string
  /** Model to auto-apply after Claude Code starts (opus/sonnet/haiku) */
  model?: string
}

export interface PtyCreateResult {
  ok: boolean
  terminalId?: string
  error?: string
}

export interface PtySubscribeResult {
  ok: boolean
  buffer?: string | null
  error?: string
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

  // PTY terminal IPC (VS Code-style direct PTY management)
  // Optional — only available when Electron ptyHost is active
  createPty?(config: PtyCreateConfig):                    Promise<PtyCreateResult>
  writePty?(terminalId: string, data: string):            void
  resizePty?(terminalId: string, cols: number, rows: number): void
  killPty?(terminalId: string):                           Promise<{ ok: boolean }>
  subscribePty?(terminalId: string):                      Promise<PtySubscribeResult>
  unsubscribePty?(terminalId: string):                    void
  hasPty?(terminalId: string):                            Promise<boolean>
  onPtyData?(cb: (terminalId: string, base64Data: string) => void): () => void
  onPtyExit?(cb: (terminalId: string, exitCode: number, signal: number) => void): () => void
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

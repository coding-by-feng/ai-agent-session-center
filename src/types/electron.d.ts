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
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

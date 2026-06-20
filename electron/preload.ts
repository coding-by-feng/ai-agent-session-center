import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI } from '../src/types/electron.js'

const api: ElectronAPI = {
  platform: process.platform as 'darwin' | 'win32',

  // Setup wizard IPC
  isSetup:       ()    => ipcRenderer.invoke('setup:is-complete'),
  checkDeps:     ()    => ipcRenderer.invoke('setup:check-deps'),
  saveConfig:    (cfg) => ipcRenderer.invoke('setup:save-config', cfg),
  installHooks:  (cfg) => ipcRenderer.invoke('setup:install-hooks', cfg),
  completeSetup: ()    => ipcRenderer.invoke('setup:complete'),
  onInstallLog:  (cb)  => {
    const handler = (_: unknown, line: string) => cb(line)
    ipcRenderer.on('setup:install-log', handler)
    return () => { ipcRenderer.removeListener('setup:install-log', handler) }
  },

  // Dashboard IPC
  getPort:       ()    => ipcRenderer.invoke('app:get-port'),
  openInBrowser: ()    => { ipcRenderer.invoke('app:open-browser') },
  rerunSetup:    ()    => { ipcRenderer.invoke('app:rerun-setup') },

  // Native OS folder picker (used by the session-creation modals)
  selectDirectory: (opts) => ipcRenderer.invoke('dialog:select-directory', opts),

  // Lifecycle IPC
  onBeforeClose: (cb) => {
    const handler = async () => {
      await cb()
      ipcRenderer.send('app:close-ready')
    }
    ipcRenderer.on('app:before-close', handler)
    return () => { ipcRenderer.removeListener('app:before-close', handler) }
  },
  closeReady: () => { ipcRenderer.send('app:close-ready') },
  quitApp:    () => { ipcRenderer.invoke('app:quit') },

  // ── PTY terminal IPC (VS Code-style direct PTY management) ──
  createPty: (config) => ipcRenderer.invoke('pty:create', config),

  writePty: (terminalId, data) => {
    ipcRenderer.send('pty:write', terminalId, data)
  },

  resizePty: (terminalId, cols, rows) => {
    ipcRenderer.send('pty:resize', terminalId, cols, rows)
  },

  killPty: (terminalId) => ipcRenderer.invoke('pty:kill', terminalId),

  subscribePty: (terminalId) => ipcRenderer.invoke('pty:subscribe', terminalId),

  unsubscribePty: (terminalId) => {
    ipcRenderer.send('pty:unsubscribe', terminalId)
  },

  hasPty: (terminalId) => ipcRenderer.invoke('pty:has', terminalId),

  onPtyData: (cb) => {
    const handler = (_: unknown, terminalId: string, base64Data: string) =>
      cb(terminalId, base64Data)
    ipcRenderer.on('pty:data', handler)
    return () => { ipcRenderer.removeListener('pty:data', handler) }
  },

  onPtyExit: (cb) => {
    const handler = (_: unknown, terminalId: string, exitCode: number, signal: number) =>
      cb(terminalId, exitCode, signal)
    ipcRenderer.on('pty:exit', handler)
    return () => { ipcRenderer.removeListener('pty:exit', handler) }
  },

  // ── Pop-out floating terminal window ──
  openTerminalWindow: (opts) => ipcRenderer.invoke('window:open-terminal', opts),

  // ── Pop-out floating project panel into its own window ──
  openProjectWindow: (opts) => ipcRenderer.invoke('window:open-project', opts),

  onPopoutClosed: (cb) => {
    const handler = (_: unknown, terminalId: string) => cb(terminalId)
    ipcRenderer.on('popout:closed', handler)
    return () => { ipcRenderer.removeListener('popout:closed', handler) }
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)

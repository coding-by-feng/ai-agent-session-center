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
}

contextBridge.exposeInMainWorld('electronAPI', api)

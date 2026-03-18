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
}

contextBridge.exposeInMainWorld('electronAPI', api)

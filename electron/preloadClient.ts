/**
 * preloadClient.ts — what a Client edition's home page may reach: its paired computers and nothing else. A Client has
 * no PTY host, folder picker or setup handlers, so the full preload's methods would only fail. A remote's window gets
 * no preload at all (remote/remoteWindow.ts).
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  remotes: {
    list:   ()                       => ipcRenderer.invoke('remote:list'),
    add:    (link: string)           => ipcRenderer.invoke('remote:add', link),
    check:  (id: string)             => ipcRenderer.invoke('remote:check', id),
    open:   (id: string)             => ipcRenderer.invoke('remote:open', id),
    remove: (id: string)             => ipcRenderer.invoke('remote:remove', id),
    rename: (id: string, name: string) => ipcRenderer.invoke('remote:rename', id, name),
  },
  onHomeShown: (listener: () => void) => {
    // Never the listener itself: IPC would hand it an event that reaches the main process.
    const forward = () => listener()
    ipcRenderer.on('client:home-shown', forward)
    return () => { ipcRenderer.removeListener('client:home-shown', forward) }
  },
})

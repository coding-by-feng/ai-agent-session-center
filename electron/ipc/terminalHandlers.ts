/**
 * terminalHandlers.ts — Electron IPC handlers for PTY terminal management.
 *
 * Bridges the renderer process to ptyHost.ts via Electron IPC, following
 * the VS Code pattern where terminal I/O goes through IPC rather than
 * WebSocket.
 */

import { ipcMain } from 'electron'
import {
  createPty,
  writePty,
  resizePty,
  killPty,
  getOutputBuffer,
  hasPty,
  listPtys,
} from '../ptyHost.js'

export function registerTerminalHandlers(): void {
  // Create a new local PTY terminal
  ipcMain.handle('pty:create', (_, config: {
    workingDir?: string
    command?: string
    label?: string
    sessionTitle?: string
    apiKey?: string
    enableOpsTerminal?: boolean
    effortLevel?: string
  }) => {
    try {
      const terminalId = createPty(config)
      return { ok: true, terminalId }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    }
  })

  // Write data to a PTY's stdin
  ipcMain.on('pty:write', (_, terminalId: string, data: string) => {
    writePty(terminalId, data)
  })

  // Resize a PTY
  ipcMain.on('pty:resize', (_, terminalId: string, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) {
      resizePty(terminalId, cols, rows)
    }
  })

  // Kill a PTY
  ipcMain.handle('pty:kill', (_, terminalId: string) => {
    killPty(terminalId)
    return { ok: true }
  })

  // Subscribe to a PTY — returns buffered output for replay
  ipcMain.handle('pty:subscribe', (_, terminalId: string) => {
    if (!hasPty(terminalId)) {
      return { ok: false, error: 'Terminal not found' }
    }
    const buffer = getOutputBuffer(terminalId)
    return { ok: true, buffer }
  })

  // Check if a terminal is managed by ptyHost
  ipcMain.handle('pty:has', (_, terminalId: string) => {
    return hasPty(terminalId)
  })

  // List all active PTY terminals
  ipcMain.handle('pty:list', () => {
    return listPtys()
  })
}

import { ipcMain, shell, app } from 'electron'
import { existsSync, unlinkSync } from 'fs'
import path from 'path'

const SETUP_FLAG = path.join(app.getPath('userData'), 'setup.json')

export function registerAppHandlers() {
  ipcMain.handle('app:get-port', () => {
    return Number(process.env.SERVER_PORT ?? 3333)
  })

  ipcMain.handle('app:open-browser', () => {
    const port = parseInt(process.env.SERVER_PORT ?? '3333', 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return
    shell.openExternal(`http://localhost:${port}`)
  })

  ipcMain.handle('app:rerun-setup', async () => {
    // Delete setup flag so next launch triggers wizard
    if (existsSync(SETUP_FLAG)) unlinkSync(SETUP_FLAG)
    app.relaunch()
    app.exit(0)
  })
}

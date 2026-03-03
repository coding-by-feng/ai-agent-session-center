import { Tray, Menu, app, BrowserWindow, nativeImage, shell } from 'electron'
import path from 'path'

export function setupTray(win: BrowserWindow) {
  const iconName = process.platform === 'win32' ? 'tray.ico' : 'tray.png'
  const iconPath = path.join(__dirname, '..', 'icon', iconName)

  // Use the icon file if it exists, otherwise fall back to an empty image
  let trayIcon: Electron.NativeImage
  try {
    trayIcon = nativeImage.createFromPath(iconPath)
    if (trayIcon.isEmpty()) {
      trayIcon = nativeImage.createEmpty()
    }
  } catch {
    trayIcon = nativeImage.createEmpty()
  }

  const tray = new Tray(trayIcon)

  const rebuild = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: 'AI Agent Session Center',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: win.isVisible() ? 'Hide Window' : 'Show Window',
        click: () => {
          if (win.isVisible()) {
            win.hide()
          } else {
            win.show()
          }
          rebuild()
        },
      },
      {
        label: 'Open in Browser',
        click: () => {
          const port = process.env.SERVER_PORT ?? '3333'
          shell.openExternal(`http://localhost:${port}`)
        },
      },
      { type: 'separator' },
      {
        label: 'Re-run Setup Wizard',
        click: () => win.webContents.send('app:trigger-rerun-setup'),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => app.exit(0),
      },
    ]))
  }

  rebuild()
  tray.setToolTip('AI Agent Session Center')
  tray.on('double-click', () => {
    win.show()
    rebuild()
  })

  // Minimize to tray instead of quit
  win.on('close', (e) => {
    e.preventDefault()
    win.hide()
    rebuild()
  })
}

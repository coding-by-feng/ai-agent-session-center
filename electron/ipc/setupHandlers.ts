import { ipcMain, app, BrowserWindow } from 'electron'
import { execSync } from 'child_process'
import { writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { randomBytes } from 'crypto'
import path, { join } from 'path'

const SETUP_FLAG  = join(app.getPath('userData'), 'setup.json')
// __dirname resolves to dist/electron/ipc/ after CJS compilation
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..')
const CONFIG_PATH  = join(PROJECT_ROOT, 'data', 'server-config.json')

// Validation constants — never accept these from renderer input
const VALID_DENSITIES = ['high', 'medium', 'low'] as const
const VALID_CLIS = ['claude', 'gemini', 'codex'] as const
const MIN_PORT = 1
const MAX_PORT = 65535

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT
}

function isValidDensity(density: unknown): density is typeof VALID_DENSITIES[number] {
  return typeof density === 'string' && (VALID_DENSITIES as readonly string[]).includes(density)
}

function isValidCli(cli: unknown): cli is typeof VALID_CLIS[number] {
  return typeof cli === 'string' && (VALID_CLIS as readonly string[]).includes(cli)
}

export function registerSetupHandlers() {

  ipcMain.handle('setup:is-complete', () => existsSync(SETUP_FLAG))

  // ── Dep check ──────────────────────────────────────────────────────────
  ipcMain.handle('setup:check-deps', () => {
    const isWin = process.platform === 'win32'
    const results: Record<string, { ok: boolean; version?: string; hint?: string }> = {}

    if (!isWin) {
      // jq (optional but recommended)
      try {
        const v = execSync('jq --version', { encoding: 'utf8', timeout: 3000 }).trim()
        results.jq = { ok: true, version: v }
      } catch {
        results.jq = {
          ok: false,
          hint: 'Install with: brew install jq   (optional — improves session detection)',
        }
      }
      // curl (required for HTTP fallback)
      try {
        execSync('which curl', { encoding: 'utf8', timeout: 3000 })
        results.curl = { ok: true }
      } catch {
        results.curl = { ok: false, hint: 'curl not found — hooks cannot reach dashboard' }
      }
    } else {
      // PowerShell execution policy
      try {
        const policy = execSync(
          'powershell -NoProfile -Command "Get-ExecutionPolicy"',
          { encoding: 'utf8', timeout: 5000 }
        ).trim()
        const allowed = ['RemoteSigned', 'Unrestricted', 'Bypass']
        results.powershell = {
          ok: allowed.includes(policy),
          version: policy,
          hint: allowed.includes(policy)
            ? undefined
            : 'Run as Admin: Set-ExecutionPolicy RemoteSigned -Scope CurrentUser',
        }
      } catch {
        results.powershell = { ok: false, hint: 'Cannot detect PowerShell execution policy' }
      }
    }

    return results
  })

  // ── Save server config ─────────────────────────────────────────────────
  ipcMain.handle('setup:save-config', (_, cfg: unknown) => {
    // Validate the config object
    if (typeof cfg !== 'object' || cfg === null) {
      return { ok: false, error: 'Invalid config' }
    }

    const c = cfg as Record<string, unknown>

    if (!isValidPort(c.port)) {
      return { ok: false, error: 'Invalid port' }
    }
    if (!isValidDensity(c.hookDensity)) {
      return { ok: false, error: 'Invalid hook density' }
    }
    if (!Array.isArray(c.enabledClis) || !c.enabledClis.every(isValidCli)) {
      return { ok: false, error: 'Invalid CLI list' }
    }

    const config = {
      port: c.port,
      enabledClis: c.enabledClis,
      hookDensity: c.hookDensity,
      debug: c.debug === true,
      sessionHistoryHours: typeof c.sessionHistoryHours === 'number'
        && Number.isFinite(c.sessionHistoryHours)
        && c.sessionHistoryHours > 0
        && c.sessionHistoryHours <= 8760
        ? c.sessionHistoryHours : 24,
      ...(typeof c.passwordHash === 'string' && c.passwordHash.length <= 256
        ? { passwordHash: c.passwordHash }
        : {}),
    }

    const dataDir = join(PROJECT_ROOT, 'data')
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
    // Atomic write: write to temp file then rename to prevent corruption
    const tmpPath = CONFIG_PATH + '.tmp.' + randomBytes(4).toString('hex')
    try {
      writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n')
      renameSync(tmpPath, CONFIG_PATH)
    } catch (err) {
      try { unlinkSync(tmpPath) } catch { /* best effort cleanup */ }
      throw err
    }
    return { ok: true }
  })

  // ── Install hooks (streams progress lines back to renderer) ────────────
  ipcMain.handle('setup:install-hooks', async (event, cfg: unknown) => {
    if (typeof cfg !== 'object' || cfg === null) {
      return { ok: false, error: 'Invalid config' }
    }

    const c = cfg as Record<string, unknown>

    // Validate density
    const density = isValidDensity(c.hookDensity) ? c.hookDensity : 'medium'

    // Validate enabledClis
    const enabledClis = Array.isArray(c.enabledClis)
      ? c.enabledClis.filter(isValidCli)
      : ['claude']

    const win = BrowserWindow.fromWebContents(event.sender)
    const send = (line: string) => win?.webContents.send('setup:install-log', line)

    try {
      const { installHooks } = await import(
        join(PROJECT_ROOT, 'hooks', 'install-hooks-api.js')
      )
      await installHooks({
        density,
        enabledClis,
        projectRoot: PROJECT_ROOT,
        onLog: send,
      })
      return { ok: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })

  // ── Mark setup complete + restart as dashboard ─────────────────────────
  ipcMain.handle('setup:complete', async (event) => {
    const userData = app.getPath('userData')
    if (!existsSync(userData)) mkdirSync(userData, { recursive: true })
    writeFileSync(SETUP_FLAG, JSON.stringify({ completedAt: new Date().toISOString() }))

    // Start server and resize/reload window
    // Use require() to avoid TypeScript following ESM server files during CJS compilation
    const serverPath = path.join(PROJECT_ROOT, 'server', 'index.js')
    const { startServer } = require(serverPath) as { startServer: (port?: number) => Promise<number> }
    const port = await startServer()
    process.env.SERVER_PORT = String(port)

    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      win.setResizable(true)
      win.setSize(1400, 900)
      win.center()
      await win.loadURL(`http://localhost:${port}`)
    }

    return { ok: true, port }
  })
}

import { app, dialog, crashReporter } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

// Everything in this file exists because, before it, a crash left no trace:
// process.stdout/stderr is only mirrored to the loading screen during startup
// (see captureLogsToLoadingScreen in main.ts) and is never written to disk,
// and nothing observed renderer/GPU process death or native (segfault-level)
// crashes in better-sqlite3 / node-pty at all.

const MAX_LOG_BYTES = 5 * 1024 * 1024 // rotate main.log -> main.old.log past this size

let cachedLogPath: string | null = null

function resolveLogPath(): string {
  if (cachedLogPath) return cachedLogPath
  // Same root as every other piece of persisted app state (setup.json,
  // server-config.json, the SQLite DB) -- not Electron's OS-specific getPath('logs'),
  // so main.log and the server's own server.log (server/logger.ts, via the
  // APP_USER_DATA env var) land in the same folder instead of two different ones.
  const dir = join(app.getPath('userData'), 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* already exists */
  }
  cachedLogPath = join(dir, 'main.log')
  return cachedLogPath
}

function rotateIfNeeded(path: string) {
  try {
    if (statSync(path).size > MAX_LOG_BYTES) {
      renameSync(path, path.replace(/\.log$/, '.old.log'))
    }
  } catch {
    /* no existing file yet -- nothing to rotate */
  }
}

function writeLine(level: 'INFO' | 'ERROR' | 'FATAL', message: string) {
  const path = resolveLogPath()
  const line = `[${new Date().toISOString()}] [${level}] ${message}`
  try {
    rotateIfNeeded(path)
    appendFileSync(path, line + '\n')
  } catch {
    /* logging must never be the thing that crashes the app */
  }
  if (level === 'INFO') console.log(line)
  else console.error(line)
}

/**
 * Registers main-process crash capture. Call as early as possible (module scope,
 * before app.whenReady) so startup crashes are covered too.
 */
export function initCrashLogger(): void {
  // Native (segfault-level) crashes in better-sqlite3 / node-pty never reach a JS
  // try/catch -- crashReporter + minidumps are the only way to see those at all.
  try {
    app.setPath('crashDumps', join(app.getPath('userData'), 'logs', 'crashDumps'))
    crashReporter.start({ uploadToServer: false, compress: true })
  } catch {
    /* non-fatal -- continue without native crash dumps */
  }

  process.on('uncaughtException', (err: Error) => {
    writeLine('FATAL', `Uncaught exception in main process: ${err.message}\n${err.stack ?? ''}`)
    if (app.isPackaged) {
      try {
        dialog.showErrorBox(
          'AI Agent Session Center — Unexpected Error',
          `The app hit an unexpected error and has to close.\n\n${err.message}\n\nDetails were written to:\n${resolveLogPath()}`,
        )
      } catch {
        /* a dialog failure must not block shutdown */
      }
    }
    // Per Node's own guidance, resuming after an uncaught exception is unsafe --
    // this matches what already happened before this handler existed (an
    // unhandled 'uncaughtException' terminates the process by default); the only
    // change is that it's now logged and visible instead of silent.
    app.exit(1)
  })

  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason)
    writeLine('ERROR', `Unhandled rejection in main process: ${msg}`)
  })

  app.on('render-process-gone', (_event, webContents, details) => {
    const url = (() => {
      try {
        return webContents.getURL()
      } catch {
        return 'unknown'
      }
    })()
    const level = details.reason === 'clean-exit' ? 'INFO' : 'ERROR'
    writeLine(level, `Renderer process gone: reason=${details.reason} exitCode=${details.exitCode} url=${url}`)
  })

  app.on('child-process-gone', (_event, details) => {
    // Covers the GPU process -- the most likely single crash source for a
    // WebGL-heavy (Three.js cyberdrome scene) renderer on flaky GPU drivers.
    writeLine('ERROR', `Child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
  })
}

/** Absolute path to the main-process log file, for surfacing in UI (tray menu, etc). */
export function getCrashLogPath(): string {
  return resolveLogPath()
}

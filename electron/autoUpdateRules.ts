/**
 * autoUpdateRules.ts — the pure decisions behind the Mac auto-updater (autoUpdate.ts does the wiring).
 *
 * Updates come from this repository's GitHub releases. Each release carries one update file per Mac
 * edition, written by scripts/prepare-electron-release.mjs: `latest-mac.yml` for Full, `lite-mac.yml`
 * for Lite. Squirrel.Mac only installs an update signed by the same Developer ID team as the running app.
 */
import type { DesktopEdition } from './edition.js'

export const UPDATE_REPO = { owner: 'coding-by-feng', repo: 'ai-agent-session-center' } as const

/** Give the server and the window time to start before the first check. */
export const FIRST_CHECK_DELAY_MS = 30_000
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export const UPDATE_PREFS_FILE = 'auto-update.json'

export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'error'

export interface UpdateState {
  status: UpdateStatus
  /** The version on offer, once one is found. */
  version?: string
  /** 0–100 while downloading. */
  percent?: number
  error?: string
  /** Background checks (at launch, then every few hours). A check from the menu always runs. */
  autoCheck: boolean
}

export interface UpdatePrefs {
  autoCheck: boolean
}

/** electron-updater reads `<channel>-mac.yml`: `latest` for Full, `lite` for Lite. */
export function updateChannel(edition: DesktopEdition): 'latest' | 'lite' {
  return edition === 'lite' ? 'lite' : 'latest'
}

/** Only a packaged Mac app can update itself: Squirrel.Mac needs a signed .app; Windows and Linux builds are unsigned. */
export function updaterSupported(isPackaged: boolean, platform: NodeJS.Platform): boolean {
  return isPackaged && platform === 'darwin'
}

/**
 * A local feed for testing an update end to end (`AASC_UPDATE_FEED_URL=http://127.0.0.1:8123/`).
 * Only a loopback http(s) address is accepted, so the variable can't point the app at another server.
 */
export function testFeedUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env.AASC_UPDATE_FEED_URL
  if (!raw) return null
  try {
    const url = new URL(raw)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    return (url.protocol === 'http:' || url.protocol === 'https:') && loopback ? url.toString() : null
  } catch {
    return null
  }
}

/** Background checks are on unless the person turned them off; anything unreadable counts as on. */
export function parseUpdatePrefs(raw: string | null): UpdatePrefs {
  if (raw === null) return { autoCheck: true }
  try {
    const parsed = JSON.parse(raw) as { autoCheck?: unknown }
    return { autoCheck: parsed.autoCheck !== false }
  } catch {
    return { autoCheck: true }
  }
}

export function serializeUpdatePrefs(prefs: UpdatePrefs): string {
  return JSON.stringify({ autoCheck: prefs.autoCheck }, null, 2) + '\n'
}

/** The confirmation shown before "Restart Now": installing quits the app, which ends every agent terminal. */
export function restartPrompt(appName: string, version: string): { message: string; detail: string } {
  return {
    message: `Restart ${appName} to install ${version}?`,
    detail:
      'Your workspace is saved first, but every running agent terminal will close. ' +
      'Choose Later and the update installs the next time you quit.',
  }
}

export function readyNotice(appName: string, version: string): { title: string; body: string } {
  return {
    title: `${appName} ${version} is ready`,
    body: 'It installs the next time you quit. Running agents are not interrupted.',
  }
}

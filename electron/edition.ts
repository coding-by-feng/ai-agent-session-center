/**
 * edition.ts — which desktop version this packaged app is. electron-builder.lite.cjs writes
 * `aascEdition` into the packaged package.json; nothing else marks it, so anything unreadable is Full.
 *
 * Lite deliberately keeps Full's package `name`. Electron derives the data folder and the OS keychain
 * item from it (`ai-agent-session-center` in both), which is how the two share sessions, settings,
 * paired phones and the cloud sign-in. Only one of them may run at a time: see singleInstance.ts.
 */
import { readFileSync } from 'fs'
import path from 'path'

export type DesktopEdition = 'full' | 'lite'

export function parseDesktopEdition(packageJson: string): DesktopEdition {
  try {
    return (JSON.parse(packageJson) as { aascEdition?: unknown }).aascEdition === 'lite' ? 'lite' : 'full'
  } catch {
    return 'full'
  }
}

export function readDesktopEdition(appPath: string): DesktopEdition {
  try {
    return parseDesktopEdition(readFileSync(path.join(appPath, 'package.json'), 'utf8'))
  } catch {
    return 'full'
  }
}

export function desktopAppName(edition: DesktopEdition): string {
  return edition === 'lite' ? 'AI Agent Session Center Lite' : 'AI Agent Session Center'
}

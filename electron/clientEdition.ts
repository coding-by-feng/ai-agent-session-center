/**
 * clientEdition.ts — which Client this packaged app is. electron-builder.client-base.cjs writes `aascEdition` into
 * the packaged package.json; anything unreadable reads as Full Client, which only changes the name shown.
 *
 * Both Clients carry `CLIENT_DATA_FOLDER` as their package `name`. Electron derives the data folder and the OS
 * keychain item from it, so the two share their paired computers, and neither ever shares a folder with Full or Lite
 * (`ai-agent-session-center`, edition.ts): no sessions.db, no hook queue, no lock, so a Client runs beside a local AASC.
 */
import { readFileSync } from 'fs'
import path from 'path'

export type ClientEdition = 'full-client' | 'lite-client'

export const CLIENT_DATA_FOLDER = 'ai-agent-session-center-client'

export function parseClientEdition(packageJson: string): ClientEdition {
  try {
    return (JSON.parse(packageJson) as { aascEdition?: unknown }).aascEdition === 'lite-client' ? 'lite-client' : 'full-client'
  } catch {
    return 'full-client'
  }
}

export function readClientEdition(appPath: string): ClientEdition {
  try {
    return parseClientEdition(readFileSync(path.join(appPath, 'package.json'), 'utf8'))
  } catch {
    return 'full-client'
  }
}

export function clientAppName(edition: ClientEdition): string {
  return edition === 'lite-client' ? 'AI Agent Session Center Lite Client' : 'AI Agent Session Center Full Client'
}

/**
 * @module edition
 * Which product is running this server. `aasc-server` (bin/cli.js) sets AASC_HEADLESS=1, Electron sets
 * ELECTRON=1, and anything else (`npm run dev`, `npm start`) is a development server.
 */
import type { Edition } from './instanceLock.js';

export function serverEdition(env: NodeJS.ProcessEnv = process.env): Edition {
  if (env.AASC_HEADLESS === '1') return 'headless';
  if (env.ELECTRON === '1') return 'desktop';
  return 'dev';
}

export function isHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  return serverEdition(env) === 'headless';
}

/** The command a hint should name for setting the password on this edition. */
export function setPasswordCommand(env: NodeJS.ProcessEnv = process.env): string {
  return isHeadless(env) ? 'aasc-server set-password' : 'npm run set-password';
}

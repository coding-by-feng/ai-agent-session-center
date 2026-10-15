// paths.ts — where the cloud connection keeps its state and the device token.
//
// Never inside a project tree. A paired phone may read files of shared
// sessions' projects, and the AASC checkout itself is often one of those
// projects, so `<repo>/data` is no place for a bearer token. Cloud job state,
// package caches and install backups live under the same private directory.
//   - Electron: `<userData>/cloud` (APP_USER_DATA; the token is encrypted with
//     the OS keychain through safeStorage).
//   - Otherwise (`npm start`, dev): `~/.config/aasc/cloud`. `.config` is on the
//     phone profile's never-read list wherever it appears.
import { homedir } from 'os';
import { join, resolve } from 'path';

export function cloudStateBase(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.APP_USER_DATA ? resolve(env.APP_USER_DATA) : join(resolve(home), '.config', 'aasc');
}

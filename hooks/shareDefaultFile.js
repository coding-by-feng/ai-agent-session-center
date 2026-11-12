// shareDefaultFile.js — <data>/share-default.json for the setup wizard, which runs before the server
// does. Same file and format as server/shareDefault.ts (`{"shareNewSessions": true|false}`, 0600,
// temp + rename); test/shareDefaultFile.test.ts keeps the two in step.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';

export function shareDefaultPath(dataDir) {
  return join(dataDir, 'share-default.json');
}

/** On only when the file says so; no file, or one that isn't ours, is off (the safe state). */
export function readShareDefault(dataDir) {
  try {
    return JSON.parse(readFileSync(shareDefaultPath(dataDir), 'utf8')).shareNewSessions === true;
  } catch {
    return false;
  }
}

export function writeShareDefault(dataDir, on) {
  const file = shareDefaultPath(dataDir);
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ shareNewSessions: on === true })}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

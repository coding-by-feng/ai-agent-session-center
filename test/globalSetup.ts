// test/globalSetup.ts — isolates server tests from the developer's live database.
//
// server/db.ts opens a real SQLite file at $APP_USER_DATA/data/sessions.db at
// IMPORT time, so every server test that transitively imports it reads and
// writes whatever database it finds. Without an isolated location that is the
// developer's own data/sessions.db, which causes two distinct problems:
//
//   1. Test rows are written into real session data.
//   2. State leaks BETWEEN RUNS. sessionStore restores promptHistory from the
//      DB when a session starts with none in memory, so a test asserting
//      "2 prompts" sees 4 on the second run, 6 on the third, and so on.
//
// Point APP_USER_DATA at a scratch directory (see vitest.config.ts) and wipe it
// once per run here, so every run starts from an empty database.

import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export const SERVER_TEST_DATA_DIR = join(tmpdir(), 'aasc-server-tests');

export default function setup(): void {
  rmSync(SERVER_TEST_DATA_DIR, { recursive: true, force: true });
}

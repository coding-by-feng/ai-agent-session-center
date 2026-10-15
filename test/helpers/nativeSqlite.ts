// test/helpers/nativeSqlite.ts — can this Node load better-sqlite3's native binding?
//
// After `npm run electron:rebuild` the binding is built for Electron's ABI and cannot
// load under system Node. Tests that open a real SQLite database (the cloud job store,
// db.ts) then skip instead of failing; `npm rebuild better-sqlite3` makes them run.
// The same convention as dbMigrateSession.test.ts.
import { it } from 'vitest';

async function bindingLoads(): Promise<boolean> {
  try {
    const { default: Database } = await import('better-sqlite3');
    new Database(':memory:').close();
    return true;
  } catch {
    return false;
  }
}

export const nativeSqlite = await bindingLoads();

/** `it` when the binding loads, `it.skip` otherwise. */
export const sqliteIt = nativeSqlite ? it : it.skip;

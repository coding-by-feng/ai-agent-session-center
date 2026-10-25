// scripts/mcp-route-replay.ts — P4 Task 12, a dev script (not shipped): would AASC's project resolution have picked the
// folder each recent session was started in? It reads the sessions database READ-ONLY, scores the first prompt of every
// session of the last 14 days with `resolveProject` (server/mcp/replay.ts holds the rules), and prints the accuracy, the
// sample count, the verdict against the bar (70 % over at least 30 samples) and the 10 worst misses as folder names.
// It never prints a prompt and writes nothing of its own.
//
//   npx tsx scripts/mcp-route-replay.ts [--db <path to sessions.db>]
//
// Without `--db` it opens the database where the server does: `<APP_USER_DATA>/data/sessions.db` when APP_USER_DATA is
// set (the packaged app: its userData folder), else `<repo>/data/sessions.db`. The database is opened with
// `node:sqlite`'s `readOnly` flag; SQLite may still create or remove its `-shm` side file while it reads a WAL database,
// which is the library's doing, never the script's.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { databaseDirectory } from '../server/dbPaths.js';
import {
  CANDIDATE_DAYS,
  SAMPLE_DAYS,
  formatReplayReport,
  pickSamples,
  scoreReplay,
  type ReplayRow,
} from '../server/mcp/replay.js';

const DAY_MS = 86_400_000;

/** A session joined to its first prompt, as the query returns it. */
const rowSchema = z.object({
  id: z.string(),
  project_path: z.string().nullish(),
  started_at: z.number().nullish(),
  last_activity_at: z.number().nullish(),
  text: z.string().nullish(),
  prompt_at: z.number().nullish(),
});

// Sessions with activity since the oldest candidate window opens; each joined to the prompt with the lowest timestamp.
const QUERY = `
  SELECT s.id AS id, s.project_path AS project_path, s.started_at AS started_at,
         s.last_activity_at AS last_activity_at, f.text AS text, f.timestamp AS prompt_at
  FROM sessions s
  LEFT JOIN prompts f
    ON f.session_id = s.id AND f.timestamp = (SELECT MIN(timestamp) FROM prompts WHERE session_id = s.id)
  WHERE s.last_activity_at >= ?`;

function readRows(db: DatabaseSync, now: number): ReplayRow[] {
  const since = now - (SAMPLE_DAYS + CANDIDATE_DAYS) * DAY_MS;
  return db
    .prepare(QUERY)
    .all(since)
    .flatMap((raw) => {
      const parsed = rowSchema.safeParse(raw);
      if (!parsed.success || parsed.data.last_activity_at == null) return [];
      const r = parsed.data;
      return [
        {
          id: r.id,
          projectPath: r.project_path ?? '',
          startedAt: r.started_at ?? 0,
          lastActivityAt: r.last_activity_at ?? 0,
          firstPrompt: r.text ?? null,
          firstPromptAt: r.prompt_at ?? null,
        } satisfies ReplayRow,
      ];
    });
}

const out = (line: string): void => void process.stdout.write(`${line}\n`);
const fail = (line: string): void => void process.stderr.write(`${line}\n`);

/** The `--db` the caller gave, else the server's own database file; null for arguments that make no sense. */
function databasePath(argv: readonly string[]): string | null {
  if (argv.length === 0) return join(databaseDirectory(), 'sessions.db');
  return argv.length === 2 && argv[0] === '--db' && argv[1] !== '' ? argv[1] : null;
}

function main(argv: readonly string[]): number {
  const path = databasePath(argv);
  if (path === null) {
    fail('Usage: npx tsx scripts/mcp-route-replay.ts [--db <path to sessions.db>]');
    return 2;
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    fail('Could not open that database read-only (does the file exist?). Pass its path with --db.');
    return 1;
  }
  try {
    const now = Date.now();
    const home = homedir();
    const samples = pickSamples(readRows(db, now), { now, home });
    for (const line of formatReplayReport(scoreReplay(samples, home))) out(line);
    return 0;
  } catch (err) {
    fail(`The replay could not read the database: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}

process.exitCode = main(process.argv.slice(2));

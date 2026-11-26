/**
 * Two small JSON files beside the server's other settings (docs/plans/project-transfer.md):
 *   project-transfer-allowed.json  the paired computers this computer's owner allowed to send projects
 *   project-transfer-moved.json    projects this computer moved away (the "Moved to …" line)
 * Both are written whole, to a temporary file and renamed into place.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { MovedProject } from '../../src/types/projectTransfer.js';

const here = dirname(fileURLToPath(import.meta.url));

export function transferDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.APP_USER_DATA ? env.APP_USER_DATA : join(here, '..', '..', 'data');
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

const AllowedSchema = z.object({
  computers: z.record(z.string(), z.object({ label: z.string(), allowedAt: z.number() })),
});

export function createAllowList(dir: string) {
  const file = join(dir, 'project-transfer-allowed.json');
  const read = (): z.infer<typeof AllowedSchema> => {
    const parsed = AllowedSchema.safeParse(readJson(file));
    return parsed.success ? parsed.data : { computers: {} };
  };
  return {
    isAllowed: (computerId: string): boolean => Object.hasOwn(read().computers, computerId),
    list: (): { computerId: string; label: string; allowedAt: number }[] =>
      Object.entries(read().computers).map(([computerId, c]) => ({ computerId, ...c })),
    allow(computerId: string, label: string, now = Date.now()): void {
      const cur = read();
      writeAtomic(file, { computers: { ...cur.computers, [computerId]: { label, allowedAt: now } } });
    },
    /** Take a computer's Allow back; false when it wasn't allowed. */
    forget(computerId: string): boolean {
      const { [computerId]: gone, ...rest } = read().computers;
      if (!gone) return false;
      writeAtomic(file, { computers: rest });
      return true;
    },
  };
}

const MovedSchema = z.array(
  z.object({ root: z.string(), computer: z.string(), destination: z.string(), at: z.number() }),
);
const MOVED_MAX = 200;

export function createMovedLog(dir: string) {
  const file = join(dir, 'project-transfer-moved.json');
  const list = (): MovedProject[] => {
    const parsed = MovedSchema.safeParse(readJson(file));
    return parsed.success ? parsed.data : [];
  };
  return {
    list,
    add(entry: MovedProject): void {
      const next = [entry, ...list().filter((m) => m.root !== entry.root)].slice(0, MOVED_MAX);
      writeAtomic(file, next);
    },
  };
}

/** Private, durable cloud jobs. No credentials or user bytes are stored here. */
import Database from 'better-sqlite3';
import { chmod, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CloudJob } from '../../src/types/cloudResources.js';
import { accountKey, type CloudBinding } from './binding.js';
import { privateDirectory } from './secretStore.js';
import { CloudError } from './types.js';
export interface SavedJob {
  job: CloudJob;
  binding: CloudBinding;
  private: unknown;
}
export interface InstalledAssociation {
  binding: CloudBinding;
  review: import('./install.js').ReviewedInstall;
  after: import('./installFs.js').DestinationSnapshot;
  associated: boolean;
}
export const installedAssociationKey = (binding: CloudBinding, path: string) =>
  JSON.stringify([accountKey(binding), path]);
export interface ProjectAssociation {
  cloudProjectId: string;
  localProjectId: string;
  path: string;
  version: number;
}
export type JobStore = Awaited<ReturnType<typeof createJobStore>>;
export async function createJobStore(directory: string) {
  await privateDirectory(directory);
  const path = join(directory, 'jobs.sqlite');
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const s = await lstat(path + suffix);
      if (
        !s.isFile() ||
        s.nlink !== 1 ||
        (process.platform !== 'win32' &&
          (s.mode & 0o077 || (process.getuid && s.uid !== process.getuid())))
      )
        throw new Error();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new CloudError('job_storage', 'Private cloud job storage is unavailable.', 503);
    }
  }
  const fd = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  await fd.close();
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  // Explicit standalone schema migration. No session database import/startup side effects.
  db.exec('CREATE TABLE IF NOT EXISTS cloud_job_schema(version INTEGER PRIMARY KEY)');
  const version =
    (
      db.prepare('SELECT MAX(version) AS version FROM cloud_job_schema').get() as {
        version: number | null;
      }
    ).version ?? 0;
  if (version > 1) {
    db.close();
    throw new CloudError('job_storage', 'Cloud jobs require a newer application.', 503);
  }
  if (version < 1)
    db.transaction(() => {
      db.exec(
        `CREATE TABLE cloud_local_values(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id)); INSERT INTO cloud_job_schema VALUES(1);`,
      );
    })();
  for (const suffix of ['', '-wal', '-shm']) await chmod(path + suffix, 0o600).catch(() => {});
  const get = <T>(kind: string, id: string): T | null => {
    const row = db
      .prepare('SELECT value FROM cloud_local_values WHERE kind=? AND id=?')
      .get(kind, id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  };
  const put = (kind: string, id: string, value: unknown) => {
    db.prepare(
      'INSERT INTO cloud_local_values VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value',
    ).run(kind, id, JSON.stringify(value));
  };
  const list = <T>(kind: string): T[] =>
    (
      db.prepare('SELECT value FROM cloud_local_values WHERE kind=?').all(kind) as {
        value: string;
      }[]
    ).map((row) => JSON.parse(row.value) as T);
  for (const saved of list<SavedJob>('job'))
    if (['queued', 'running'].includes(saved.job.state)) {
      saved.job.state = 'interrupted';
      for (const s of saved.job.steps) if (s.state === 'running') s.state = 'failed';
      put('job', saved.job.id, saved);
    }
  return {
    directory,
    get,
    put,
    list,
    close: () => {
      db.close();
    },
    getJob: (id: string) => get<SavedJob>('job', id),
    saveJob: (job: CloudJob, binding: CloudBinding, data: unknown) =>
      put('job', job.id, { job, binding, private: data }),
    resourceId(binding: CloudBinding, catalogId: string) {
      const key = JSON.stringify([accountKey(binding), catalogId]);
      let id = get<string>('resource-id', key);
      if (!id) {
        id = randomUUID();
        put('resource-id', key, id);
      }
      return id;
    },
    associateResource(
      binding: CloudBinding,
      catalogId: string,
      resourceId: string,
      version?: number,
    ) {
      const key = JSON.stringify([accountKey(binding), catalogId]);
      db.transaction(() => {
        const prior = get<string>('resource-id', key);
        if (prior && prior !== resourceId)
          throw new CloudError(
            'association_conflict',
            'Package installed; its local catalog identity is associated with another cloud resource. Review the association before publishing.',
            409,
          );
        put('resource-id', key, resourceId);
        if (version !== undefined) put('published', key, { resourceId, version });
      })();
    },
    project(binding: CloudBinding, localProjectId: string) {
      return get<ProjectAssociation>(
        'project',
        JSON.stringify([accountKey(binding), localProjectId]),
      );
    },
    associateProject(binding: CloudBinding, association: ProjectAssociation) {
      put(
        'project',
        JSON.stringify([accountKey(binding), association.localProjectId]),
        association,
      );
    },
  };
}

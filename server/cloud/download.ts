import { open } from 'node:fs/promises';
import { syncDirectory } from './installFs.js';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { createWriteStream, constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import type { ResourceVersion } from '../../src/types/cloudResources.js';
import { privateDirectory } from './secretStore.js';
/** Prepared exports only: archives are output, never installer input. */
export async function prepareDownload(
  directory: string,
  versions: ResourceVersion[],
  paths: Map<string, string>,
  signal: AbortSignal,
): Promise<string> {
  await privateDirectory(directory);
  const path = join(directory, `${randomUUID()}.zip`);
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(JSON.stringify({ format: 'aasc-resource-v1', resources: versions }, null, 2)),
    'manifest.json',
    { mode: 0o100644 },
  );
  for (const v of versions)
    for (const f of v.manifest.files) {
      const source = paths.get(f.sha256)!;
      zip.addReadStreamLazy(
        `resources/${v.manifest.resourceId}/${v.version}/${f.path}`,
        { size: f.bytes, mode: 0o100000 | f.mode },
        (cb) => {
          void open(source, constants.O_RDONLY | constants.O_NOFOLLOW).then(
            (file) => cb(null, file.createReadStream()),
            (error) => cb(error as Error, Readable.from([])),
          );
        },
      );
    }
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  zip.on('error', (error) => (zip.outputStream as Readable).destroy(error));
  const completion = pipeline(zip.outputStream, output, { signal });
  zip.end();
  await completion;
  const file = await open(path, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(directory);
  return path;
}

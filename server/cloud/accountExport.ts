// accountExport.ts — "Export my data" (plan 18): saves everything AASC Cloud holds for this account
// to a file on this computer. The backend streams one JSON document into a private "<name>.json.part"
// (0600), which becomes "<name>.json" only when it is whole. Nothing that already exists is opened
// or overwritten, and a failed, aborted or oversized export removes its part. The page only ever
// learns the path and the size.

import { link, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CloudError, type CloudClient } from './types.js';

export const ACCOUNT_EXPORT_PATH = '/v1/account/export';
/** The backend ends an export after 30 minutes; this request waits a little longer. */
export const EXPORT_TIMEOUT_MS = 31 * 60_000;
/** Far above any account's quota: a response past it is not an export. */
export const EXPORT_MAX_BYTES = 8 * 1024 ** 3;

const two = (n: number) => String(n).padStart(2, '0');
/** `aasc-cloud-export-20261120-010203` (UTC), so a file sorts by when it was made. */
function exportName(time: number): string {
  const d = new Date(time);
  return `aasc-cloud-export-${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`;
}

export async function exportCloudAccount(deps: {
  client: CloudClient;
  /** An existing folder on this computer. */
  directory: string;
  now: () => number;
  maxBytes?: number;
  signal?: AbortSignal;
}): Promise<{ path: string; bytes: number }> {
  const { client } = deps;
  if (!client.stream) throw new CloudError('cloud_error', 'This build cannot export the cloud account.');
  const limit = deps.maxBytes ?? EXPORT_MAX_BYTES;
  const base = exportName(deps.now());
  const named = (n: number) => join(deps.directory, `${base}${n === 1 ? '' : `-${n}`}.json`);
  const failed = () => new CloudError('export_failed', 'The export could not be saved on this computer.');
  // While it runs the folder shows only "<name>.json.part". "wx" never opens something that is
  // already there (a part a crash left, a link someone planted): the next name is tried instead.
  let file: Awaited<ReturnType<typeof open>> | null = null;
  let part = '';
  let taken = 0;
  for (let n = 1; n <= 50 && !file; n++) {
    part = `${named(n)}.part`;
    try {
      file = await open(part, 'wx', 0o600);
      taken = n;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw failed();
    }
  }
  if (!file) throw failed();
  const writer = file;
  let bytes = 0;
  try {
    await client.stream(
      ACCOUNT_EXPORT_PATH,
      async (body) => {
        const reader = body.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > limit) throw new CloudError('export_too_large', 'The export is larger than this computer accepts.');
            await writer.write(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      },
      deps.signal,
      EXPORT_TIMEOUT_MS,
    );
    await writer.close();
    // Publish under the first free name. A hard link fails when the name exists, so nothing is
    // ever overwritten, and the finished file appears whole.
    for (let n = taken; n <= taken + 50; n++) {
      try {
        await link(part, named(n));
        await rm(part, { force: true });
        return { path: named(n), bytes };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw failed();
      }
    }
    throw failed();
  } catch (error) {
    await writer.close().catch(() => {});
    await rm(part, { force: true }).catch(() => {});
    // A device that signed in before exports were allowed holds no export scope: the fix is to sign in again.
    if (error instanceof CloudError && error.code === 'forbidden')
      throw new CloudError(
        'export_needs_sign_in',
        'This computer signed in before exports were allowed. Sign out, sign in again, then export.',
        403,
      );
    if (error instanceof CloudError) throw error;
    throw new CloudError('export_failed', 'The export could not be saved on this computer.');
  }
}

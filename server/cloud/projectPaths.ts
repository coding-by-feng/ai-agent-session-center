// projectPaths.ts — which folders a cloud project action may use on this Mac.
//
// Built on the rule the project browser applies to a paired phone's projects
// (mobile/secretPaths.ts): inside the home folder, never through a secrets or
// agent-config folder, never ~/Library. Stricter here, because a clone writes a
// repository the backend chose: no hidden folder at all below home (a tool such
// as an editor or agent may load code from one), and the path a browser sends
// must already be canonical, so what was reviewed is exactly what gets used.
import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize, relative, sep } from 'node:path';
import { z } from 'zod';
import { HOME_SECRET_SEGMENTS, segmentLooksSecret } from '../mobile/secretPaths.js';
import { CloudError } from './types.js';

/** Absolute, NUL-free and normalized: no `.` or `..` segment, no doubled or trailing separator. */
export const LocalPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'), 'must not contain a NUL byte')
  .refine((p) => isAbsolute(p), 'must be an absolute path')
  .refine((p) => normalize(p) === p && (p === sep || !p.endsWith(sep)), 'must be normalized');

const refused = () =>
  new CloudError(
    'path_not_allowed',
    'Choose a folder inside your home folder, outside hidden configuration, Library and secrets folders.',
    400,
  );

/**
 * The canonical folder, or a `path_not_allowed` refusal. The path must be its own
 * realpath (no link anywhere along it, no other spelling), inside `home`, and no
 * segment below home may be hidden (start with a dot: `.ssh`, `.config`, `.gemini`,
 * `.vim`…) or look like a secret; the first may not be `Library`. A checkout sits
 * strictly inside home; `allowHome` lets a clone's parent folder be home itself.
 */
export async function confinedProjectPath(
  path: string,
  home: string,
  options: { allowHome?: boolean } = {},
): Promise<string> {
  if (!LocalPathSchema.safeParse(path).success) throw refused();
  let real: string, realHome: string;
  try {
    [real, realHome] = await Promise.all([realpath(path), realpath(home)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new CloudError('path_missing', 'That folder does not exist on this Mac.', 400);
    throw refused();
  }
  if (real !== path) throw refused();
  const rel = relative(realHome, real);
  if (rel === '') {
    if (options.allowHome) return real;
    throw refused();
  }
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw refused();
  const segments = rel.split(sep);
  if (
    HOME_SECRET_SEGMENTS.has(segments[0].toLowerCase()) ||
    segments.some((s) => s.startsWith('.') || segmentLooksSecret(s))
  )
    throw refused();
  return real;
}

/**
 * A new folder's name follows the same rule: never hidden or secret-looking
 * (`credentials`, `id_rsa`, `*.pem`), and never `Library` directly in home.
 */
export async function assertSafeFolderName(
  name: string,
  parent: string,
  home: string,
): Promise<void> {
  if (name.startsWith('.') || segmentLooksSecret(name)) throw refused();
  const atHome = (await realpath(parent).catch(() => parent)) === (await realpath(home));
  if (atHome && HOME_SECRET_SEGMENTS.has(name.toLowerCase())) throw refused();
}

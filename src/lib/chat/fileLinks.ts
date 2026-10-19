/**
 * fileLinks.ts — does this bit of the phone chat name a file of the session's
 * project? A tool row's path, an inline `code` span or a Markdown link that does
 * becomes a tap that opens it in the Project tab. Pure.
 *
 * Only what can be placed for certain: a path relative to the project (the agent's
 * working folder) or absolute under it, with a folder part and an extension. A bare
 * name ("plan.md") could be anywhere, and a path that climbs out with `..` or lies
 * outside the project is not the phone's to read, so neither becomes a link.
 */
import { relInProject } from '@/lib/phoneProject';

const LINE_SUFFIX = /(?::\d+){1,2}$/;
const HAS_EXTENSION = /\/[^/]*[^./]\.[A-Za-z0-9]{1,10}$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The file's path inside the project ("/docs/plan.md"), or null when the text isn't one. */
export function chatFileLink(text: string, projectPath: string): string | null {
  if (!projectPath) return null;
  const raw = text.trim().replace(LINE_SUFFIX, '');
  if (!raw || /\s/.test(raw) || SCHEME.test(raw)) return null;
  const path = raw.startsWith('./') ? raw.slice(2) : raw;
  if (path.split('/').includes('..')) return null;
  if (!HAS_EXTENSION.test(path.startsWith('/') ? path : `/${path}`) || !path.includes('/')) return null;
  const rel = relInProject(path, projectPath);
  return rel && rel !== '/' ? rel : null;
}

/**
 * fileTypeIcon — resolves a file/directory name to one of 9 icon "kinds"
 * that `FileTypeIcon` (src/components/ui/FileTypeIcon.tsx) renders as a
 * small currentColor SVG.
 *
 * Single source of truth for the extension -> icon mapping. This used to be
 * duplicated (byte-identical) between ProjectTab.tsx's local `fileIcon()`
 * and FileTree.tsx's local `fileIcon()`, both returning a raw platform
 * emoji (📝/🐍/🔵/…) — inconsistent with every other icon in the app
 * (hand-drawn SVG, currentColor, recolors per theme) and a second copy that
 * could silently drift from the first.
 *
 * 17 extensions collapse into 9 kinds rather than one shape per extension —
 * ts/tsx/js/jsx/py/go/rs/java/html all read as the generic "code" glyph.
 */

export type FileIconKind =
  | 'folder'
  | 'doc'
  | 'code'
  | 'config'
  | 'style'
  | 'shell'
  | 'database'
  | 'image'
  | 'lock';

const EXT_TO_KIND: Record<string, FileIconKind> = {
  md: 'doc', mdx: 'doc', txt: 'doc',
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code',
  py: 'code', go: 'code', rs: 'code', java: 'code', html: 'code',
  json: 'config', yaml: 'config', yml: 'config', toml: 'config',
  css: 'style', scss: 'style',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'database', graphql: 'database',
  svg: 'image', png: 'image', jpg: 'image', gif: 'image',
  env: 'lock', lock: 'lock',
};

/** Fallback for any extension not in the map — matches the old '📄' default. */
const DEFAULT_KIND: FileIconKind = 'doc';

export function resolveFileIconKind(name: string, isDir: boolean): FileIconKind {
  if (isDir) return 'folder';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_KIND[ext] ?? DEFAULT_KIND;
}

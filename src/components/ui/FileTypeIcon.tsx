/**
 * FileTypeIcon — small currentColor SVG icon set for file/directory rows
 * (project file tree, tab bar, "search files by name" results). Replaces
 * the raw platform emoji the old local `fileIcon()` helpers returned
 * (📝/🐍/🔵/…) — those varied by OS font and couldn't be recolored for the
 * active theme, unlike every other icon in the app (hand-drawn SVG,
 * `stroke="currentColor"`, matching `IconEdit`/`IconCopy` in ProjectTab.tsx).
 *
 * See `@/lib/fileTypeIcon` for the extension -> kind mapping (the single
 * source of truth, previously duplicated in ProjectTab.tsx and FileTree.tsx).
 * 9 shapes cover 17 extensions — ts/tsx/js/jsx/py/go/rs/java/html all render
 * as the generic "code" glyph rather than each getting a distinct icon.
 */
import { resolveFileIconKind, type FileIconKind } from '@/lib/fileTypeIcon';

interface FileTypeIconProps {
  name: string;
  isDir: boolean;
  className?: string;
}

const GLYPH_PROPS = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg {...GLYPH_PROPS} className={className} aria-hidden>
      <path d="M2 4.5c0-.83.67-1.5 1.5-1.5h3l1.5 1.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9c-.83 0-1.5-.67-1.5-1.5v-7z" />
    </svg>
  );
}

function DocGlyph({ className }: { className?: string }) {
  return (
    <svg {...GLYPH_PROPS} className={className} aria-hidden>
      <path d="M4.5 2h4L12 5.5V13.5c0 .28-.22.5-.5.5h-7c-.28 0-.5-.22-.5-.5V2.5c0-.28.22-.5.5-.5z" />
      <path d="M8.5 2v3.5H12" />
      <line x1="6" y1="8.5" x2="10" y2="8.5" />
      <line x1="6" y1="11" x2="10" y2="11" />
    </svg>
  );
}

function CodeGlyph({ className }: { className?: string }) {
  return (
    <svg {...GLYPH_PROPS} className={className} aria-hidden>
      <path d="M6 4.5L2.5 8L6 11.5" />
      <path d="M10 4.5L13.5 8L10 11.5" />
    </svg>
  );
}

function ConfigGlyph({ className }: { className?: string }) {
  return (
    <svg {...GLYPH_PROPS} className={className} aria-hidden>
      <path d="M6.5 2.5c-1.2 0-1.5.6-1.5 1.8v1.2c0 .9-.35 1.3-1.5 1.5.9.2 1.5.6 1.5 1.5v1.2c0 1.2.3 1.8 1.5 1.8" />
      <path d="M9.5 2.5c1.2 0 1.5.6 1.5 1.8v1.2c0 .9.35 1.3 1.5 1.5-.9.2-1.5.6-1.5 1.5v1.2c0 1.2-.3 1.8-1.5 1.8" />
    </svg>
  );
}

function StyleGlyph({ className }: { className?: string }) {
  return (
    <svg {...GLYPH_PROPS} className={className} aria-hidden>
      <path d="M11.5 2.5L13.5 4.5L7.2 10.8L4.5 11.5L5.2 8.8Z" />
      <path d="M7.2 10.8C6.2 12.3 4.6 13 2.5 13" />
    </svg>
  );
}

function ShellGlyph({ className }: { className?: string }) {
  return (
    <svg {...GLYPH_PROPS} className={className} aria-hidden>
      <path d="M3 5L6.5 8L3 11" />
      <line x1="8" y1="11" x2="13" y2="11" />
    </svg>
  );
}

function DatabaseGlyph({ className }: { className?: string }) {
  return (
    <svg {...GLYPH_PROPS} className={className} aria-hidden>
      <ellipse cx="8" cy="4" rx="5" ry="2" />
      <path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4" />
      <path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" />
    </svg>
  );
}

function ImageGlyph({ className }: { className?: string }) {
  return (
    <svg {...GLYPH_PROPS} className={className} aria-hidden>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <circle cx="6" cy="6.5" r="1.1" />
      <path d="M2.5 11L6 8L9 10.5L11 8.5L13.5 11.5" />
    </svg>
  );
}

function LockGlyph({ className }: { className?: string }) {
  return (
    <svg {...GLYPH_PROPS} className={className} aria-hidden>
      <rect x="4" y="7" width="8" height="6.5" rx="1" />
      <path d="M5.5 7V5c0-1.66 1.12-3 2.5-3s2.5 1.34 2.5 3v2" />
    </svg>
  );
}

const GLYPHS: Record<FileIconKind, typeof FolderGlyph> = {
  folder: FolderGlyph,
  doc: DocGlyph,
  code: CodeGlyph,
  config: ConfigGlyph,
  style: StyleGlyph,
  shell: ShellGlyph,
  database: DatabaseGlyph,
  image: ImageGlyph,
  lock: LockGlyph,
};

export default function FileTypeIcon({ name, isDir, className }: FileTypeIconProps) {
  const Glyph = GLYPHS[resolveFileIconKind(name, isDir)];
  return <Glyph className={className} />;
}

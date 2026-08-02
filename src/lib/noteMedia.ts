/**
 * Pure helpers for media embedded in notes.
 *
 * Import-free by design (no React, no markdown stack): `NotesTab` is reachable
 * from the eager entry chunk, so anything it needs at module scope has to stay
 * weightless. The heavy renderer lives behind a `lazy()` boundary instead.
 */

/** Extensions we render as `<video>` rather than `<img>`. */
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv)(?:[?#].*)?$/i;

/** Extensions we are willing to treat as an image source. */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp)(?:[?#].*)?$/i;

export function isVideoSrc(src: string): boolean {
  return VIDEO_EXT_RE.test(src);
}

export function isImageSrc(src: string): boolean {
  return IMAGE_EXT_RE.test(src);
}

/** True for the URLs our own media endpoint serves. */
export function isNoteMediaSrc(src: string): boolean {
  return /^\/api\/note-media\/[a-f0-9]{32}$/.test(src);
}

/**
 * Markdown for one uploaded file. Video has no Markdown syntax of its own, so
 * it rides the image form and the renderer branches on the extension — the same
 * convention GitHub uses.
 */
export function mediaMarkdown(name: string, url: string): string {
  const alt = name.replace(/[[\]]/g, '').trim() || 'attachment';
  return `![${alt}](${url})`;
}

/**
 * Insert `snippet` at `caret`, guaranteeing it lands on its own line.
 *
 * Returns the new text plus where the caret should sit afterwards, so pasting
 * three screenshots in a row stacks them instead of overwriting at position 0.
 */
export function insertAtCaret(
  text: string,
  caret: number,
  snippet: string,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
  const trail = after.length > 0 && !after.startsWith('\n') ? '\n' : '';
  const block = `${lead}${snippet}${trail}`;
  return { text: before + block + after, caret: at + block.length - trail.length };
}

/** Media ids currently referenced by a note's text. */
export function referencedMediaIds(text: string): string[] {
  const ids = new Set<string>();
  const re = /\/api\/note-media\/([a-f0-9]{32})/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) ids.add(match[1]);
  return [...ids];
}

/** Files a paste/drop event carries that we are willing to upload. */
export function mediaFilesFrom(list: FileList | File[] | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter(
    (f) => f.type.startsWith('image/') || f.type.startsWith('video/'),
  );
}

/** Read a File as a base64 data URL for the upload endpoint. */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

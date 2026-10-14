/** Local per-file reading state. Content and file names never leave this browser. */
export interface ScrollPosition {
  top: number;
  left: number;
}
export interface PdfPosition {
  page: number;
  zoom: string;
  left: number;
  top: number;
  rotation: number;
}
const memory = new Map<string, string>();
export const readingKey = (project: string, file: string) =>
  `file-browser:scroll:${project}:${file}`;
export const pdfReadingKey = (project: string, file: string) =>
  `file-browser:pdf:${JSON.stringify([project, file])}`;
export function readPositionValue(key: string): string | null {
  if (memory.has(key)) return memory.get(key)!;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writePositionValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    memory.delete(key);
    return;
  } catch {
    /* retain failed writes in memory */
  }
  memory.delete(key);
  memory.set(key, value);
  if (memory.size > 500) memory.delete(memory.keys().next().value!);
}
export function readScrollPosition(key: string): ScrollPosition {
  try {
    const value: unknown = JSON.parse(readPositionValue(key) ?? 'null');
    if (typeof value === 'number' && Number.isFinite(value))
      return { top: Math.max(0, value), left: 0 };
    if (
      value &&
      typeof value === 'object' &&
      'top' in value &&
      'left' in value &&
      typeof value.top === 'number' &&
      Number.isFinite(value.top) &&
      typeof value.left === 'number' &&
      Number.isFinite(value.left)
    ) {
      return { top: Math.max(0, value.top), left: Math.max(0, value.left) };
    }
  } catch {
    /* ignore invalid legacy data */
  }
  return { top: 0, left: 0 };
}
export function readPdfPosition(key: string): PdfPosition | null {
  try {
    const p = JSON.parse(readPositionValue(key) ?? 'null') as PdfPosition | null;
    if (
      !p ||
      !Number.isInteger(p.page) ||
      p.page < 1 ||
      !Number.isFinite(p.top) ||
      !Number.isFinite(p.left) ||
      ![0, 90, 180, 270].includes(p.rotation) ||
      typeof p.zoom !== 'string' ||
      !(
        ['auto', 'page-width', 'page-fit'].includes(p.zoom) ||
        (Number(p.zoom) >= 0.1 && Number(p.zoom) <= 10)
      )
    )
      return null;
    return p;
  } catch {
    return null;
  }
}

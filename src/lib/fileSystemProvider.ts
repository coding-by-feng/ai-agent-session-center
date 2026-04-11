/**
 * fileSystemProvider.ts — Abstraction over file system access.
 *
 * Two implementations:
 *   ApiProvider  — fetches from /api/files/* (works always, required for remote)
 *   LocalProvider — uses File System Access API (Chromium only, localhost)
 */

// File System Access API type augmentation (Chromium only)
declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: string;
}

export interface FileContent {
  path: string;
  content?: string;
  ext?: string;
  size: number;
  name: string;
  binary?: boolean;
  streamable?: boolean;
  blobUrl?: string;
  sheets?: Array<{ name: string; data: string[][] }>;
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
}

export interface FileSystemProvider {
  readonly kind: 'api' | 'local';

  listDir(projectRoot: string, relPath: string, showHidden?: boolean): Promise<{ path: string; items: DirEntry[] }>;
  readFile(projectRoot: string, relPath: string): Promise<FileContent>;
  /** Returns a URL for streaming binary content (PDF, images, video, audio). */
  streamUrl(projectRoot: string, relPath: string): string;
  writeFile(projectRoot: string, relPath: string, content: string): Promise<void>;
  mkdir(projectRoot: string, relPath: string): Promise<void>;
  deleteEntry(projectRoot: string, relPath: string): Promise<void>;
  searchFiles(projectRoot: string, query: string): Promise<{ results: Array<{ path: string; name: string; type: 'dir' | 'file' }>; indexing: boolean }>;
  grepContent(projectRoot: string, query: string, glob?: string): Promise<GrepResult>;
  reveal(projectRoot: string, relPath: string): Promise<void>;
  invalidateSearchCache(projectRoot: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// API Provider (default — fetches from Express backend)
// ---------------------------------------------------------------------------

export class ApiFileSystemProvider implements FileSystemProvider {
  readonly kind = 'api' as const;

  async listDir(projectRoot: string, relPath: string, showHidden = false) {
    const params = new URLSearchParams({ root: projectRoot, path: relPath });
    if (showHidden) params.set('showHidden', 'true');
    const res = await fetch(`/api/files/list?${params}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(data.error || res.statusText);
    }
    return res.json();
  }

  async readFile(projectRoot: string, relPath: string): Promise<FileContent> {
    const params = new URLSearchParams({ root: projectRoot, path: relPath });
    const res = await fetch(`/api/files/read?${params}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(data.error || res.statusText);
    }
    return res.json();
  }

  streamUrl(projectRoot: string, relPath: string): string {
    const params = new URLSearchParams({ root: projectRoot, path: relPath });
    return `/api/files/stream?${params}`;
  }

  async writeFile(projectRoot: string, relPath: string, content: string) {
    const res = await fetch('/api/files/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: projectRoot, path: relPath, content }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Write failed' }));
      throw new Error(data.error || 'Write failed');
    }
  }

  async mkdir(projectRoot: string, relPath: string) {
    const res = await fetch('/api/files/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: projectRoot, path: relPath }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Mkdir failed' }));
      throw new Error(data.error || 'Mkdir failed');
    }
  }

  async deleteEntry(projectRoot: string, relPath: string) {
    const res = await fetch('/api/files/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: projectRoot, path: relPath }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Delete failed' }));
      throw new Error(data.error || 'Delete failed');
    }
  }

  async searchFiles(projectRoot: string, query: string) {
    const params = new URLSearchParams({ root: projectRoot, q: query });
    const res = await fetch(`/api/files/search?${params}`);
    if (!res.ok) return { results: [], indexing: false };
    return res.json();
  }

  async grepContent(projectRoot: string, query: string, glob?: string): Promise<GrepResult> {
    const params = new URLSearchParams({ root: projectRoot, q: query });
    if (glob) params.set('glob', glob);
    const res = await fetch(`/api/files/grep?${params}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Grep failed' }));
      throw new Error(data.error || 'Grep failed');
    }
    return res.json();
  }

  async reveal(projectRoot: string, relPath: string) {
    await fetch('/api/files/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: projectRoot, path: relPath }),
    }).catch(() => {});
  }

  async invalidateSearchCache(projectRoot: string) {
    await fetch('/api/files/search/invalidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: projectRoot }),
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Local Provider (File System Access API — Chromium only)
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.mdx', '.ts', '.tsx', '.js', '.jsx', '.json', '.yaml', '.yml',
  '.toml', '.css', '.scss', '.html', '.xml', '.svg', '.py', '.go', '.rs', '.java',
  '.sh', '.bash', '.zsh', '.sql', '.graphql', '.c', '.cpp', '.h', '.hpp', '.cs',
  '.rb', '.php', '.swift', '.kt', '.lua', '.r', '.env', '.gitignore', '.dockerignore',
  '.editorconfig', '.prettierrc', '.eslintrc', '.lock', '.jsonl', '.ndjson',
]);

const STREAMABLE_EXTENSIONS = new Set([
  '.pdf', '.xlsx', '.xls', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.bmp', '.ico', '.avif', '.mp4', '.webm', '.ogg', '.mov', '.mp3', '.wav',
  '.flac', '.aac', '.m4a',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', 'venv', '.next', '.nuxt',
  'dist', 'build', 'coverage', '.cache', '.turbo', '.svelte-kit',
]);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function isTextByName(name: string): boolean {
  const ext = extOf(name);
  if (ext === '') return true; // extensionless files treated as text
  return TEXT_EXTENSIONS.has(ext);
}

export class LocalFileSystemProvider implements FileSystemProvider {
  readonly kind = 'local' as const;
  private handles = new Map<string, FileSystemDirectoryHandle>();

  /** Check if the File System Access API is available. */
  static isSupported(): boolean {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  }

  /** Prompt user to pick a directory, store the handle. */
  async requestAccess(projectRoot: string): Promise<boolean> {
    try {
      const handle = await window.showDirectoryPicker!({ mode: 'readwrite' });
      this.handles.set(projectRoot, handle);
      return true;
    } catch {
      return false;
    }
  }

  hasAccess(projectRoot: string): boolean {
    return this.handles.has(projectRoot);
  }

  private getHandle(projectRoot: string): FileSystemDirectoryHandle {
    const h = this.handles.get(projectRoot);
    if (!h) throw new Error('No local access granted for this project. Call requestAccess() first.');
    return h;
  }

  private async resolvePath(root: FileSystemDirectoryHandle, relPath: string): Promise<FileSystemDirectoryHandle | FileSystemFileHandle> {
    const parts = relPath.replace(/^\/+/, '').split('/').filter(Boolean);
    let current: FileSystemDirectoryHandle = root;
    for (let i = 0; i < parts.length - 1; i++) {
      current = await current.getDirectoryHandle(parts[i]);
    }
    if (parts.length === 0) return current;
    const last = parts[parts.length - 1];
    try {
      return await current.getDirectoryHandle(last);
    } catch {
      return await current.getFileHandle(last);
    }
  }

  private async resolveDir(root: FileSystemDirectoryHandle, relPath: string): Promise<FileSystemDirectoryHandle> {
    const parts = relPath.replace(/^\/+/, '').split('/').filter(Boolean);
    let current: FileSystemDirectoryHandle = root;
    for (const part of parts) {
      current = await current.getDirectoryHandle(part);
    }
    return current;
  }

  async listDir(projectRoot: string, relPath: string, showHidden = false) {
    const root = this.getHandle(projectRoot);
    const dir = await this.resolveDir(root, relPath);
    const items: DirEntry[] = [];

    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory' && SKIP_DIRS.has(name)) continue;
      if (!showHidden && name.startsWith('.')) continue;
      if (handle.kind === 'file') {
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          items.push({ name, type: 'file', size: file.size, mtime: new Date(file.lastModified).toISOString() });
        } catch {
          items.push({ name, type: 'file' });
        }
      } else {
        items.push({ name, type: 'dir' });
      }
    }

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return { path: relPath, items };
  }

  async readFile(projectRoot: string, relPath: string): Promise<FileContent> {
    const root = this.getHandle(projectRoot);
    const handle = await this.resolvePath(root, relPath) as FileSystemFileHandle;
    const file = await handle.getFile();
    const name = file.name;
    const ext = extOf(name).replace('.', '');
    const size = file.size;

    if (STREAMABLE_EXTENSIONS.has(extOf(name))) {
      const blobUrl = URL.createObjectURL(file);
      return { path: relPath, streamable: true, ext, size, name, blobUrl };
    }

    if (!isTextByName(name) || size > 10 * 1024 * 1024) {
      return { path: relPath, binary: true, size, name };
    }

    const content = await file.text();
    return { path: relPath, content, ext, size, name };
  }

  streamUrl(_projectRoot: string, _relPath: string): string {
    // Local provider creates blob URLs in readFile instead
    return '';
  }

  async writeFile(projectRoot: string, relPath: string, content: string) {
    const root = this.getHandle(projectRoot);
    const parts = relPath.replace(/^\/+/, '').split('/').filter(Boolean);
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: true });
    }
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async mkdir(projectRoot: string, relPath: string) {
    const root = this.getHandle(projectRoot);
    const parts = relPath.replace(/^\/+/, '').split('/').filter(Boolean);
    let dir = root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
  }

  async deleteEntry(projectRoot: string, relPath: string) {
    const root = this.getHandle(projectRoot);
    const parts = relPath.replace(/^\/+/, '').split('/').filter(Boolean);
    if (parts.length === 0) throw new Error('Cannot delete project root');
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      parent = await parent.getDirectoryHandle(parts[i]);
    }
    await parent.removeEntry(parts[parts.length - 1], { recursive: true });
  }

  async searchFiles(projectRoot: string, query: string) {
    // Fall back to API for fuzzy search (requires server-side index)
    const api = new ApiFileSystemProvider();
    return api.searchFiles(projectRoot, query);
  }

  async grepContent(projectRoot: string, query: string, glob?: string): Promise<GrepResult> {
    // Fall back to API for grep (requires server-side grep/ripgrep)
    const api = new ApiFileSystemProvider();
    return api.grepContent(projectRoot, query, glob);
  }

  async reveal(projectRoot: string, relPath: string) {
    // Fall back to API (requires server-side open command)
    const api = new ApiFileSystemProvider();
    return api.reveal(projectRoot, relPath);
  }

  async invalidateSearchCache(projectRoot: string) {
    const api = new ApiFileSystemProvider();
    return api.invalidateSearchCache(projectRoot);
  }
}

// ---------------------------------------------------------------------------
// Singleton + detection
// ---------------------------------------------------------------------------

let _provider: FileSystemProvider | null = null;

export function getFileSystemProvider(): FileSystemProvider {
  if (!_provider) {
    _provider = new ApiFileSystemProvider();
  }
  return _provider;
}

export function setFileSystemProvider(p: FileSystemProvider): void {
  _provider = p;
}

/** Check if we're running on localhost (candidate for local FS access). */
export function isLocalHost(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

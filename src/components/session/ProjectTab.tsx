/**
 * ProjectTab — interactive file browser for a session's project directory.
 * Features: icon toolbar, file tabs, fuzzy search, new file/folder, draggable split.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';
import styles from '@/styles/modules/ProjectTab.module.css';

interface ProjectTabProps {
  projectPath: string;
  initialPath?: string;
  /** True if initialPath points to a file (restore file view on mount) */
  initialIsFile?: boolean;
  /** When set, programmatically navigates to this file path */
  navigateToFile?: string | null;
  onOpenBrowserTab?: (projectPath: string, currentDir: string) => void;
  onPathChange?: (currentPath: string, isFile: boolean) => void;
}

interface DirEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
}

interface FileContent {
  path: string;
  content?: string;
  ext?: string;
  size: number;
  name: string;
  binary?: boolean;
  streamable?: boolean;
  /** Blob object URL for streamable files (PDF, etc.) */
  blobUrl?: string;
}

interface FileTab {
  path: string;
  name: string;
}

interface Bookmark {
  id: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  selectedText: string;
  note: string;
}

interface SearchResult {
  path: string;
  name: string;
  type: 'dir' | 'file';
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(name: string, type: 'dir' | 'file'): string {
  if (type === 'dir') return '\u{1F4C1}';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    md: '\u{1F4DD}', mdx: '\u{1F4DD}', txt: '\u{1F4C4}',
    ts: '\u{1F535}', tsx: '\u{1F535}', js: '\u{1F7E1}', jsx: '\u{1F7E1}',
    json: '\u{1F4CB}', yaml: '\u{1F4CB}', yml: '\u{1F4CB}', toml: '\u{1F4CB}',
    css: '\u{1F3A8}', scss: '\u{1F3A8}', html: '\u{1F310}',
    py: '\u{1F40D}', go: '\u{1F439}', rs: '\u{2699}', java: '\u2615',
    sh: '\u{1F4DF}', bash: '\u{1F4DF}', zsh: '\u{1F4DF}',
    sql: '\u{1F5C3}', graphql: '\u{1F5C3}',
    svg: '\u{1F5BC}', png: '\u{1F5BC}', jpg: '\u{1F5BC}', gif: '\u{1F5BC}',
    env: '\u{1F512}', lock: '\u{1F512}',
  };
  return map[ext] || '\u{1F4C4}';
}

/** Detect language from file path for code block highlighting. */
function langFromPath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', go: 'go', rs: 'rust', java: 'java', rb: 'ruby',
    sh: 'bash', bash: 'bash', zsh: 'bash', css: 'css', scss: 'scss',
    html: 'html', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    sql: 'sql', graphql: 'graphql', xml: 'xml', swift: 'swift', kt: 'kotlin',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
  };
  return ext ? map[ext] : undefined;
}

// ---- Inline SVG Icons ----

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="7" cy="7" r="5" />
      <line x1="11" y1="11" x2="14.5" y2="14.5" />
    </svg>
  );
}
function IconNewFile() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 1h6l4 4v10H3V1z" />
      <line x1="8" y1="7" x2="8" y2="13" />
      <line x1="5" y1="10" x2="11" y2="10" />
    </svg>
  );
}
function IconNewFolder() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1 3h5l2 2h7v9H1V3z" />
      <line x1="8" y1="8" x2="8" y2="12" />
      <line x1="6" y1="10" x2="10" y2="10" />
    </svg>
  );
}
function IconOpenProjectView() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="2" width="14" height="12" rx="1.5" />
      <line x1="1" y1="5.5" x2="15" y2="5.5" />
      <line x1="5.5" y1="5.5" x2="5.5" y2="14" />
    </svg>
  );
}
function IconRefresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 8a6 6 0 0 1 10.5-4" />
      <path d="M14 8a6 6 0 0 1-10.5 4" />
      <polyline points="12 1 13 4 10 4.5" />
      <polyline points="4 15 3 12 6 11.5" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="2" y1="2" x2="8" y2="8" />
      <line x1="8" y1="2" x2="2" y2="8" />
    </svg>
  );
}
function IconFormat() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="2" y1="3" x2="14" y2="3" />
      <line x1="5" y1="6.5" x2="14" y2="6.5" />
      <line x1="5" y1="10" x2="14" y2="10" />
      <line x1="2" y1="13.5" x2="11" y2="13.5" />
      <polyline points="2 5.5 3.5 7 2 8.5" />
    </svg>
  );
}

function IconBookmark({ active = false }: { active?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5">
      <path d="M3 2h10v13l-5-3.5L3 15V2z" strokeLinejoin="round" />
    </svg>
  );
}

function IconOutline() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="2" y1="3" x2="10" y2="3" />
      <line x1="4" y1="6.5" x2="13" y2="6.5" />
      <line x1="4" y1="10" x2="11" y2="10" />
      <line x1="2" y1="13.5" x2="9" y2="13.5" />
    </svg>
  );
}

interface HeadingItem {
  level: number;
  text: string;
  slug: string;
}

/** Extract headings from markdown content for outline navigation. */
function extractHeadings(content: string): HeadingItem[] {
  const headings: HeadingItem[] = [];
  let inCodeBlock = false;
  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      const text = match[2].replace(/\s*#+\s*$/, '').trim();
      const slug = text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
      headings.push({ level: match[1].length, text, slug });
    }
  }
  return headings;
}

/** Generate a slug from heading text — must match what ReactMarkdown produces. */
function headingSlug(text: string): string {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}

/** Basic XML pretty-printer: normalises whitespace and re-indents. */
function formatXml(xml: string): string {
  let pad = 0;
  const lines: string[] = [];
  xml
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      const isClose = /^<\/[^>]+>/.test(line);
      const isSelfClose = /\/>$/.test(line) || /^<\?/.test(line) || /^<!/.test(line);
      const inlineClose = !isClose && !isSelfClose && line.includes('</');
      if (isClose) pad = Math.max(0, pad - 1);
      lines.push('  '.repeat(pad) + line);
      if (!isClose && !isSelfClose && !inlineClose && /^<[^?!/]/.test(line)) pad++;
    });
  return lines.join('\n');
}

// ---- Search Overlay ----

function SearchOverlay({
  projectPath,
  onSelect,
  onClose,
}: {
  projectPath: string;
  onSelect: (result: SearchResult) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/files/search?root=${encodeURIComponent(projectPath)}&q=${encodeURIComponent(query.trim())}`
        );
        if (res.ok) {
          const data = await res.json();
          setResults(data.results || []);
          setSelectedIdx(0);
        }
      } catch { /* ignore */ }
      setLoading(false);
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [query, projectPath]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, results.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter' && results[selectedIdx]) { onSelect(results[selectedIdx]); return; }
  }, [results, selectedIdx, onSelect, onClose]);

  return (
    <div className={styles.searchOverlay} onClick={onClose}>
      <div className={styles.searchModal} onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className={styles.searchInput}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search files by name..."
          spellCheck={false}
        />
        <div className={styles.searchResults}>
          {loading && <div className={styles.searchHint}>Searching...</div>}
          {!loading && query && results.length === 0 && (
            <div className={styles.searchHint}>No matches</div>
          )}
          {results.map((r, i) => (
            <button
              key={r.path}
              className={`${styles.searchItem} ${i === selectedIdx ? styles.searchItemActive : ''}`}
              onClick={() => onSelect(r)}
              onMouseEnter={() => setSelectedIdx(i)}
            >
              <span className={styles.fileIcon}>{fileIcon(r.name, r.type)}</span>
              <span className={styles.searchName}>{r.name}</span>
              <span className={styles.searchPath}>{r.path}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- Inline Input (for new file / folder) ----

function InlineInput({
  placeholder,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter' && value.trim()) onSubmit(value.trim());
  }, [value, onSubmit, onCancel]);

  return (
    <div className={styles.inlineInput}>
      <input
        ref={inputRef}
        className={styles.inlineInputField}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onCancel}
        placeholder={placeholder}
        spellCheck={false}
      />
    </div>
  );
}

// ---- Main Component ----

export default function ProjectTab({ projectPath, initialPath, initialIsFile, navigateToFile, onOpenBrowserTab, onPathChange }: ProjectTabProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || '/');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [file, setFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // File tabs
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);

  // Overlays / inline modes
  const [showSearch, setShowSearch] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);

  // New file editor
  const [editingNewFile, setEditingNewFile] = useState<string | null>(null);
  const [newFileContent, setNewFileContent] = useState('');

  // Split resize
  const [splitRatio, setSplitRatio] = useState(0.5);
  const splitDragging = useRef(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  // Bookmarks
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [showBookmarkPanel, setShowBookmarkPanel] = useState(false);
  const pendingScrollLine = useRef<number | null>(null);

  // Markdown outline (side panel with draggable divider)
  const [showOutline, setShowOutline] = useState(false);
  const markdownRef = useRef<HTMLDivElement>(null);
  const mdContainerRef = useRef<HTMLDivElement>(null);
  const [outlineWidth, setOutlineWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('outline-panel-width');
      if (saved) return Math.max(120, Math.min(400, Number(saved)));
    } catch { /* ignore */ }
    return 180;
  });
  const outlineWidthRef = useRef(outlineWidth);
  outlineWidthRef.current = outlineWidth;

  const onOutlineDividerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = outlineWidthRef.current;
    const containerWidth = mdContainerRef.current?.clientWidth ?? 800;
    const maxWidth = Math.min(400, Math.floor(containerWidth * 0.45));
    const onMove = (ev: MouseEvent) => {
      const newWidth = Math.max(120, Math.min(maxWidth, startWidth + (ev.clientX - startX)));
      setOutlineWidth(newWidth);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem('outline-panel-width', String(outlineWidthRef.current)); } catch { /* ignore */ }
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const loadDir = useCallback(async (relPath: string) => {
    setLoading(true);
    setError(null);
    setFile(null);
    setActiveTabPath(null);
    setEditingNewFile(null);
    try {
      const res = await fetch(`/api/files/list?root=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(relPath)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(data.error || res.statusText);
      }
      const data = await res.json();
      setEntries(data.items);
      setCurrentPath(relPath);
      onPathChange?.(relPath, false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [projectPath, onPathChange]);

  const loadFile = useCallback(async (relPath: string) => {
    // Revoke previous blob URL to prevent memory leaks
    setFile((prev) => { if (prev?.blobUrl) URL.revokeObjectURL(prev.blobUrl); return prev; });
    setLoading(true);
    setError(null);
    setEditingNewFile(null);
    try {
      const res = await fetch(`/api/files/read?root=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(relPath)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(data.error || res.statusText);
      }
      const data: FileContent = await res.json();
      // For streamable files (PDF), fetch the raw bytes as a blob
      if (data.streamable) {
        const streamRes = await fetch(`/api/files/stream?root=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(relPath)}`);
        if (streamRes.ok) {
          const blob = await streamRes.blob();
          data.blobUrl = URL.createObjectURL(blob);
        }
      }
      setFile(data);
      setCurrentPath(relPath);
      onPathChange?.(relPath, true);

      // Add to tabs if not already open
      const name = relPath.split('/').pop() || relPath;
      setTabs(prev => {
        if (prev.some(t => t.path === relPath)) return prev;
        return [...prev, { path: relPath, name }];
      });
      setActiveTabPath(relPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [projectPath, onPathChange]);

  // Load initial path on mount — restore file or directory
  useEffect(() => {
    if (!projectPath) return;
    if (initialIsFile && initialPath) {
      loadFile(initialPath);
    } else {
      loadDir(initialPath || '/');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  // Navigate to file when triggered externally (e.g. clicked file path in terminal)
  useEffect(() => {
    if (navigateToFile && projectPath) {
      loadFile(navigateToFile);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigateToFile]);

  // Bookmark persistence — keyed per project
  const bookmarkKey = useMemo(() => `agent-manager:bookmarks:${projectPath}`, [projectPath]);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(bookmarkKey);
      if (saved) setBookmarks(JSON.parse(saved));
    } catch {}
  }, [bookmarkKey]);
  useEffect(() => {
    try { localStorage.setItem(bookmarkKey, JSON.stringify(bookmarks)); } catch {}
  }, [bookmarks, bookmarkKey]);

  // After cross-file jump: scroll to the pending line once the new file renders
  useEffect(() => {
    if (pendingScrollLine.current !== null && file) {
      const line = pendingScrollLine.current;
      pendingScrollLine.current = null;
      requestAnimationFrame(() => {
        document.getElementById(`fv-line-${line}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }, [file]);

  const navigateUp = useCallback(() => {
    if (file || editingNewFile) {
      const parts = currentPath.split('/').filter(Boolean);
      parts.pop();
      loadDir('/' + parts.join('/'));
      return;
    }
    if (currentPath === '/') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    loadDir('/' + parts.join('/'));
  }, [currentPath, file, editingNewFile, loadDir]);

  const handleEntryClick = useCallback((entry: DirEntry) => {
    const newPath = currentPath === '/'
      ? '/' + entry.name
      : currentPath + '/' + entry.name;
    if (entry.type === 'dir') {
      loadDir(newPath);
    } else {
      loadFile(newPath);
    }
  }, [currentPath, loadDir, loadFile]);

  // Tab actions
  const handleTabClick = useCallback((tab: FileTab) => {
    setActiveTabPath(tab.path);
    loadFile(tab.path);
  }, [loadFile]);

  const handleTabClose = useCallback((tabPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTabs(prev => {
      const next = prev.filter(t => t.path !== tabPath);
      if (activeTabPath === tabPath) {
        if (next.length > 0) {
          const last = next[next.length - 1];
          setActiveTabPath(last.path);
          loadFile(last.path);
        } else {
          setActiveTabPath(null);
          setFile(null);
          // Go back to directory listing
          const parts = tabPath.split('/').filter(Boolean);
          parts.pop();
          loadDir('/' + parts.join('/'));
        }
      }
      return next;
    });
  }, [activeTabPath, loadFile, loadDir]);

  // Search select
  const handleSearchSelect = useCallback((result: SearchResult) => {
    setShowSearch(false);
    if (result.type === 'dir') {
      loadDir(result.path);
    } else {
      loadFile(result.path);
    }
  }, [loadDir, loadFile]);

  // New file
  const handleNewFile = useCallback(async (name: string) => {
    setCreatingFile(false);
    const newPath = currentPath === '/' ? '/' + name : currentPath + '/' + name;
    setEditingNewFile(newPath);
    setNewFileContent('');
    setFile(null);
  }, [currentPath]);

  const handleSaveNewFile = useCallback(async () => {
    if (!editingNewFile) return;
    try {
      const res = await fetch('/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: projectPath, path: editingNewFile, content: newFileContent }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Write failed' }));
        setError(data.error || 'Write failed');
        return;
      }
      setEditingNewFile(null);
      // Open the file in a tab
      loadFile(editingNewFile);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [editingNewFile, newFileContent, projectPath, loadFile]);

  const handleCancelNewFile = useCallback(() => {
    setEditingNewFile(null);
    setNewFileContent('');
  }, []);

  // New folder
  const handleNewFolder = useCallback(async (name: string) => {
    setCreatingFolder(false);
    const newPath = currentPath === '/' ? '/' + name : currentPath + '/' + name;
    try {
      const res = await fetch('/api/files/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: projectPath, path: newPath }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Mkdir failed' }));
        setError(data.error || 'Mkdir failed');
        return;
      }
      loadDir(currentPath); // refresh
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [currentPath, projectPath, loadDir]);

  // Refresh
  const handleRefresh = useCallback(() => {
    if (file) {
      loadFile(currentPath);
    } else {
      loadDir(currentPath);
    }
  }, [currentPath, file, loadDir, loadFile]);

  // Open the project file browser in a standalone new tab
  const handleOpenProjectView = useCallback(() => {
    // Pass the current browsing directory so the new tab label is meaningful
    const browseDir = file ? currentPath.split('/').slice(0, -1).join('/') || '/' : currentPath;
    if (onOpenBrowserTab) {
      onOpenBrowserTab(projectPath, browseDir);
    } else {
      window.open(`/project-browser?path=${encodeURIComponent(projectPath)}`, '_blank');
    }
  }, [projectPath, currentPath, file, onOpenBrowserTab]);

  // Bookmark: add from selection or toggle panel
  const handleBookmarkBtnClick = useCallback(() => {
    const sel = window.getSelection();
    const selectedText = sel?.toString().trim() ?? '';
    if (file && selectedText && file.content?.includes(selectedText)) {
      const content = file.content;
      const idx = content.indexOf(selectedText);
      const lineStart = content.slice(0, idx).split('\n').length;
      const lineEnd = lineStart + selectedText.split('\n').length - 1;
      const bookmark: Bookmark = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        filePath: file.path,
        lineStart,
        lineEnd,
        selectedText: selectedText.slice(0, 300),
        note: '',
      };
      setBookmarks(prev => [...prev, bookmark]);
      setShowBookmarkPanel(true);
      sel!.removeAllRanges();
    } else {
      setShowBookmarkPanel(prev => !prev);
    }
  }, [file]);

  const handleDeleteBookmark = useCallback((id: string) => {
    setBookmarks(prev => prev.filter(b => b.id !== id));
  }, []);

  const handleBookmarkNoteChange = useCallback((id: string, note: string) => {
    setBookmarks(prev => prev.map(b => b.id === id ? { ...b, note } : b));
  }, []);

  const handleJumpToBookmark = useCallback((bookmark: Bookmark) => {
    if (bookmark.filePath !== file?.path) {
      pendingScrollLine.current = bookmark.lineStart;
      loadFile(bookmark.filePath);
    } else {
      document.getElementById(`fv-line-${bookmark.lineStart}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [file, loadFile]);

  // Format the currently viewed file (JSON / XML / SVG)
  const handleFormatFile = useCallback(() => {
    if (!file || file.binary || !file.content) return;
    const ext = (file.ext ?? file.path.split('.').pop() ?? '').toLowerCase();
    let formatted: string | null = null;
    if (ext === 'json') {
      try { formatted = JSON.stringify(JSON.parse(file.content), null, 2); } catch { /* invalid JSON */ }
    } else if (ext === 'xml' || ext === 'svg' || ext === 'html' || ext === 'xhtml') {
      formatted = formatXml(file.content);
    }
    if (formatted !== null && formatted !== file.content) {
      setFile({ ...file, content: formatted });
    }
  }, [file]);

  // Split drag handlers
  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    splitDragging.current = true;
    const startX = e.clientX;
    const startRatio = splitRatio;
    const container = splitContainerRef.current;
    if (!container) return;
    const containerWidth = container.offsetWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!splitDragging.current) return;
      const delta = ev.clientX - startX;
      const newRatio = Math.max(0.2, Math.min(0.8, startRatio + delta / containerWidth));
      setSplitRatio(newRatio);
    };
    const onMouseUp = () => {
      splitDragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [splitRatio]);

  // Breadcrumb segments
  const breadcrumbs = currentPath.split('/').filter(Boolean);
  const projectName = projectPath.split('/').filter(Boolean).pop() || projectPath;

  // Determine if we're showing file content (from tab or direct) or directory listing
  const showingFile = file && activeTabPath;
  const showingEditor = editingNewFile !== null;

  // Directory path for context (file's parent dir or current dir)
  const dirPath = useMemo(() => {
    if (showingFile || showingEditor) {
      const path = showingFile ? currentPath : editingNewFile!;
      const parts = path.split('/').filter(Boolean);
      parts.pop();
      return '/' + parts.join('/');
    }
    return currentPath;
  }, [showingFile, showingEditor, currentPath, editingNewFile]);

  return (
    <div className={styles.projectTab}>
      {/* Icon toolbar */}
      <div className={styles.iconBar}>
        <button className={styles.iconBtn} onClick={() => setShowSearch(true)} title="Search files (fuzzy)">
          <IconSearch />
        </button>
        <button className={styles.iconBtn} onClick={() => setCreatingFile(true)} title="New file">
          <IconNewFile />
        </button>
        <button className={styles.iconBtn} onClick={() => setCreatingFolder(true)} title="New folder">
          <IconNewFolder />
        </button>
        <button className={styles.iconBtn} onClick={handleRefresh} title="Refresh">
          <IconRefresh />
        </button>
        <button className={styles.iconBtn} onClick={handleOpenProjectView} title="Open project in new tab">
          <IconOpenProjectView />
        </button>
        <button
          className={styles.iconBtn}
          onClick={handleFormatFile}
          disabled={!file || !!file.binary}
          title="Format file (JSON / XML)"
        >
          <IconFormat />
        </button>
        <button
          className={`${styles.iconBtn} ${showOutline ? styles.iconBtnActive : ''}`}
          onClick={() => setShowOutline((p) => !p)}
          disabled={!file || (file.ext !== 'md' && file.ext !== 'mdx')}
          title="Toggle markdown outline"
        >
          <IconOutline />
        </button>
        <button
          className={`${styles.iconBtn} ${showBookmarkPanel || bookmarks.length > 0 ? styles.iconBtnActive : ''}`}
          onClick={handleBookmarkBtnClick}
          title="Bookmark selected text / show bookmarks"
        >
          <IconBookmark active={bookmarks.length > 0} />
          {bookmarks.length > 0 && <span className={styles.bookmarkBadge}>{bookmarks.length}</span>}
        </button>
      </div>

      {/* Path bar */}
      <div className={styles.toolbar}>
        <button
          className={styles.backBtn}
          onClick={navigateUp}
          disabled={currentPath === '/' && !file && !editingNewFile}
          title="Go up"
        >
          &#8592;
        </button>
        <div className={styles.breadcrumb}>
          <button className={styles.breadBtn} onClick={() => { setFile(null); setActiveTabPath(null); setEditingNewFile(null); loadDir('/'); }}>
            {projectName}
          </button>
          {breadcrumbs.map((seg, i) => {
            const isLast = i === breadcrumbs.length - 1;
            const segPath = '/' + breadcrumbs.slice(0, i + 1).join('/');
            return (
              <span key={segPath}>
                <span className={styles.breadSep}>/</span>
                {isLast && !showingFile && !showingEditor ? (
                  <span className={styles.breadCurrent}>{seg}</span>
                ) : (
                  <button className={styles.breadBtn} onClick={() => { setFile(null); setActiveTabPath(null); setEditingNewFile(null); loadDir(segPath); }}>
                    {seg}
                  </button>
                )}
              </span>
            );
          })}
        </div>
      </div>

      {/* Inline new file/folder inputs */}
      {creatingFile && (
        <InlineInput
          placeholder="filename.ext"
          onSubmit={handleNewFile}
          onCancel={() => setCreatingFile(false)}
        />
      )}
      {creatingFolder && (
        <InlineInput
          placeholder="folder name"
          onSubmit={handleNewFolder}
          onCancel={() => setCreatingFolder(false)}
        />
      )}

      {/* Content area + bookmark panel below */}
      <div className={styles.contentCol}>
      <div className={styles.content} ref={splitContainerRef}>
        {loading && <div className={styles.empty}>Loading...</div>}

        {error && <div className={styles.empty} style={{ color: 'var(--accent-red)' }}>{error}</div>}

        {/* New file editor */}
        {!loading && !error && showingEditor && (
          <div className={styles.newFileEditor}>
            <div className={styles.newFileHeader}>
              <span className={styles.newFileName}>{editingNewFile}</span>
              <div className={styles.newFileActions}>
                <button className={styles.newFileSave} onClick={handleSaveNewFile}>Save</button>
                <button className={styles.newFileCancel} onClick={handleCancelNewFile}>Cancel</button>
              </div>
            </div>
            <textarea
              className={styles.newFileTextarea}
              value={newFileContent}
              onChange={e => setNewFileContent(e.target.value)}
              placeholder="Type file content..."
              autoFocus
              spellCheck={false}
            />
          </div>
        )}

        {/* Directory listing */}
        {!loading && !error && !file && !showingEditor && entries.length === 0 && (
          <div className={styles.empty}>EMPTY DIRECTORY</div>
        )}

        {!loading && !error && !file && !showingEditor && entries.length > 0 && (
          <div className={styles.fileList}>
            {entries.map((entry) => (
              <button
                key={entry.name}
                className={styles.fileEntry}
                onClick={() => handleEntryClick(entry)}
              >
                <span className={styles.fileIcon}>{fileIcon(entry.name, entry.type)}</span>
                <span className={styles.fileName}>{entry.name}</span>
                {entry.type === 'file' && entry.size != null && (
                  <span className={styles.fileSize}>{formatSize(entry.size)}</span>
                )}
                {entry.type === 'dir' && <span className={styles.fileChevron}>&#8250;</span>}
              </button>
            ))}
          </div>
        )}

        {/* File viewer */}
        {!loading && !error && file && !showingEditor && (
          <div className={styles.fileViewer}>
            {file.streamable && file.ext === 'pdf' && file.blobUrl ? (
              <iframe
                src={file.blobUrl}
                className={styles.pdfViewer}
                title={file.name}
              />
            ) : file.binary ? (
              <div className={styles.empty}>
                Binary file ({formatSize(file.size)})
              </div>
            ) : file.ext === 'md' || file.ext === 'mdx' ? (
              <div className={styles.mdContainer} ref={mdContainerRef}>
                {showOutline && (
                  <>
                    <div className={styles.outlinePanel} style={{ width: outlineWidth, minWidth: outlineWidth }}>
                      <div className={styles.outlineHeader}>OUTLINE</div>
                      <div className={styles.outlineList}>
                        {extractHeadings(file.content || '').map((h, i) => (
                          <button
                            key={i}
                            className={styles.outlineItem}
                            style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
                            onClick={() => {
                              const el = markdownRef.current?.querySelector(`[id="${h.slug}"]`);
                              el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            }}
                          >
                            {h.text}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className={styles.outlineDivider} onMouseDown={onOutlineDividerDown} />
                  </>
                )}
                <div className={styles.markdown} ref={markdownRef}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
                      a: ({ children, ...props }) => (
                        <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>
                      ),
                      h1: ({ children, ...props }) => <h1 id={headingSlug(String(children))} {...props}>{children}</h1>,
                      h2: ({ children, ...props }) => <h2 id={headingSlug(String(children))} {...props}>{children}</h2>,
                      h3: ({ children, ...props }) => <h3 id={headingSlug(String(children))} {...props}>{children}</h3>,
                      h4: ({ children, ...props }) => <h4 id={headingSlug(String(children))} {...props}>{children}</h4>,
                      h5: ({ children, ...props }) => <h5 id={headingSlug(String(children))} {...props}>{children}</h5>,
                      h6: ({ children, ...props }) => <h6 id={headingSlug(String(children))} {...props}>{children}</h6>,
                    }}
                  >
                    {file.content || ''}
                  </ReactMarkdown>
                </div>
              </div>
            ) : (
              <div className={styles.codeLines}>
                {(file.content || '').split('\n').map((line, i) => {
                  const lineNum = i + 1;
                  const isBookmarked = bookmarks.some(
                    b => b.filePath === file.path && lineNum >= b.lineStart && lineNum <= b.lineEnd
                  );
                  return (
                    <div
                      key={i}
                      id={`fv-line-${lineNum}`}
                      className={`${styles.codeLine}${isBookmarked ? ` ${styles.bookmarkedLine}` : ''}`}
                    >
                      <span className={styles.lineNum}>{lineNum}</span>
                      <span className={styles.lineText}>{line || '\u00A0'}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bookmark panel */}
      {showBookmarkPanel && (
        <div className={styles.bookmarkPanel}>
          <div className={styles.bookmarkPanelHeader}>
            <span className={styles.bookmarkPanelTitle}>BOOKMARKS ({bookmarks.length})</span>
            <button className={styles.bookmarkPanelClose} onClick={() => setShowBookmarkPanel(false)}>✕</button>
          </div>
          {bookmarks.length === 0 ? (
            <div className={styles.bookmarkEmpty}>
              Select text in the viewer, then click the bookmark icon to add.
            </div>
          ) : (
            <div className={styles.bookmarkList}>
              {bookmarks.map(bm => (
                <div
                  key={bm.id}
                  className={`${styles.bookmarkItem}${bm.filePath !== file?.path ? ` ${styles.bookmarkItemOther}` : ''}`}
                  onClick={() => handleJumpToBookmark(bm)}
                >
                  <div className={styles.bookmarkItemTop}>
                    <span className={styles.bookmarkItemLine}>
                      L{bm.lineStart}{bm.lineEnd !== bm.lineStart ? `–${bm.lineEnd}` : ''}
                    </span>
                    <span className={styles.bookmarkItemFile}>{bm.filePath.split('/').pop()}</span>
                    <button
                      className={styles.bookmarkItemDel}
                      onClick={e => { e.stopPropagation(); handleDeleteBookmark(bm.id); }}
                      title="Delete bookmark"
                    >✕</button>
                  </div>
                  <div className={styles.bookmarkItemText}>{bm.selectedText.slice(0, 120)}</div>
                  <input
                    className={styles.bookmarkItemNote}
                    placeholder="Add note..."
                    value={bm.note}
                    onChange={e => handleBookmarkNoteChange(bm.id, e.target.value)}
                    onClick={e => e.stopPropagation()}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </div>{/* end contentCol */}

      {/* Search overlay */}
      {showSearch && (
        <SearchOverlay
          projectPath={projectPath}
          onSelect={handleSearchSelect}
          onClose={() => setShowSearch(false)}
        />
      )}
    </div>
  );
}

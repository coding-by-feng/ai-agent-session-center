/**
 * ProjectTab — interactive file browser for a session's project directory.
 * Features: tree navigation, file tabs, fuzzy search, content search, new file/folder.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import * as XLSX from 'xlsx';
import 'highlight.js/styles/github-dark-dimmed.css';
import FileTree, { type FileTreeHandle } from './FileTree';
import ContentSearchModal from './ContentSearchModal';
import FindInFileBar, { highlightFindMatches } from './FindInFileBar';
import TexViewer from './TexViewer';
import {
  DEFAULT_VIEW,
  PAN_STEP,
  PERSIST_DEBOUNCE_MS,
  ZOOM_MAX,
  ZOOM_MIN,
  clampPan,
  fitToScreenRatio,
  imageViewKey,
  parseView,
  serializeView,
  zoomAroundCursor,
  zoomInStep,
  zoomOutStep,
  type ImageView,
} from './imageViewport';
import { getFileSystemProvider } from '@/lib/fileSystemProvider';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/ProjectTab.module.css';

interface ProjectTabProps {
  projectPath: string;
  initialPath?: string;
  /** True if initialPath points to a file (restore file view on mount) */
  initialIsFile?: boolean;
  /** When set, programmatically navigates to this file path */
  navigateToFile?: string | null;
  /** Unique ID used to persist file tabs across remounts (e.g. sub-tab id) */
  persistId?: string;
  onOpenBrowserTab?: (projectPath: string, currentDir: string, isFile?: boolean) => void;
  onPathChange?: (currentPath: string, isFile: boolean) => void;
}

interface DirEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: string;
}

type SortField = 'name' | 'date';
type SortDir = 'asc' | 'desc';

interface ExcelSheet {
  name: string;
  data: string[][];
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
  /** Parsed Excel sheets */
  sheets?: ExcelSheet[];
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

interface Collection {
  id: string;
  path: string;
  name: string;
  isFile: boolean;
  addedAt: number;
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

function formatDateTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogg', 'mov']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'aac', 'm4a']);
function isImageExt(ext?: string): boolean { return IMAGE_EXTS.has((ext ?? '').toLowerCase()); }
function isVideoExt(ext?: string): boolean { return VIDEO_EXTS.has((ext ?? '').toLowerCase()); }
function isAudioExt(ext?: string): boolean { return AUDIO_EXTS.has((ext ?? '').toLowerCase()); }

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
function IconContentSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="6" cy="6" r="4" />
      <line x1="9" y1="9" x2="13" y2="13" />
      <line x1="3" y1="5" x2="9" y2="5" />
      <line x1="3" y1="7" x2="8" y2="7" />
    </svg>
  );
}
function IconFindInFile() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="1" width="10" height="14" rx="1" />
      <circle cx="11" cy="11" r="3.5" />
      <line x1="13.5" y1="13.5" x2="15" y2="15" />
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
function IconRevealInFinder() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 3h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M1 6h14" />
      <path d="M5 1v2" />
      <path d="M8 10l2-2-2-2" />
      <line x1="5" y1="10" x2="10" y2="10" />
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

function IconCollect({ active = false }: { active?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <polygon points="8 1.5 9.9 5.9 14.5 6.2 11.2 9.1 12.2 13.6 8 11.2 3.8 13.6 4.8 9.1 1.5 6.2 6.1 5.9 8 1.5" />
    </svg>
  );
}

function IconFullscreen() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="1 5 1 1 5 1" />
      <polyline points="11 1 15 1 15 5" />
      <polyline points="15 11 15 15 11 15" />
      <polyline points="5 15 1 15 1 11" />
    </svg>
  );
}

function IconWordWrap() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="2" y1="3" x2="14" y2="3" />
      <line x1="2" y1="8" x2="11" y2="8" />
      <path d="M11 6v0a2.5 2.5 0 0 1 0 5h-2" strokeLinecap="round" />
      <polyline points="10.5 9.5 9 11 10.5 12.5" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="2" y1="13" x2="7" y2="13" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <polyline points="8 4.5 8 8 11 10" strokeLinecap="round" />
    </svg>
  );
}

function IconSortAlpha() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <text x="1" y="7" fontSize="6.5" fill="currentColor" stroke="none" fontWeight="700" fontFamily="monospace">A</text>
      <text x="1" y="14" fontSize="6.5" fill="currentColor" stroke="none" fontWeight="700" fontFamily="monospace">Z</text>
      <line x1="11" y1="3" x2="11" y2="13" />
      <polyline points="9 11 11 13 13 11" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconSortDate() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="5" cy="7.5" r="4" />
      <polyline points="5 5 5 7.5 7 9" strokeLinecap="round" />
      <line x1="12" y1="3" x2="12" y2="13" />
      <polyline points="10 11 12 13 14 11" strokeLinecap="round" strokeLinejoin="round" />
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

/** Threshold: files with more lines than this use virtualised rendering. */
const VIRTUALIZE_THRESHOLD = 10_000;
/** Fixed line height (px) used for virtual scroll math — 12px font * 1.6 line-height. */
const LINE_HEIGHT_PX = 20;
/** Extra lines rendered above/below the visible viewport. */
const OVERSCAN = 30;

/** Excel spreadsheet viewer — renders parsed sheets as tables. */
function ExcelViewer({ sheets }: { sheets: ExcelSheet[] }) {
  const [activeSheet, setActiveSheet] = useState(0);
  const sheet = sheets[activeSheet];
  if (!sheet) return null;

  // Find max column count across all rows — sheet_to_json omits trailing empty
  // cells, so rows can have different lengths. Pad to the widest row to keep
  // columns aligned and cell borders consistent.
  const colCount = useMemo(
    () => sheet.data.reduce((max, row) => Math.max(max, row.length), 0),
    [sheet.data],
  );

  return (
    <div className={styles.excelViewer}>
      {sheets.length > 1 && (
        <div className={styles.excelSheetTabs}>
          {sheets.map((s, i) => (
            <button
              key={i}
              className={`${styles.excelSheetTab}${i === activeSheet ? ` ${styles.excelSheetTabActive}` : ''}`}
              onClick={() => setActiveSheet(i)}
              type="button"
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className={styles.excelTableWrap}>
        <table className={styles.excelTable}>
          {sheet.data.length > 0 && (
            <thead>
              <tr>
                <th className={styles.excelRowNum}>#</th>
                {Array.from({ length: colCount }, (_, ci) => (
                  <th key={ci}>{sheet.data[0][ci] ?? ''}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {sheet.data.slice(1).map((row, ri) => (
              <tr key={ri}>
                <td className={styles.excelRowNum}>{ri + 2}</td>
                {Array.from({ length: colCount }, (_, ci) => (
                  <td key={ci}>{row[ci] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Virtualised code viewer for very large files. */
function VirtualCodeViewer({
  content,
  filePath,
  bookmarks: bmarks,
  wordWrap,
  scrollKey,
  findTerm: vFindTerm,
  findCaseSensitive: vFindCase,
  scrollToLine,
  activeMatch,
}: {
  content: string;
  filePath: string;
  bookmarks: Bookmark[];
  wordWrap: boolean;
  scrollKey?: string;
  findTerm?: string;
  findCaseSensitive?: boolean;
  scrollToLine?: { line: number; key: number } | null;
  activeMatch?: { line: number; col: number } | null;
}) {
  const lines = useMemo(() => content.split('\n'), [content]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(600);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Restore saved scroll position
    if (scrollKey) {
      try {
        const saved = localStorage.getItem(scrollKey);
        if (saved) { el.scrollTop = parseInt(saved, 10); setScrollTop(parseInt(saved, 10)); }
      } catch { /* ignore */ }
    }
    // Observe container resize to keep viewHeight accurate
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setViewHeight(entry.contentRect.height);
    });
    ro.observe(el);
    setViewHeight(el.clientHeight);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (scrollKey) {
      try { localStorage.setItem(scrollKey, String(el.scrollTop)); } catch { /* ignore */ }
    }
  }, [scrollKey]);

  // Programmatic scroll-to-line for find-in-file (element may not be in DOM due to virtualization)
  useEffect(() => {
    if (!scrollToLine || !containerRef.current) return;
    const target = (scrollToLine.line - 1) * LINE_HEIGHT_PX;
    const center = target - containerRef.current.clientHeight / 2;
    containerRef.current.scrollTop = Math.max(0, center);
    setScrollTop(containerRef.current.scrollTop);
    if (scrollKey) {
      try { localStorage.setItem(scrollKey, String(containerRef.current.scrollTop)); } catch { /* ignore */ }
    }
  }, [scrollToLine, scrollKey]);

  const totalHeight = lines.length * LINE_HEIGHT_PX;
  const startIdx = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT_PX) - OVERSCAN);
  const endIdx = Math.min(lines.length, Math.ceil((scrollTop + viewHeight) / LINE_HEIGHT_PX) + OVERSCAN);

  const bookmarkedSet = useMemo(() => {
    const set = new Set<number>();
    for (const b of bmarks) {
      if (b.filePath === filePath) {
        for (let l = b.lineStart; l <= b.lineEnd; l++) set.add(l);
      }
    }
    return set;
  }, [bmarks, filePath]);

  return (
    <div
      ref={containerRef}
      className={`${styles.codeLines}${wordWrap ? ` ${styles.codeLinesWrap}` : ''}`}
      onScroll={handleScroll}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        {Array.from({ length: endIdx - startIdx }, (_, offset) => {
          const i = startIdx + offset;
          const lineNum = i + 1;
          const isBookmarked = bookmarkedSet.has(lineNum);
          return (
            <div
              key={i}
              id={`fv-line-${lineNum}`}
              className={`${styles.codeLine}${isBookmarked ? ` ${styles.bookmarkedLine}` : ''}`}
              style={{ position: 'absolute', top: i * LINE_HEIGHT_PX, left: 0, right: 0, height: LINE_HEIGHT_PX }}
            >
              <span className={styles.lineNum}>{lineNum}</span>
              <span className={styles.lineText}>
                {vFindTerm
                  ? highlightFindMatches(lines[i], vFindTerm, vFindCase ?? false, activeMatch ?? undefined, lineNum)
                  : (lines[i] || '\u00A0')}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
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
  const [indexing, setIndexing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const searchProvider = useMemo(() => getFileSystemProvider(), []);

  useEffect(() => {
    inputRef.current?.focus();
    // Invalidate stale cache then preload fresh index
    searchProvider.invalidateSearchCache(projectPath)
      .then(() => searchProvider.searchFiles(projectPath, '__preload__'))
      .catch(() => {});
  }, [projectPath, searchProvider]);

  useEffect(() => {
    if (!query.trim()) { setResults([]); setLoading(false); return; }

    // Cancel any in-flight request
    abortRef.current?.abort();
    clearTimeout(debounceRef.current);

    setLoading(true);

    let cancelled = false;
    const doSearch = async (retryCount = 0) => {
      try {
        const data = await searchProvider.searchFiles(projectPath, query.trim());
        if (cancelled) return;
        setResults(data.results || []);
        setSelectedIdx(0);
        setIndexing(!!data.indexing);
        if (data.indexing && retryCount < 5) {
          debounceRef.current = setTimeout(() => doSearch(retryCount + 1), 300);
          return;
        }
      } catch {
        // ignore
      }
      if (!cancelled) setLoading(false);
    };

    debounceRef.current = setTimeout(() => doSearch(), 80);

    return () => {
      clearTimeout(debounceRef.current);
      cancelled = true;
    };
  }, [query, projectPath, searchProvider]);

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
          {loading && results.length === 0 && (
            <div className={styles.searchHint}>{indexing ? 'Indexing project files...' : 'Searching...'}</div>
          )}
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

// ---- Image Viewer subcomponent ----

interface ImageViewerProps {
  src: string;
  alt: string;
  filePath: string;
  /** Optional subtitle line shown below the image (e.g. "foo.png — 123 KB") */
  caption?: string;
}

/**
 * Image viewer with zoom, pan (drag), keyboard shortcuts, fit-to-screen, and
 * per-path persistence (localStorage). Shared between the inline and
 * fullscreen viewers.
 */
function ImageViewer({ src, alt, filePath, caption }: ImageViewerProps) {
  // Restore persisted view on mount. The parent re-mounts this component via
  // `key={file.path}` when the file changes, so the lazy initializer fires
  // exactly once per file — no follow-up "reset on path change" effect needed.
  const [view, setView] = useState<ImageView>(() => {
    try {
      const raw = localStorage.getItem(imageViewKey(filePath));
      return parseView(raw) ?? { ...DEFAULT_VIEW };
    } catch {
      return { ...DEFAULT_VIEW };
    }
  });
  const [isDragging, setIsDragging] = useState(false);
  const [isWheeling, setIsWheeling] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const wheelTimerRef = useRef<number | null>(null);

  // Persist view with a 200ms debounce so pan doesn't spam localStorage.
  useEffect(() => {
    const handle = setTimeout(() => {
      try {
        localStorage.setItem(imageViewKey(filePath), serializeView(view));
      } catch { /* quota or disabled storage — ignore */ }
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [view, filePath]);

  useEffect(() => () => {
    if (wheelTimerRef.current) window.clearTimeout(wheelTimerRef.current);
  }, []);

  // Helper: current container size
  const getContainerSize = useCallback((): { w: number; h: number } => {
    const el = containerRef.current;
    if (!el) return { w: 0, h: 0 };
    return { w: el.clientWidth, h: el.clientHeight };
  }, []);

  const zoomIn = useCallback(() => {
    setView((v) => {
      const nextZoom = zoomInStep(v.zoom);
      if (nextZoom === v.zoom) return v;
      const { w, h } = getContainerSize();
      const { panX, panY } = clampPan(v.panX, v.panY, nextZoom, w, h);
      return { zoom: nextZoom, panX, panY };
    });
  }, [getContainerSize]);

  const zoomOut = useCallback(() => {
    setView((v) => {
      const nextZoom = zoomOutStep(v.zoom);
      if (nextZoom === v.zoom) return v;
      const { w, h } = getContainerSize();
      const { panX, panY } = clampPan(v.panX, v.panY, nextZoom, w, h);
      return { zoom: nextZoom, panX, panY };
    });
  }, [getContainerSize]);

  const zoomReset = useCallback(() => setView({ ...DEFAULT_VIEW }), []);

  const fitToScreen = useCallback(() => {
    const natural = naturalSizeRef.current;
    if (!natural) return;
    const { w, h } = getContainerSize();
    const ratio = fitToScreenRatio(w, h, natural.w, natural.h);
    setView({ zoom: ratio, panX: 0, panY: 0 });
  }, [getContainerSize]);

  // Wheel: Ctrl/Meta+wheel always zooms; plain wheel zooms when container has focus.
  // Multiplicative scaling keeps the zoom rate proportional to the current zoom,
  // so the image zooms smoothly at any level (e.g. moving 100→200% feels the same
  // as 200→400%, instead of snapping in linear chunks above 100%).
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const isFocused = document.activeElement === containerRef.current;
    const wantsZoom = e.ctrlKey || e.metaKey || isFocused;
    if (!wantsZoom) return;
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.001);
    setIsWheeling(true);
    if (wheelTimerRef.current) window.clearTimeout(wheelTimerRef.current);
    wheelTimerRef.current = window.setTimeout(() => setIsWheeling(false), 140);
    setView((v) => zoomAroundCursor(v, v.zoom * factor, cursorX, cursorY, rect.width, rect.height));
  }, []);

  // Drag-to-pan (only when zoomed in)
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (view.zoom <= 1) return;
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
    setIsDragging(true);
  }, [view.zoom, view.panX, view.panY]);

  // Window-level mousemove/mouseup while dragging
  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent): void => {
      const start = dragStartRef.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      setView((v) => {
        const { w, h } = getContainerSize();
        const { panX, panY } = clampPan(start.panX + dx, start.panY + dy, v.zoom, w, h);
        return { ...v, panX, panY };
      });
    };
    const handleUp = (): void => {
      isDraggingRef.current = false;
      dragStartRef.current = null;
      setIsDragging(false);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [isDragging, getContainerSize]);

  // Keyboard shortcuts (attached to the container)
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case '+':
      case '=':
        e.preventDefault();
        zoomIn();
        break;
      case '-':
      case '_':
        e.preventDefault();
        zoomOut();
        break;
      case '0':
        e.preventDefault();
        zoomReset();
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        fitToScreen();
        break;
      case 'ArrowLeft':
        if (view.zoom > 1) {
          e.preventDefault();
          setView((v) => {
            const { w, h } = getContainerSize();
            const { panX, panY } = clampPan(v.panX + PAN_STEP, v.panY, v.zoom, w, h);
            return { ...v, panX, panY };
          });
        }
        break;
      case 'ArrowRight':
        if (view.zoom > 1) {
          e.preventDefault();
          setView((v) => {
            const { w, h } = getContainerSize();
            const { panX, panY } = clampPan(v.panX - PAN_STEP, v.panY, v.zoom, w, h);
            return { ...v, panX, panY };
          });
        }
        break;
      case 'ArrowUp':
        if (view.zoom > 1) {
          e.preventDefault();
          setView((v) => {
            const { w, h } = getContainerSize();
            const { panX, panY } = clampPan(v.panX, v.panY + PAN_STEP, v.zoom, w, h);
            return { ...v, panX, panY };
          });
        }
        break;
      case 'ArrowDown':
        if (view.zoom > 1) {
          e.preventDefault();
          setView((v) => {
            const { w, h } = getContainerSize();
            const { panX, panY } = clampPan(v.panX, v.panY - PAN_STEP, v.zoom, w, h);
            return { ...v, panX, panY };
          });
        }
        break;
    }
  }, [zoomIn, zoomOut, zoomReset, fitToScreen, view.zoom, getContainerSize]);

  const handleDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setView({ ...DEFAULT_VIEW });
  }, []);

  const handleImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    naturalSizeRef.current = { w: img.naturalWidth, h: img.naturalHeight };
  }, []);

  const containerStyle: React.CSSProperties = {
    cursor: isDragging ? 'grabbing' : view.zoom > 1 ? 'grab' : 'default',
    userSelect: isDragging ? 'none' : undefined,
  };

  const imageStyle: React.CSSProperties = {
    transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
    transformOrigin: 'center center',
    maxWidth: view.zoom > 1 ? 'none' : undefined,
    maxHeight: view.zoom > 1 ? 'none' : undefined,
  };

  return (
    <div className={styles.mediaViewer}>
      <div className={styles.imageZoomToolbar}>
        <button className={styles.imageZoomBtn} onClick={zoomOut} title="Zoom out (-)" disabled={view.zoom <= ZOOM_MIN}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="7" cy="7" r="5.5" /><line x1="4" y1="7" x2="10" y2="7" /><line x1="11" y1="11" x2="14.5" y2="14.5" /></svg>
        </button>
        <button className={styles.imageZoomLevel} onClick={zoomReset} title="Reset zoom (0)">
          {Math.round(view.zoom * 100)}%
        </button>
        <button className={styles.imageZoomBtn} onClick={fitToScreen} title="Fit to screen (F)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2 2"><rect x="2.5" y="2.5" width="11" height="11" rx="1" /></svg>
        </button>
        <button className={styles.imageZoomBtn} onClick={zoomIn} title="Zoom in (+)" disabled={view.zoom >= ZOOM_MAX}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="7" cy="7" r="5.5" /><line x1="4" y1="7" x2="10" y2="7" /><line x1="7" y1="4" x2="7" y2="10" /><line x1="11" y1="11" x2="14.5" y2="14.5" /></svg>
        </button>
      </div>
      <div
        ref={containerRef}
        className={styles.imageZoomContainer}
        tabIndex={0}
        role="img"
        aria-label={alt}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        style={containerStyle}
      >
        <img
          src={src}
          alt={alt}
          className={`${styles.mediaImage}${isDragging || isWheeling ? ` ${styles.mediaImageDragging}` : ''}`}
          draggable={false}
          onLoad={handleImgLoad}
          style={imageStyle}
        />
      </div>
      {caption && <div className={styles.mediaInfo}>{caption}</div>}
    </div>
  );
}

// ---- Main Component ----

export default function ProjectTab({ projectPath, initialPath, initialIsFile, navigateToFile, persistId, onOpenBrowserTab, onPathChange }: ProjectTabProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || '/');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [file, setFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // File content cache — preserves content when switching between tabs
  const fileCacheRef = useRef(new Map<string, FileContent>());

  // Clean up cached blob URLs on unmount
  useEffect(() => {
    const cache = fileCacheRef.current;
    return () => {
      cache.forEach((cached) => {
        if (cached.blobUrl?.startsWith('blob:')) URL.revokeObjectURL(cached.blobUrl);
      });
      cache.clear();
    };
  }, []);

  // Version counter: incremented by loadDir/loadFile so stale silentRefreshDir
  // responses don't overwrite entries from a navigation that completed first.
  const dirVersionRef = useRef(0);

  // Imperative handle to the file tree (collapse-all / refresh toolbar buttons).
  const fileTreeRef = useRef<FileTreeHandle>(null);

  // File tabs — persisted to localStorage when persistId is provided
  const fileTabsKey = persistId ? `agent-manager:file-tabs:${persistId}` : null;
  const [tabs, setTabs] = useState<FileTab[]>(() => {
    if (!fileTabsKey) return [];
    try {
      const raw = localStorage.getItem(fileTabsKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.tabs)) return parsed.tabs;
      }
    } catch { /* ignore */ }
    return [];
  });
  const [activeTabPath, setActiveTabPath] = useState<string | null>(() => {
    if (!fileTabsKey) return null;
    try {
      const raw = localStorage.getItem(fileTabsKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.active === 'string') return parsed.active;
      }
    } catch { /* ignore */ }
    return null;
  });

  // Persist file tabs to localStorage
  useEffect(() => {
    if (!fileTabsKey) return;
    try {
      localStorage.setItem(fileTabsKey, JSON.stringify({ tabs, active: activeTabPath }));
    } catch { /* ignore */ }
  }, [tabs, activeTabPath, fileTabsKey]);

  // Overlays / inline modes
  const [showSearch, setShowSearch] = useState(false);
  const [showContentSearch, setShowContentSearch] = useState(false);
  const [showFindInFile, setShowFindInFile] = useState(false);
  const [findTerm, setFindTerm] = useState('');
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);

  // File system provider (API or local)
  const provider = useMemo(() => getFileSystemProvider(), []);

  // New file editor
  const [editingNewFile, setEditingNewFile] = useState<string | null>(null);
  const [newFileContent, setNewFileContent] = useState('');

  // Split resize (markdown outline)
  const [splitRatio, setSplitRatio] = useState(0.5);
  const splitDragging = useRef(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // VS Code-style tree panel width (persisted)
  const [treePanelWidth, setTreePanelWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('file-browser:tree-panel-width');
      if (saved) return Math.max(140, Math.min(600, Number(saved)));
    } catch { /* ignore */ }
    return 220;
  });
  const [treePanelCollapsed, setTreePanelCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('file-browser:tree-panel-collapsed') === 'true';
    } catch { return false; }
  });
  useEffect(() => {
    try {
      localStorage.setItem('file-browser:tree-panel-collapsed', String(treePanelCollapsed));
    } catch { /* ignore */ }
  }, [treePanelCollapsed]);
  const treePanelWidthRef = useRef(treePanelWidth);
  treePanelWidthRef.current = treePanelWidth;
  const treePanelRef = useRef<HTMLDivElement>(null);

  // Bookmarks
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [showBookmarkPanel, setShowBookmarkPanel] = useState(false);
  const pendingScrollLine = useRef<number | null>(null);

  // Collections — shared across sessions by projectPath
  const [collections, setCollections] = useState<Collection[]>([]);
  const [showCollectionPanel, setShowCollectionPanel] = useState(false);

  // Fullscreen file viewer
  const [showFullscreen, setShowFullscreen] = useState(false);

  // Image viewer state is encapsulated inside the ImageViewer subcomponent —
  // each viewer (normal + fullscreen) gets its own instance keyed by file path,
  // which handles zoom, pan, keyboard shortcuts, fit-to-screen, and per-path
  // persistence via localStorage.

  // Close fullscreen on Escape
  useEffect(() => {
    if (!showFullscreen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowFullscreen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [showFullscreen]);

  // File list display options
  const [showHidden, setShowHidden] = useState(() => {
    try { return localStorage.getItem('file-browser:showHidden') !== 'false'; } catch { return true; }
  });
  const [showDateTime, setShowDateTime] = useState(false);
  // Sort field/direction — persisted per projectPath so it survives tab unmount
  const [sortField, setSortField] = useState<SortField>(() => {
    try {
      const raw = localStorage.getItem(`agent-manager:tree-sort:${projectPath}`);
      if (!raw) return 'name';
      const parsed = JSON.parse(raw) as { field?: string };
      return parsed.field === 'date' ? 'date' : 'name';
    } catch { return 'name'; }
  });
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    try {
      const raw = localStorage.getItem(`agent-manager:tree-sort:${projectPath}`);
      if (!raw) return 'asc';
      const parsed = JSON.parse(raw) as { dir?: string };
      return parsed.dir === 'desc' ? 'desc' : 'asc';
    } catch { return 'asc'; }
  });
  useEffect(() => {
    if (!projectPath) return;
    try {
      localStorage.setItem(
        `agent-manager:tree-sort:${projectPath}`,
        JSON.stringify({ field: sortField, dir: sortDir }),
      );
    } catch { /* ignore */ }
  }, [sortField, sortDir, projectPath]);

  // Markdown outline (side panel with draggable divider)
  const [showOutline, setShowOutline] = useState(false);
  const [wordWrap, setWordWrap] = useState(false);
  // .tex files default to the rendered preview; toggle to show raw source.
  const [texPreview, setTexPreview] = useState(true);
  const markdownRef = useRef<HTMLDivElement>(null);
  const mdContainerRef = useRef<HTMLDivElement>(null);
  const codeViewerRef = useRef<HTMLDivElement>(null);
  // Guard: skip the showHidden effect on first mount (initial load handles it)
  const showHiddenInitRef = useRef(true);
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
    // In VS Code layout, directory browsing is handled by the tree.
    // loadDir is only used for entries refresh — never show ENOTDIR errors.
    const version = ++dirVersionRef.current;
    setEditingNewFile(null);
    try {
      const data = await provider.listDir(projectPath, relPath, showHidden);
      // Only apply if no newer navigation has started
      if (dirVersionRef.current !== version) return;
      setEntries(data.items);
      setCurrentPath(relPath);
      onPathChange?.(relPath, false);
    } catch {
      // Silently ignore — "Not a directory" and other errors are non-fatal
      // since the tree panel handles directory navigation
    }
  }, [projectPath, onPathChange, showHidden, provider]);

  const loadFile = useCallback(async (relPath: string) => {
    ++dirVersionRef.current; // Invalidate any in-flight silentRefreshDir
    setLoading(true);
    setError(null);
    setEditingNewFile(null);
    try {
      const data: FileContent = await provider.readFile(projectPath, relPath);
      // For streamable files, fetch the raw bytes as a blob (or use direct URL for media)
      if (data.streamable && !data.blobUrl) {
        const ext = (data.ext ?? '').toLowerCase();
        const streamUrl = provider.streamUrl(projectPath, relPath);
        if (ext === 'xlsx' || ext === 'xls') {
          // Parse Excel in-browser
          const streamRes = await fetch(streamUrl);
          if (streamRes.ok) {
            const arrayBuffer = await streamRes.arrayBuffer();
            const workbook = XLSX.read(arrayBuffer, { type: 'array' });
            data.sheets = workbook.SheetNames.map((name) => ({
              name,
              data: XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[name], { header: 1 }) as string[][],
            }));
          }
        } else if (isVideoExt(ext) || isAudioExt(ext)) {
          data.blobUrl = streamUrl;
        } else if (streamUrl) {
          const streamRes = await fetch(streamUrl);
          if (streamRes.ok) {
            const blob = await streamRes.blob();
            data.blobUrl = URL.createObjectURL(blob);
          }
        }
      }
      // Cache the file content for instant tab switching
      fileCacheRef.current.set(relPath, data);
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
  }, [projectPath, onPathChange, provider]);

  // Load initial path on mount — restore persisted active file tab, or fall back to initialPath.
  // In VS Code layout, the tree handles directory browsing, so we never need to call loadDir on mount.
  useEffect(() => {
    if (!projectPath) return;
    // 1. Restore persisted active file tab
    if (activeTabPath && tabs.some(t => t.path === activeTabPath)) {
      loadFile(activeTabPath);
      return;
    }
    // 2. If we have tabs but activeTabPath is stale/null, load the last tab
    if (tabs.length > 0) {
      const lastTab = tabs[tabs.length - 1];
      loadFile(lastTab.path);
      return;
    }
    // 3. initialPath is a file — but only if localStorage has no prior tab state.
    //    If the user previously closed all tabs, respect that choice.
    if (initialIsFile && initialPath) {
      const hasPersistedState = fileTabsKey && localStorage.getItem(fileTabsKey) !== null;
      if (!hasPersistedState) {
        loadFile(initialPath);
        return;
      }
    }
    // 4. No file to restore — show welcome message; the tree handles dir browsing
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

  // Collection persistence — keyed per projectPath, shared across all sessions
  const collectionsKey = useMemo(() => `agent-manager:collections:${projectPath}`, [projectPath]);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(collectionsKey);
      if (saved) setCollections(JSON.parse(saved));
    } catch {}
  }, [collectionsKey]);
  useEffect(() => {
    try { localStorage.setItem(bookmarkKey, JSON.stringify(bookmarks)); } catch {}
  }, [bookmarks, bookmarkKey]);

  useEffect(() => {
    try { localStorage.setItem(collectionsKey, JSON.stringify(collections)); } catch {}
  }, [collections, collectionsKey]);

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

  // Scroll position persistence — save/restore per file across session switches and app restarts.
  // Key: file-browser:scroll:{projectPath}:{filePath}
  const scrollKeyForPath = useCallback((filePath: string) =>
    `file-browser:scroll:${projectPath}:${filePath}`, [projectPath]);
  const fileScrollKey = scrollKeyForPath(currentPath);

  // Save current scroll position to localStorage (call before switching away)
  const saveCurrentScroll = useCallback(() => {
    const el = markdownRef.current || codeViewerRef.current;
    if (!el || !file) return;
    // Don't save when element is hidden (display:none/visibility:hidden resets scroll to 0)
    if (!el.offsetHeight) return;
    try { localStorage.setItem(scrollKeyForPath(file.path), String(el.scrollTop)); } catch { /* ignore */ }
  }, [file, scrollKeyForPath]);

  // Ref so cleanup/unmount can always call the latest saveCurrentScroll
  const saveCurrentScrollRef = useRef(saveCurrentScroll);
  saveCurrentScrollRef.current = saveCurrentScroll;

  // Save scroll position on unmount
  useEffect(() => {
    return () => { saveCurrentScrollRef.current(); };
  }, []);

  // Restore scroll when a file finishes loading (markdown + regular code)
  useEffect(() => {
    if (!file) return;
    const key = scrollKeyForPath(file.path);
    let saved = 0;
    try { saved = parseInt(localStorage.getItem(key) ?? '0', 10) || 0; } catch { /* ignore */ }
    if (!saved) return;
    // Use double rAF to ensure DOM has settled after React render
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (markdownRef.current) markdownRef.current.scrollTop = saved;
        else if (codeViewerRef.current) codeViewerRef.current.scrollTop = saved;
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path]);

  // Save scroll on markdown scroll events
  useEffect(() => {
    const el = markdownRef.current;
    if (!el || !file) return;
    const key = scrollKeyForPath(file.path);
    const onScroll = () => {
      // Skip save when element is hidden (browser resets scroll to 0)
      if (!el.offsetHeight) return;
      try { localStorage.setItem(key, String(el.scrollTop)); } catch { /* ignore */ }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { onScroll(); el.removeEventListener('scroll', onScroll); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path, scrollKeyForPath]);

  // Save scroll on regular code viewer scroll events
  useEffect(() => {
    const el = codeViewerRef.current;
    if (!el || !file) return;
    const key = scrollKeyForPath(file.path);
    const onScroll = () => {
      // Skip save when element is hidden (browser resets scroll to 0)
      if (!el.offsetHeight) return;
      try { localStorage.setItem(key, String(el.scrollTop)); } catch { /* ignore */ }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { onScroll(); el.removeEventListener('scroll', onScroll); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path, scrollKeyForPath]);

  // Restore scroll when tab becomes visible (display:none → display:flex triggers resize)
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() => {
      if (!root.offsetHeight) return; // still hidden
      const el = markdownRef.current || codeViewerRef.current;
      if (!el || el.scrollTop !== 0) return; // already at a non-zero position
      const f = file;
      if (!f) return;
      const key = scrollKeyForPath(f.path);
      let saved = 0;
      try { saved = parseInt(localStorage.getItem(key) ?? '0', 10) || 0; } catch { /* ignore */ }
      if (saved) {
        requestAnimationFrame(() => { el.scrollTop = saved; });
      }
    });
    ro.observe(root);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path, scrollKeyForPath]);

  // Tab actions
  const handleTabClick = useCallback((tab: FileTab) => {
    // Save current scroll position before switching
    saveCurrentScroll();
    // Use cached content for instant tab switching
    const cached = fileCacheRef.current.get(tab.path);
    if (cached) {
      setFile(cached);
      setCurrentPath(tab.path);
      setActiveTabPath(tab.path);
      setError(null);
      setEditingNewFile(null);
      onPathChange?.(tab.path, true);
    } else {
      loadFile(tab.path);
    }
  }, [loadFile, onPathChange, saveCurrentScroll]);

  const handleTabClose = useCallback((tabPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Clean up cached content and blob URL
    const cached = fileCacheRef.current.get(tabPath);
    if (cached?.blobUrl?.startsWith('blob:')) URL.revokeObjectURL(cached.blobUrl);
    fileCacheRef.current.delete(tabPath);
    setTabs(prev => {
      const next = prev.filter(t => t.path !== tabPath);
      if (activeTabPath === tabPath) {
        if (next.length > 0) {
          const last = next[next.length - 1];
          // Use cache for the fallback tab too
          const fallback = fileCacheRef.current.get(last.path);
          if (fallback) {
            setFile(fallback);
            setCurrentPath(last.path);
            setActiveTabPath(last.path);
            onPathChange?.(last.path, true);
          } else {
            setActiveTabPath(last.path);
            loadFile(last.path);
          }
        } else {
          setActiveTabPath(null);
          setFile(null);
        }
      }
      return next;
    });
  }, [activeTabPath, loadFile, loadDir, onPathChange]);

  // Search select
  const handleSearchSelect = useCallback((result: SearchResult) => {
    setShowSearch(false);
    if (result.type === 'dir') {
      loadDir(result.path);
    } else {
      loadFile(result.path);
    }
  }, [loadDir, loadFile]);

  // Derive the current directory path (parent of file if viewing a file)
  const currentDirPath = useMemo(() => {
    if (file) {
      const parts = currentPath.split('/').filter(Boolean);
      parts.pop();
      return '/' + parts.join('/');
    }
    return currentPath;
  }, [currentPath, file]);

  // New file
  const handleNewFile = useCallback(async (name: string) => {
    setCreatingFile(false);
    const newPath = currentDirPath === '/' ? '/' + name : currentDirPath + '/' + name;
    setEditingNewFile(newPath);
    setNewFileContent('');
    setFile(null);
  }, [currentPath]);

  const handleSaveNewFile = useCallback(async () => {
    if (!editingNewFile) return;
    try {
      await provider.writeFile(projectPath, editingNewFile, newFileContent);
      setEditingNewFile(null);
      loadFile(editingNewFile);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [editingNewFile, newFileContent, projectPath, loadFile, provider]);

  const handleCancelNewFile = useCallback(() => {
    setEditingNewFile(null);
    setNewFileContent('');
  }, []);

  // New folder
  const handleNewFolder = useCallback(async (name: string) => {
    setCreatingFolder(false);
    const newPath = currentDirPath === '/' ? '/' + name : currentDirPath + '/' + name;
    try {
      await provider.mkdir(projectPath, newPath);
      // Refresh the file tree instead of loadDir (which would clear the file viewer)
      document.dispatchEvent(new CustomEvent('filetree:refresh'));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [currentDirPath, projectPath, provider]);

  // Paste / drop file upload
  const [dragOver, setDragOver] = useState(false);

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;

    const targetDir = currentDirPath;
    let uploaded = 0;
    let failed = 0;

    for (const file of fileArr) {
      const relPath = targetDir === '/' ? '/' + file.name : targetDir + '/' + file.name;
      try {
        await provider.uploadFile(projectPath, relPath, file);
        uploaded++;
      } catch {
        failed++;
      }
    }

    document.dispatchEvent(new CustomEvent('filetree:refresh'));

    if (failed === 0) {
      showToast(`Uploaded ${uploaded} file${uploaded > 1 ? 's' : ''}`, 'success');
    } else {
      showToast(`Uploaded ${uploaded}, failed ${failed}`, 'warning');
    }
  }, [currentDirPath, projectPath, provider]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    uploadFiles(files);
  }, [uploadFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      uploadFiles(files);
    }
  }, [uploadFiles]);

  // Delete file or folder — keyed by full rel path (supports FileTree + context menu)
  interface DeleteTarget { relPath: string; name: string; isDir: boolean; }
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleRequestDelete = useCallback(
    (relPath: string, name: string, isDir: boolean) => {
      setDeleteTarget({ relPath, name, isDir });
    },
    [],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await provider.deleteEntry(projectPath, deleteTarget.relPath);
      setDeleteTarget(null);
      // Refresh the tree and the current directory view so the removed entry disappears.
      document.dispatchEvent(new CustomEvent('filetree:refresh'));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, projectPath, provider]);

  const handleCancelDelete = useCallback(() => {
    if (deleting) return;
    setDeleteTarget(null);
  }, [deleting]);

  // Context menu
  interface ContextMenuState { x: number; y: number; entry: DirEntry; entryPath: string; }
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: DirEntry) => {
    e.preventDefault();
    e.stopPropagation();
    const entryPath = currentPath === '/' ? '/' + entry.name : currentPath + '/' + entry.name;
    setContextMenu({ x: e.clientX, y: e.clientY, entry, entryPath });
  }, [currentPath]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleContextOpen = useCallback(() => {
    if (!contextMenu) return;
    closeContextMenu();
    handleEntryClick(contextMenu.entry);
  }, [contextMenu, closeContextMenu, handleEntryClick]);

  const handleContextOpenNewTab = useCallback(() => {
    if (!contextMenu) return;
    closeContextMenu();
    const { entry, entryPath } = contextMenu;
    const base = `/project-browser?path=${encodeURIComponent(projectPath)}`;
    if (entry.type === 'file') {
      window.open(`${base}&file=${encodeURIComponent(entryPath)}`, '_blank');
    } else {
      window.open(`${base}`, '_blank');
    }
  }, [contextMenu, closeContextMenu, projectPath]);

  const handleContextDelete = useCallback(() => {
    if (!contextMenu) return;
    const { entry, entryPath } = contextMenu;
    closeContextMenu();
    setDeleteTarget({
      relPath: entryPath,
      name: entry.name,
      isDir: entry.type === 'dir',
    });
  }, [contextMenu, closeContextMenu]);

  // Reload directory when showHidden toggles (skip initial mount — initial load effect handles that)
  useEffect(() => {
    if (showHiddenInitRef.current) { showHiddenInitRef.current = false; return; }
    if (!file) loadDir(currentPath);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  // Refresh
  const handleRefresh = useCallback(() => {
    if (file) {
      loadFile(currentPath);
    } else {
      loadDir(currentPath);
    }
    // Also refresh the file tree sidebar
    document.dispatchEvent(new CustomEvent('filetree:refresh'));
  }, [currentPath, file, loadDir, loadFile]);

  // Silent refresh — updates directory listing without clearing file/loading state.
  // Used by the auto-refresh polling interval. Skips when viewing a file (currentPath is a file path).
  const silentRefreshDir = useCallback(async () => {
    // Skip when viewing a file — currentPath is a file path, not a directory
    if (file) return;
    const version = dirVersionRef.current;
    try {
      const data = await provider.listDir(projectPath, currentPath, showHidden);
      // Only apply if no navigation happened while we were fetching
      if (dirVersionRef.current !== version) return;
      setEntries(data.items);
    } catch {
      // Silently ignore — next poll will retry
    }
  }, [projectPath, currentPath, showHidden, provider, file]);

  // Auto-refresh: poll directory listing every 5 seconds
  useEffect(() => {
    const interval = setInterval(silentRefreshDir, 5000);
    return () => clearInterval(interval);
  }, [silentRefreshDir]);

  // Sort entries: directories first, then apply user sort preference
  const sortedEntries = useMemo(() => {
    const sorted = [...entries];
    sorted.sort((a, b) => {
      // Directories always come first
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      if (sortField === 'date') {
        const ta = a.mtime ? new Date(a.mtime).getTime() : 0;
        const tb = b.mtime ? new Date(b.mtime).getTime() : 0;
        return sortDir === 'asc' ? ta - tb : tb - ta;
      }
      const cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [entries, sortField, sortDir]);

  // Cycle sort: click same field toggles direction, click different field switches to it asc
  const handleSortToggle = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }, [sortField]);

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

  // Open an arbitrary path on disk (e.g. ~/.config/gcloud/...) in a new browser tab
  const handleOpenExternalPath = useCallback(async () => {
    const input = window.prompt(
      'Open path (absolute, or starting with ~):',
      '~/',
    );
    if (!input || !input.trim()) return;
    try {
      const resolved = await provider.resolvePath(input.trim());
      if (onOpenBrowserTab) {
        onOpenBrowserTab(resolved.root, resolved.rel, resolved.kind === 'file');
      } else {
        window.open(`/project-browser?path=${encodeURIComponent(resolved.root)}`, '_blank');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Open failed: ${msg}`, 'error');
    }
  }, [provider, onOpenBrowserTab]);

  const handleRevealInFinder = useCallback(async () => {
    try {
      await provider.reveal(projectPath, file?.path ?? currentPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Reveal failed: ${msg}`, 'error');
    }
  }, [projectPath, currentPath, file, provider]);

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

  // Collection: add/remove current path; toggle panel
  const isCurrentCollected = collections.some((c) => c.path === currentPath);

  const handleCollectToggle = useCallback(() => {
    if (isCurrentCollected) {
      setShowCollectionPanel((p) => !p);
    } else {
      const name = currentPath.split('/').filter(Boolean).pop() || projectPath.split('/').filter(Boolean).pop() || currentPath;
      setCollections((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          path: currentPath,
          name,
          isFile: !!file,
          addedAt: Date.now(),
        },
      ]);
      setShowCollectionPanel(true);
    }
  }, [currentPath, isCurrentCollected, file, projectPath]);

  const handleDeleteCollection = useCallback((id: string) => {
    setCollections((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const handleCollectionItemClick = useCallback((col: Collection) => {
    if (col.isFile) {
      loadFile(col.path);
    } else {
      loadDir(col.path);
    }
  }, [loadFile, loadDir]);

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

  // Find-in-file callbacks
  const handleFindTermChange = useCallback((term: string, caseSensitive: boolean) => {
    setFindTerm(term);
    setFindCaseSensitive(caseSensitive);
  }, []);

  const [findScrollTarget, setFindScrollTarget] = useState<{ line: number; key: number } | null>(null);
  const [findActiveMatch, setFindActiveMatch] = useState<{ line: number; col: number } | null>(null);
  // Flat active match index (and total) — used by rendered views (markdown, TeX)
  // that walk the DOM rather than scrolling by line number.
  const [findActiveIdx, setFindActiveIdx] = useState<number>(-1);

  const handleFindActiveMatchChange = useCallback(
    (match: { line: number; col: number } | null) => {
      setFindActiveMatch(match);
    },
    [],
  );

  const handleFindActiveIdxChange = useCallback((idx: number) => {
    setFindActiveIdx(idx);
  }, []);

  const handleFindScrollToLine = useCallback((lineNumber: number) => {
    // Virtualized view: element may not be in DOM — pass scroll target via state/props
    setFindScrollTarget({ line: lineNumber, key: Date.now() });
    // Non-virtualized view: element is always in DOM — scroll after next paint
    requestAnimationFrame(() => {
      const el = document.getElementById(`fv-line-${lineNumber}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }, []);

  const handleCloseFindInFile = useCallback(() => {
    setShowFindInFile(false);
    setFindTerm('');
    setFindCaseSensitive(false);
    setFindActiveMatch(null);
    setFindActiveIdx(-1);
  }, []);

  // ---------------------------------------------------------------------------
  // DOM-side find highlighting for rendered views (markdown).
  // The line-anchor approach (`fv-line-N`) only works for raw code views; the
  // rendered markdown DOM has no line markers. We walk text nodes, wrap matches
  // with <mark> spans, and scroll the active one into view.
  // ---------------------------------------------------------------------------
  const findMarksRef = useRef<HTMLElement[]>([]);

  // Re-wrap matches whenever the term, case mode, or rendered content changes.
  useEffect(() => {
    const root = markdownRef.current;
    if (!root) return;
    const isRenderedMd = file?.ext === 'md' || file?.ext === 'mdx';
    if (!isRenderedMd) return;

    // Always unwrap previous marks before (re)wrapping.
    const unwrap = () => {
      for (const mark of findMarksRef.current) {
        const parent = mark.parentNode;
        if (!parent) continue;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      }
      findMarksRef.current = [];
      root.normalize();
    };
    unwrap();

    if (!findTerm) return;
    const needle = findCaseSensitive ? findTerm : findTerm.toLowerCase();
    if (!needle) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        // Skip text inside our own previous marks (defensive — unwrap should
        // already have removed them).
        const parent = node.parentElement;
        if (parent?.classList.contains('find-match')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes: Text[] = [];
    let cur: Node | null = walker.nextNode();
    while (cur) {
      textNodes.push(cur as Text);
      cur = walker.nextNode();
    }

    const newMarks: HTMLElement[] = [];
    for (const text of textNodes) {
      const value = text.nodeValue ?? '';
      const haystack = findCaseSensitive ? value : value.toLowerCase();
      let idx = haystack.indexOf(needle);
      if (idx === -1) continue;
      const fragment = document.createDocumentFragment();
      let last = 0;
      while (idx !== -1) {
        if (idx > last) fragment.appendChild(document.createTextNode(value.slice(last, idx)));
        const mark = document.createElement('mark');
        mark.className = 'find-match';
        mark.textContent = value.slice(idx, idx + findTerm.length);
        fragment.appendChild(mark);
        newMarks.push(mark);
        last = idx + findTerm.length;
        idx = haystack.indexOf(needle, last);
      }
      if (last < value.length) fragment.appendChild(document.createTextNode(value.slice(last)));
      text.parentNode?.replaceChild(fragment, text);
    }
    findMarksRef.current = newMarks;

    return unwrap;
    // We intentionally re-run when the rendered file content changes too.
  }, [findTerm, findCaseSensitive, file?.ext, file?.content]);

  // Update the active match class + scroll when the active index changes.
  useEffect(() => {
    const marks = findMarksRef.current;
    if (marks.length === 0) return;
    for (const m of marks) {
      m.classList.remove('find-match-active');
      m.classList.add('find-match');
    }
    if (findActiveIdx < 0 || findActiveIdx >= marks.length) return;
    const active = marks[findActiveIdx];
    active.classList.remove('find-match');
    active.classList.add('find-match-active');
    active.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [findActiveIdx, findTerm, findCaseSensitive, file?.content]);

  // Listen for content search event (Cmd/Ctrl+F from keyboard shortcut handler)
  useEffect(() => {
    function handleContentSearch() {
      if (rootRef.current?.offsetParent === null) return;
      setShowContentSearch(true);
    }
    document.addEventListener('projectTab:contentSearch', handleContentSearch);
    return () => document.removeEventListener('projectTab:contentSearch', handleContentSearch);
  }, []);

  // Listen for find-in-file event (Cmd/Ctrl+F from keyboard shortcut handler)
  useEffect(() => {
    function handleFindInFile() {
      if (rootRef.current?.offsetParent === null) return;
      setShowFindInFile(true);
    }
    document.addEventListener('projectTab:findInFile', handleFindInFile);
    return () => document.removeEventListener('projectTab:findInFile', handleFindInFile);
  }, []);

  // File browser keyboard shortcuts — triggered by the global shortcut system
  useEffect(() => {
    function handleFileBrowserAction(e: Event) {
      // Only act when this ProjectTab instance is visible (not hidden via display:none)
      if (rootRef.current?.offsetParent === null) return;
      const { actionId } = (e as CustomEvent<{ actionId: string }>).detail;
      switch (actionId) {
        case 'fileBrowserSearch':         setShowSearch(true); break;
        case 'fileBrowserContentSearch':  setShowContentSearch(true); break;
        case 'fileBrowserNewFile':        setCreatingFile(true); break;
        case 'fileBrowserNewFolder':      setCreatingFolder(true); break;
        case 'fileBrowserRefresh':        handleRefresh(); break;
        case 'fileBrowserOpenNewTab':     handleOpenProjectView(); break;
        case 'fileBrowserFormat':         handleFormatFile(); break;
        case 'fileBrowserToggleOutline':  setShowOutline(p => !p); break;
        case 'fileBrowserToggleBookmark': handleBookmarkBtnClick(); break;
        case 'fileBrowserToggleWordWrap': setWordWrap(p => !p); break;
        case 'fileBrowserFullscreen':     setShowFullscreen(true); break;
        case 'fileBrowserToggleHidden':
          setShowHidden(p => {
            const next = !p;
            try { localStorage.setItem('file-browser:showHidden', String(next)); } catch { /* ignore */ }
            return next;
          });
          break;
        case 'fileBrowserToggleDateTime': setShowDateTime(p => !p); break;
        case 'fileBrowserSortName':       handleSortToggle('name'); break;
        case 'fileBrowserSortDate':       handleSortToggle('date'); break;
      }
    }
    document.addEventListener('fileBrowser:action', handleFileBrowserAction);
    return () => document.removeEventListener('fileBrowser:action', handleFileBrowserAction);
  }, [handleRefresh, handleOpenProjectView, handleFormatFile, handleBookmarkBtnClick, handleSortToggle]);

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

  // Tree panel divider drag handler
  const onTreeDividerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = treePanelWidthRef.current;
    const onMove = (ev: MouseEvent) => {
      const newWidth = Math.max(140, Math.min(600, startWidth + (ev.clientX - startX)));
      setTreePanelWidth(newWidth);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem('file-browser:tree-panel-width', String(treePanelWidthRef.current)); } catch { /* ignore */ }
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

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
    <div ref={rootRef} className={styles.projectTab}>
      {/* Icon toolbar */}
      <div className={styles.iconBar}>
        <button className={styles.iconBtn} onClick={() => setShowSearch(true)} title="Search files by name (fuzzy)">
          <IconSearch />
        </button>
        <button className={styles.iconBtn} onClick={() => setShowContentSearch(true)} title="Search in file contents (Cmd+F)">
          <IconContentSearch />
        </button>
        <button
          className={`${styles.iconBtn} ${showFindInFile ? styles.iconBtnActive : ''}`}
          onClick={() => setShowFindInFile((p) => !p)}
          disabled={!file || !!file.binary}
          title="Find in current file (Cmd/Ctrl+F)"
        >
          <IconFindInFile />
        </button>
        <button
          className={styles.iconBtn}
          onClick={() => { setTreePanelCollapsed(false); setCreatingFile(true); }}
          title="New file"
        >
          <IconNewFile />
        </button>
        <button
          className={styles.iconBtn}
          onClick={() => { setTreePanelCollapsed(false); setCreatingFolder(true); }}
          title="New folder"
        >
          <IconNewFolder />
        </button>
        <button className={styles.iconBtn} onClick={handleOpenProjectView} title="Open project in new tab">
          <IconOpenProjectView />
        </button>
        <button
          className={styles.iconBtn}
          onClick={() => { void handleOpenExternalPath(); }}
          title="Open path outside this project (e.g. ~/.config/...)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 4h5l1.5 1.5H14V13H2V4z" />
            <path d="M9 9h4M11 7l2 2-2 2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button className={styles.iconBtn} onClick={handleRevealInFinder} title="Reveal in Finder / Explorer">
          <IconRevealInFinder />
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
          className={`${styles.iconBtn} ${texPreview ? styles.iconBtnActive : ''}`}
          onClick={() => setTexPreview((p) => !p)}
          disabled={!file || file.ext !== 'tex'}
          title={texPreview ? 'Show LaTeX source' : 'Render LaTeX preview'}
        >
          <span style={{ fontFamily: 'serif', fontSize: '11px', fontWeight: 700, letterSpacing: '0.5px' }}>
            T<sub style={{ fontSize: '8px', verticalAlign: 'baseline' }}>E</sub>X
          </span>
        </button>
        <button
          className={`${styles.iconBtn} ${showBookmarkPanel || bookmarks.length > 0 ? styles.iconBtnActive : ''}`}
          onClick={handleBookmarkBtnClick}
          title="Bookmark selected text / show bookmarks"
        >
          <IconBookmark active={bookmarks.length > 0} />
          {bookmarks.length > 0 && <span className={styles.bookmarkBadge}>{bookmarks.length}</span>}
        </button>
        <button
          className={`${styles.iconBtn} ${isCurrentCollected || showCollectionPanel ? styles.iconBtnActive : ''}`}
          onClick={handleCollectToggle}
          style={isCurrentCollected ? { color: 'var(--accent-yellow, #ffd700)' } : undefined}
          title={isCurrentCollected ? 'Collected — click to view/manage collection' : 'Add to collection'}
        >
          <IconCollect active={isCurrentCollected} />
          {collections.length > 0 && (
            <span className={styles.bookmarkBadge} style={{ background: 'var(--accent-yellow, #ffd700)' }}>
              {collections.length}
            </span>
          )}
        </button>
        <button
          className={`${styles.iconBtn} ${wordWrap ? styles.iconBtnActive : ''}`}
          onClick={() => setWordWrap((p) => !p)}
          disabled={!file || !!file.binary}
          title="Toggle word wrap"
        >
          <IconWordWrap />
        </button>
        <button
          className={styles.iconBtn}
          onClick={() => setShowFullscreen(true)}
          disabled={!file}
          title="Open in fullscreen"
        >
          <IconFullscreen />
        </button>
        <span className={styles.iconBarSep} />
        <button
          className={`${styles.iconBtn} ${showHidden ? styles.iconBtnActive : ''}`}
          onClick={() => setShowHidden(p => {
            const next = !p;
            try { localStorage.setItem('file-browser:showHidden', String(next)); } catch { /* ignore */ }
            return next;
          })}
          disabled={!!file}
          title={showHidden ? 'Hide dotfiles/hidden folders' : 'Show hidden folders (dotfiles)'}
        >
          <span style={{ fontFamily: 'monospace', fontSize: '13px', fontWeight: 700 }}>.</span>
        </button>
        <button
          className={`${styles.iconBtn} ${showDateTime ? styles.iconBtnActive : ''}`}
          onClick={() => setShowDateTime(p => !p)}
          disabled={!!file}
          title="Toggle date/time display"
        >
          <IconClock />
        </button>
        <button
          className={`${styles.iconBtn} ${sortField === 'name' ? styles.iconBtnActive : ''}`}
          onClick={() => handleSortToggle('name')}
          disabled={!!file}
          title={`Sort by name (${sortField === 'name' ? sortDir : 'asc'})`}
        >
          <IconSortAlpha />
        </button>
        <button
          className={`${styles.iconBtn} ${sortField === 'date' ? styles.iconBtnActive : ''}`}
          onClick={() => handleSortToggle('date')}
          disabled={!!file}
          title={`Sort by date (${sortField === 'date' ? sortDir : 'asc'})`}
        >
          <IconSortDate />
        </button>
        <span className={styles.iconBarSep} />
        <button
          className={styles.iconBtn}
          onClick={() => fileTreeRef.current?.collapseAll()}
          disabled={treePanelCollapsed}
          title="Collapse all folders"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 4l1.5-1.5h3L8 4h6v8H2V4z" />
            <path d="M5 9l3-3 3 3" />
            <path d="M5 12l3-3 3 3" />
          </svg>
        </button>
        <button
          className={styles.iconBtn}
          onClick={handleRefresh}
          title="Refresh (file tree + current file/folder)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M13 3v4h-4" />
            <path d="M13 7a5 5 0 1 0-1.5 3.5" />
          </svg>
        </button>
      </div>

      {/* (tabs + breadcrumb are inside the viewer panel below) */}

      {/* VS Code-style split: tree left + viewer right */}
      <div className={styles.vscodeSplit}>
        {/* Left: File tree panel (supports paste & drag-drop file upload) */}
        <div
          ref={treePanelRef}
          className={`${styles.treePanel} ${treePanelCollapsed ? styles.treePanelCollapsed : ''} ${dragOver ? styles.treePanelDragOver : ''}`}
          style={treePanelCollapsed ? undefined : { width: treePanelWidth, minWidth: treePanelWidth }}
          tabIndex={0}
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className={styles.treePanelHeader}>
            {!treePanelCollapsed && <span className={styles.treePanelTitle}>{projectName}</span>}
            <button
              className={styles.treePanelToggle}
              onClick={() => setTreePanelCollapsed((c) => !c)}
              title={treePanelCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                {treePanelCollapsed ? (
                  <path d="M6 2l6 6-6 6V2z" />
                ) : (
                  <path d="M10 14l-6-6 6-6v12z" />
                )}
              </svg>
            </button>
          </div>
          {/* Inline new file/folder inputs */}
          {!treePanelCollapsed && creatingFile && (
            <InlineInput
              placeholder="filename.ext"
              onSubmit={handleNewFile}
              onCancel={() => setCreatingFile(false)}
            />
          )}
          {!treePanelCollapsed && creatingFolder && (
            <InlineInput
              placeholder="folder name"
              onSubmit={handleNewFolder}
              onCancel={() => setCreatingFolder(false)}
            />
          )}
          {!treePanelCollapsed && (
          <div className={styles.treePanelBody}>
            <FileTree
              ref={fileTreeRef}
              projectPath={projectPath}
              showHidden={showHidden}
              onFileSelect={(relPath) => loadFile(relPath)}
              onDirSelect={(relPath) => {
                setCurrentPath(relPath);
                onPathChange?.(relPath, false);
              }}
              activeFilePath={activeTabPath}
              onRequestDelete={handleRequestDelete}
            />
          </div>
          )}
        </div>

        {/* Resizable divider */}
        {!treePanelCollapsed && <div className={styles.treeDivider} onMouseDown={onTreeDividerDown} />}

        {/* Right: Viewer panel with tabs */}
        <div className={styles.viewerPanel}>
          {/* File tabs bar */}
          {tabs.length > 0 && (
            <div className={styles.tabBar}>
              {tabs.map((tab) => (
                <div
                  key={tab.path}
                  className={`${styles.fileTab} ${activeTabPath === tab.path ? styles.fileTabActive : ''}`}
                  onClick={() => handleTabClick(tab)}
                  title={tab.path}
                >
                  <span className={styles.fileTabIcon}>{fileIcon(tab.name, 'file')}</span>
                  <span className={styles.fileTabName}>{tab.name}</span>
                  <button
                    className={styles.fileTabClose}
                    onClick={(e) => handleTabClose(tab.path, e)}
                    title="Close tab"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* File path indicator (read-only breadcrumb, no navigation — use tree on left) */}
          {file && (
            <div className={styles.toolbar}>
              <div className={styles.breadcrumb}>
                {breadcrumbs.map((seg, i) => {
                  const isLast = i === breadcrumbs.length - 1;
                  const segPath = '/' + breadcrumbs.slice(0, i + 1).join('/');
                  return (
                    <span key={segPath}>
                      {i > 0 && <span className={styles.breadSep}>/</span>}
                      {isLast ? (
                        <span className={styles.breadCurrent}>{seg}</span>
                      ) : (
                        <span className={styles.breadSep} style={{ color: 'var(--text-dim)' }}>{seg}</span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Viewer content area */}
          <div className={styles.contentCol}>
          {showFindInFile && file && !file.binary && (
            <FindInFileBar
              fileContent={file.content || ''}
              onClose={handleCloseFindInFile}
              onScrollToLine={handleFindScrollToLine}
              onTermChange={handleFindTermChange}
              onActiveMatchChange={handleFindActiveMatchChange}
              onActiveIdxChange={handleFindActiveIdxChange}
            />
          )}
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

            {/* Welcome message (no file open, no tabs) */}
            {!loading && !error && !file && !showingEditor && (
              <div className={styles.viewerWelcome}>
                <span>{'\u{1F4C2}'}</span>
                <span>Select a file from the tree to view</span>
              </div>
            )}

            {/* File viewer */}
            {!loading && !error && file && !showingEditor && (
              <div className={styles.fileViewer}>
                {file.sheets && file.sheets.length > 0 ? (
                  <ExcelViewer sheets={file.sheets} />
                ) : file.streamable && file.ext === 'pdf' && file.blobUrl ? (
                  <iframe
                    src={file.blobUrl}
                    className={styles.pdfViewer}
                    title={file.name}
                  />
                ) : file.streamable && file.blobUrl && isImageExt(file.ext) ? (
                  <ImageViewer
                    key={file.path}
                    src={file.blobUrl}
                    alt={file.name}
                    filePath={file.path}
                    caption={`${file.name} — ${formatSize(file.size)}`}
                  />
                ) : file.streamable && file.blobUrl && isVideoExt(file.ext) ? (
                  <div className={styles.mediaViewer}>
                    <video
                      src={file.blobUrl}
                      controls
                      className={styles.mediaVideo}
                      preload="metadata"
                    />
                    <div className={styles.mediaInfo}>{file.name} — {formatSize(file.size)}</div>
                  </div>
                ) : file.streamable && file.blobUrl && isAudioExt(file.ext) ? (
                  <div className={styles.mediaViewer}>
                    <audio src={file.blobUrl} controls preload="metadata" className={styles.mediaAudio} />
                    <div className={styles.mediaInfo}>{file.name} — {formatSize(file.size)}</div>
                  </div>
                ) : file.binary ? (
                  <div className={styles.empty}>
                    Binary file ({formatSize(file.size)})
                  </div>
                ) : file.ext === 'tex' && texPreview ? (
                  <TexViewer source={file.content || ''} fileKey={file.path} />
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
                          a: ({ children, href, ...props }) => {
                            if (href && /\.mdx?($|#)/.test(href) && !href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('//')) {
                              const hrefPath = href.split('#')[0];
                              const dir = (currentPath || '').includes('/') ? (currentPath || '').slice(0, (currentPath || '').lastIndexOf('/')) : '';
                              const joined = dir ? `${dir}/${hrefPath}` : hrefPath;
                              const parts = joined.split('/');
                              const resolved: string[] = [];
                              for (const part of parts) {
                                if (part === '..') resolved.pop();
                                else if (part !== '.') resolved.push(part);
                              }
                              const resolvedPath = resolved.join('/');
                              return <a {...props} href="#" onClick={(e) => { e.preventDefault(); loadFile(resolvedPath); }}>{children}</a>;
                            }
                            return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
                          },
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
                ) : (file.content || '').split('\n').length > VIRTUALIZE_THRESHOLD ? (
                  <VirtualCodeViewer
                    content={file.content || ''}
                    filePath={file.path}
                    bookmarks={bookmarks}
                    wordWrap={wordWrap}
                    scrollKey={fileScrollKey}
                    findTerm={findTerm}
                    findCaseSensitive={findCaseSensitive}
                    scrollToLine={findScrollTarget}
                    activeMatch={findActiveMatch}
                  />
                ) : (
                  <div
                    ref={codeViewerRef}
                    className={`${styles.codeLines}${wordWrap ? ` ${styles.codeLinesWrap}` : ''}`}
                  >
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
                          <span className={styles.lineText}>
                            {findTerm
                              ? highlightFindMatches(line, findTerm, findCaseSensitive, findActiveMatch ?? undefined, lineNum)
                              : (line || '\u00A0')}
                          </span>
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
          {/* Collection panel */}
          {showCollectionPanel && (
            <div className={styles.collectionPanel}>
              <div className={styles.bookmarkPanelHeader}>
                <span className={styles.collectionPanelTitle}>COLLECTION ({collections.length})</span>
                <button className={styles.bookmarkPanelClose} onClick={() => setShowCollectionPanel(false)}>✕</button>
              </div>
              {collections.length === 0 ? (
                <div className={styles.bookmarkEmpty}>
                  Navigate to any file or folder and click ★ to collect it.
                </div>
              ) : (
                <div className={styles.collectionList}>
                  {collections.map((col) => (
                    <div
                      key={col.id}
                      className={`${styles.collectionItem}${col.path === currentPath ? ` ${styles.collectionItemActive}` : ''}`}
                      onClick={() => handleCollectionItemClick(col)}
                      title={col.path}
                    >
                      <span className={styles.collectionItemIcon}>{col.isFile ? '📄' : '📁'}</span>
                      <span className={styles.collectionItemName}>{col.name}</span>
                      <span className={styles.collectionItemPath}>{col.path}</span>
                      <button
                        className={styles.bookmarkItemDel}
                        onClick={(e) => { e.stopPropagation(); handleDeleteCollection(col.id); }}
                        title="Remove from collection"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          </div>{/* end contentCol */}
        </div>{/* end viewerPanel */}
      </div>{/* end vscodeSplit */}

      {/* Fullscreen file viewer popup */}
      {showFullscreen && file && (
        <div className={styles.fullscreenOverlay} onClick={() => setShowFullscreen(false)}>
          <div className={styles.fullscreenModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.fullscreenHeader}>
              <span className={styles.fullscreenTitle}>{file.name}</span>
              <button className={styles.fullscreenClose} onClick={() => setShowFullscreen(false)} title="Close (Esc)">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <line x1="3" y1="3" x2="13" y2="13" />
                  <line x1="13" y1="3" x2="3" y2="13" />
                </svg>
              </button>
            </div>
            <div className={styles.fullscreenBody}>
              {file.sheets && file.sheets.length > 0 ? (
                <ExcelViewer sheets={file.sheets} />
              ) : file.streamable && file.ext === 'pdf' && file.blobUrl ? (
                <iframe src={file.blobUrl} className={styles.pdfViewer} title={file.name} />
              ) : file.streamable && file.blobUrl && isImageExt(file.ext) ? (
                <ImageViewer key={file.path} src={file.blobUrl} alt={file.name} filePath={file.path} />
              ) : file.binary ? (
                <div className={styles.empty}>Binary file ({formatSize(file.size)})</div>
              ) : file.ext === 'tex' && texPreview ? (
                <TexViewer source={file.content || ''} fileKey={file.path} />
              ) : (file.content || '').split('\n').length > VIRTUALIZE_THRESHOLD ? (
                <VirtualCodeViewer content={file.content || ''} filePath={file.path} bookmarks={bookmarks} wordWrap={wordWrap} scrollKey={fileScrollKey} findTerm={findTerm} findCaseSensitive={findCaseSensitive} scrollToLine={findScrollTarget} activeMatch={findActiveMatch} />
              ) : (
                <div className={`${styles.codeLines}${wordWrap ? ` ${styles.codeLinesWrap}` : ''}`}>
                  {(file.content || '').split('\n').map((line, i) => (
                    <div key={i} id={`fs-line-${i + 1}`} className={styles.codeLine}>
                      <span className={styles.lineNum}>{i + 1}</span>
                      <span className={styles.lineText}>
                        {findTerm
                          ? highlightFindMatches(line, findTerm, findCaseSensitive, findActiveMatch ?? undefined, i + 1)
                          : (line || '\u00A0')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <>
          <div className={styles.contextMenuBackdrop} onClick={closeContextMenu} />
          <div
            className={styles.contextMenu}
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button className={styles.contextMenuItem} onClick={handleContextOpen}>
              Open
            </button>
            <button className={styles.contextMenuItem} onClick={handleContextOpenNewTab}>
              Open in new tab
            </button>
            <div className={styles.contextMenuDivider} />
            <button className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`} onClick={handleContextDelete}>
              Delete
            </button>
          </div>
        </>
      )}

      {/* Search overlay (fuzzy file name search) */}
      {showSearch && (
        <SearchOverlay
          projectPath={projectPath}
          onSelect={handleSearchSelect}
          onClose={() => setShowSearch(false)}
        />
      )}

      {/* Content search modal (grep across project files) */}
      {showContentSearch && (
        <ContentSearchModal
          projectPath={projectPath}
          onFileOpen={(filePath, line) => {
            loadFile(filePath);
            if (line) {
              pendingScrollLine.current = line;
            }
          }}
          onClose={() => setShowContentSearch(false)}
        />
      )}

      {/* Confirm delete dialog */}
      {deleteTarget && (
        <DeleteConfirmOverlay
          target={deleteTarget}
          deleting={deleting}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}
    </div>
  );
}

interface DeleteConfirmOverlayProps {
  target: { relPath: string; name: string; isDir: boolean };
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteConfirmOverlay({ target, deleting, onConfirm, onCancel }: DeleteConfirmOverlayProps) {
  // Keyboard: Enter confirms, Esc cancels.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Enter' && !deleting) {
        e.stopPropagation();
        onConfirm();
      }
    }
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [deleting, onCancel, onConfirm]);

  return (
    <div className={styles.deleteConfirmOverlay} onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Confirm delete"
        className={styles.deleteConfirmPanel}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.deleteConfirmTitle}>
          Delete {target.isDir ? 'folder' : 'file'}?
        </div>
        <div className={styles.deleteConfirmBody}>
          <code className={styles.deleteConfirmPath}>{target.relPath}</code>
          {target.isDir && (
            <div className={styles.deleteConfirmWarn}>
              This will remove the folder and all its contents.
            </div>
          )}
        </div>
        <div className={styles.deleteConfirmActions}>
          <button
            type="button"
            className={styles.deleteConfirmCancel}
            onClick={onCancel}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.deleteConfirmConfirm}
            onClick={onConfirm}
            disabled={deleting}
            autoFocus
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

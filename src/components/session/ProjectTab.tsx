/**
 * ProjectTab — interactive file browser for a session's project directory.
 * Uses /api/files/list and /api/files/read endpoints.
 */
import { useState, useEffect, useCallback } from 'react';
import styles from '@/styles/modules/ProjectTab.module.css';

interface ProjectTabProps {
  projectPath: string;
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

/** Minimal markdown-to-HTML renderer for file preview. */
function renderMarkdown(src: string): string {
  let html = src
    // Fenced code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
      `<pre class="md-code-block">${code.replace(/</g, '&lt;')}</pre>`)
    // Headings
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Horizontal rules
    .replace(/^---+$/gm, '<hr />')
    // Bold & italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
    // Links
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // Unordered list items
    .replace(/^[*\-+] (.+)$/gm, '<li>$1</li>')
    // Line breaks (double newline → paragraph break)
    .replace(/\n{2,}/g, '<br/><br/>');

  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li>.*?<\/li>\s*)+)/g, '<ul>$1</ul>');

  return html;
}

export default function ProjectTab({ projectPath }: ProjectTabProps) {
  const [currentPath, setCurrentPath] = useState('/');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [file, setFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (relPath: string) => {
    setLoading(true);
    setError(null);
    setFile(null);
    try {
      const res = await fetch(`/api/files/list?root=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(relPath)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(data.error || res.statusText);
      }
      const data = await res.json();
      setEntries(data.items);
      setCurrentPath(relPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  const loadFile = useCallback(async (relPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/files/read?root=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(relPath)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(data.error || res.statusText);
      }
      const data: FileContent = await res.json();
      setFile(data);
      setCurrentPath(relPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  // Load root on mount
  useEffect(() => {
    if (projectPath) loadDir('/');
  }, [projectPath, loadDir]);

  const navigateUp = useCallback(() => {
    if (file) {
      // Go back to the file's parent directory
      const parts = currentPath.split('/').filter(Boolean);
      parts.pop();
      loadDir('/' + parts.join('/'));
      return;
    }
    if (currentPath === '/') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    loadDir('/' + parts.join('/'));
  }, [currentPath, file, loadDir]);

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

  // Breadcrumb segments
  const breadcrumbs = currentPath.split('/').filter(Boolean);
  const projectName = projectPath.split('/').filter(Boolean).pop() || projectPath;

  return (
    <div className={styles.projectTab}>
      {/* Toolbar: back button + breadcrumb */}
      <div className={styles.toolbar}>
        <button
          className={styles.backBtn}
          onClick={navigateUp}
          disabled={currentPath === '/' && !file}
          title="Go up"
        >
          &#8592;
        </button>
        <div className={styles.breadcrumb}>
          <button className={styles.breadBtn} onClick={() => { setFile(null); loadDir('/'); }}>
            {projectName}
          </button>
          {breadcrumbs.map((seg, i) => {
            const isLast = i === breadcrumbs.length - 1;
            const segPath = '/' + breadcrumbs.slice(0, i + 1).join('/');
            return (
              <span key={segPath}>
                <span className={styles.breadSep}>/</span>
                {isLast ? (
                  <span className={styles.breadCurrent}>{seg}</span>
                ) : (
                  <button className={styles.breadBtn} onClick={() => { setFile(null); loadDir(segPath); }}>
                    {seg}
                  </button>
                )}
              </span>
            );
          })}
        </div>
      </div>

      {/* Content: file list or file viewer */}
      <div className={styles.content}>
        {loading && <div className={styles.empty}>Loading...</div>}

        {error && <div className={styles.empty} style={{ color: 'var(--accent-red)' }}>{error}</div>}

        {!loading && !error && !file && entries.length === 0 && (
          <div className={styles.empty}>EMPTY DIRECTORY</div>
        )}

        {!loading && !error && !file && entries.length > 0 && (
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

        {!loading && !error && file && (
          <div className={styles.fileViewer}>
            {file.binary ? (
              <div className={styles.empty}>
                Binary file ({formatSize(file.size)})
              </div>
            ) : file.ext === 'md' || file.ext === 'mdx' ? (
              <div
                className={styles.markdown}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(file.content || '') }}
              />
            ) : (
              <pre className={styles.codeBlock}>{file.content}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

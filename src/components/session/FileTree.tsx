/**
 * FileTree — react-arborist tree component for project file navigation.
 * Lazily loads directory children on expand via FileSystemProvider.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Tree, NodeRendererProps } from 'react-arborist';
import type { TreeApi } from 'react-arborist';
import { getFileSystemProvider } from '@/lib/fileSystemProvider';
import type { DirEntry } from '@/lib/fileSystemProvider';
import styles from '@/styles/modules/FileTree.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TreeNode {
  id: string;
  name: string;
  isDir: boolean;
  size?: number;
  mtime?: string;
  children?: TreeNode[];
  /** True while children are being fetched */
  isLoading?: boolean;
}

interface FileTreeProps {
  projectPath: string;
  showHidden?: boolean;
  /** Called when a file is clicked */
  onFileSelect: (relPath: string) => void;
  /** Called when a directory is selected (single click) */
  onDirSelect?: (relPath: string) => void;
  /** Height of the tree container (px). Defaults to 400. */
  height?: number;
  /** The currently active file path (for highlighting) */
  activeFilePath?: string | null;
  /** Search term passed to react-arborist for filtering */
  searchTerm?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileIcon(name: string, isDir: boolean): string {
  if (isDir) return '\u{1F4C1}';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    md: '\u{1F4DD}', mdx: '\u{1F4DD}', txt: '\u{1F4C4}',
    ts: '\u{1F535}', tsx: '\u{1F535}', js: '\u{1F7E1}', jsx: '\u{1F7E1}',
    json: '\u{1F4CB}', yaml: '\u{1F4CB}', yml: '\u{1F4CB}', toml: '\u{1F4CB}',
    css: '\u{1F3A8}', scss: '\u{1F3A8}', html: '\u{1F310}',
    py: '\u{1F40D}', go: '\u{1F439}', rs: '\u2699', java: '\u2615',
    sh: '\u{1F4DF}', bash: '\u{1F4DF}', zsh: '\u{1F4DF}',
    sql: '\u{1F5C3}', graphql: '\u{1F5C3}',
    svg: '\u{1F5BC}', png: '\u{1F5BC}', jpg: '\u{1F5BC}', gif: '\u{1F5BC}',
    env: '\u{1F512}', lock: '\u{1F512}',
  };
  return map[ext] || '\u{1F4C4}';
}

function entriesToNodes(entries: DirEntry[], parentPath: string): TreeNode[] {
  return entries.map((e) => {
    const id = parentPath === '/' ? `/${e.name}` : `${parentPath}/${e.name}`;
    return {
      id,
      name: e.name,
      isDir: e.type === 'dir',
      size: e.size,
      mtime: e.mtime,
      // Dirs get a placeholder children array so react-arborist shows expand arrow
      children: e.type === 'dir' ? [] : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Node renderer
// ---------------------------------------------------------------------------

function Node({ node, style, dragHandle }: NodeRendererProps<TreeNode>) {
  const data = node.data;
  const isActive = node.isSelected;

  return (
    <div
      ref={dragHandle}
      style={style}
      className={`${styles.node} ${isActive ? styles.nodeActive : ''} ${node.state.isFocused ? styles.nodeFocused : ''}`}
      onClick={() => node.isInternal ? node.toggle() : node.activate()}
    >
      {node.isInternal && (
        <span className={`${styles.arrow} ${node.isOpen ? styles.arrowOpen : ''}`}>
          {'\u25B6'}
        </span>
      )}
      {node.isLeaf && <span className={styles.arrowSpacer} />}
      <span className={styles.icon}>{fileIcon(data.name, data.isDir)}</span>
      <span className={styles.name} title={data.name}>{data.name}</span>
      {data.isLoading && <span className={styles.spinner}>...</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function FileTree({
  projectPath,
  showHidden = false,
  onFileSelect,
  onDirSelect,
  height: externalHeight,
  activeFilePath,
  searchTerm,
}: FileTreeProps) {
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const treeRef = useRef<TreeApi<TreeNode>>(null);
  const loadedDirs = useRef<Set<string>>(new Set());
  const provider = useMemo(() => getFileSystemProvider(), []);

  // Self-sizing: measure the container height via ResizeObserver
  const containerRef = useRef<HTMLDivElement>(null);
  const [measuredHeight, setMeasuredHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = Math.floor(entry.contentRect.height);
        if (h > 0) setMeasuredHeight(h);
      }
    });
    ro.observe(el);
    const h = el.clientHeight;
    if (h > 0) setMeasuredHeight(h);
    return () => ro.disconnect();
  }, []);

  const height = externalHeight ?? (measuredHeight > 0 ? measuredHeight : 400);

  // Load root directory on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadedDirs.current.clear();

    provider.listDir(projectPath, '/', showHidden).then(({ items }) => {
      if (cancelled) return;
      const nodes = entriesToNodes(items, '/');
      setTreeData(nodes);
      loadedDirs.current.add('/');
      setLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [projectPath, showHidden, provider]);

  // Lazy-load children when a directory is toggled open.
  // Track in-flight loads to avoid duplicate requests.
  const loadingDirs = useRef<Set<string>>(new Set());

  const handleToggle = useCallback((id: string) => {
    // Skip if already loaded with children, or if a load is in-flight
    if (loadingDirs.current.has(id)) return;
    if (loadedDirs.current.has(id)) return;

    loadingDirs.current.add(id);

    // Mark as loading
    setTreeData((prev) => updateNodeInTree(prev, id, (n) => ({
      ...n,
      isLoading: true,
      children: n.children?.length ? n.children : [],
    })));

    provider.listDir(projectPath, id, showHidden).then(({ items }) => {
      const children = entriesToNodes(items, id);
      // Only mark as fully loaded when the API returned children.
      // Empty results may be transient (server not ready, race condition) —
      // leaving it out of loadedDirs allows retry on next toggle.
      if (children.length > 0) {
        loadedDirs.current.add(id);
      }
      setTreeData((prev) => updateNodeInTree(prev, id, (n) => ({
        ...n,
        isLoading: false,
        children,
      })));
    }).catch(() => {
      setTreeData((prev) => updateNodeInTree(prev, id, (n) => ({
        ...n,
        isLoading: false,
        children: [],
      })));
    }).finally(() => {
      loadingDirs.current.delete(id);
    });
  }, [projectPath, showHidden, provider]);

  // Handle activation (double-click or Enter on a node)
  const handleActivate = useCallback((node: { data: TreeNode }) => {
    const data = node.data;
    if (data.isDir) {
      onDirSelect?.(data.id);
    } else {
      onFileSelect(data.id);
    }
  }, [onFileSelect, onDirSelect]);

  // Refresh the entire tree while preserving expanded directories
  const refresh = useCallback(async () => {
    // Capture which directories were previously loaded and which are currently open
    const prevLoaded = new Set(loadedDirs.current);
    const openDirIds: string[] = [];
    if (treeRef.current) {
      for (const dirId of prevLoaded) {
        if (dirId === '/') continue;
        const node = treeRef.current.get(dirId);
        if (node?.isOpen) {
          openDirIds.push(dirId);
        }
      }
    }

    loadedDirs.current.clear();
    setLoading(true);

    try {
      // Load root directory
      const { items: rootItems } = await provider.listDir(projectPath, '/', showHidden);
      loadedDirs.current.add('/');
      let nodes = entriesToNodes(rootItems, '/');

      // Reload all previously-loaded directories in parallel
      const dirsToReload = Array.from(prevLoaded).filter(d => d !== '/');
      if (dirsToReload.length > 0) {
        const results = await Promise.allSettled(
          dirsToReload.map(async (dirId) => {
            const { items } = await provider.listDir(projectPath, dirId, showHidden);
            return { dirId, children: entriesToNodes(items, dirId) };
          })
        );

        // Apply results depth-first (parents before children)
        const successResults = results
          .filter((r): r is PromiseFulfilledResult<{ dirId: string; children: TreeNode[] }> =>
            r.status === 'fulfilled')
          .map(r => r.value)
          .sort((a, b) => a.dirId.split('/').length - b.dirId.split('/').length);

        for (const { dirId, children } of successResults) {
          if (children.length > 0) {
            loadedDirs.current.add(dirId);
          }
          nodes = updateNodeInTree(nodes, dirId, (n) => ({
            ...n,
            isLoading: false,
            children,
          }));
        }
      }

      setTreeData(nodes);

      // Re-open previously open directories after React renders the new data
      if (openDirIds.length > 0) {
        requestAnimationFrame(() => {
          if (!treeRef.current) return;
          for (const dirId of openDirIds) {
            treeRef.current.open(dirId);
          }
        });
      }
    } catch {
      // Root load failed
    } finally {
      setLoading(false);
    }
  }, [projectPath, showHidden, provider]);

  // Expose refresh via custom event
  useEffect(() => {
    const handler = () => refresh();
    document.addEventListener('filetree:refresh', handler);
    return () => document.removeEventListener('filetree:refresh', handler);
  }, [refresh]);

  // Auto-reveal: expand ancestor directories and scroll to the active file
  const lastRevealedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeFilePath || activeFilePath === lastRevealedRef.current) return;
    lastRevealedRef.current = activeFilePath;

    // Build list of ancestor directory IDs to expand
    const parts = activeFilePath.split('/').filter(Boolean);
    if (parts.length <= 1) return; // root-level file, no dirs to expand
    const ancestors: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      ancestors.push('/' + parts.slice(0, i).join('/'));
    }

    let cancelled = false;

    async function revealPath() {
      // Sequentially load each ancestor directory if not yet loaded
      for (const dirId of ancestors) {
        if (cancelled) return;
        if (!loadedDirs.current.has(dirId)) {
          try {
            const { items } = await provider.listDir(projectPath, dirId, showHidden);
            if (cancelled) return;
            loadedDirs.current.add(dirId);
            const children = entriesToNodes(items, dirId);
            setTreeData((prev) => updateNodeInTree(prev, dirId, (n) => ({
              ...n, isLoading: false, children,
            })));
          } catch {
            return; // stop if a dir fails to load
          }
        }
      }

      // Wait for React to render the new tree data, then open ancestors and scroll
      requestAnimationFrame(() => {
        if (cancelled || !treeRef.current) return;
        for (const dirId of ancestors) {
          treeRef.current.open(dirId);
        }
        requestAnimationFrame(() => {
          if (cancelled || !treeRef.current) return;
          treeRef.current.scrollTo(activeFilePath);
        });
      });
    }

    revealPath();
    return () => { cancelled = true; };
  }, [activeFilePath, projectPath, showHidden, provider]);

  return (
    <div ref={containerRef} className={styles.container}>
      {error ? (
        <div className={styles.error}>{error}</div>
      ) : loading && treeData.length === 0 ? (
        <div className={styles.loading}>Loading...</div>
      ) : (
        <Tree<TreeNode>
          ref={treeRef}
          data={treeData}
          idAccessor="id"
          childrenAccessor="children"
          onToggle={handleToggle}
          onActivate={handleActivate}
          selection={activeFilePath ?? undefined}
          searchTerm={searchTerm}
          searchMatch={(node, term) => node.data.name.toLowerCase().includes(term.toLowerCase())}
          openByDefault={false}
          disableDrag
          disableDrop
          disableEdit
          disableMultiSelection
          rowHeight={26}
          indent={16}
          height={height}
          width="100%"
          className={styles.tree}
          rowClassName={styles.row}
        >
          {Node}
        </Tree>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree update helper — immutably update a node by id deep in the tree
// ---------------------------------------------------------------------------

function updateNodeInTree(
  nodes: TreeNode[],
  targetId: string,
  updater: (node: TreeNode) => TreeNode,
): TreeNode[] {
  return nodes.map((node) => {
    if (node.id === targetId) return updater(node);
    if (node.children && targetId.startsWith(node.id + '/')) {
      return { ...node, children: updateNodeInTree(node.children, targetId, updater) };
    }
    return node;
  });
}

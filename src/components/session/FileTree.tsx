/**
 * FileTree — react-arborist tree component for project file navigation.
 * Lazily loads directory children on expand via FileSystemProvider.
 *
 * Persistence: expanded folders + scrollTop are written to localStorage
 * under `agent-manager:tree-state:${projectPath}` (debounced 200ms) so state
 * survives tab unmount/remount in DetailTabs.
 */
import { useState, useEffect, useCallback, useRef, useMemo, forwardRef, useImperativeHandle } from 'react';
import { Tree, NodeRendererProps } from 'react-arborist';
import type { TreeApi } from 'react-arborist';
import { getFileSystemProvider } from '@/lib/fileSystemProvider';
import type { DirEntry } from '@/lib/fileSystemProvider';
import styles from '@/styles/modules/FileTree.module.css';

/**
 * Imperative handle exposed via forwardRef — lets parents (e.g. ProjectTab
 * toolbar) trigger tree-wide actions without duplicating state logic.
 */
export interface FileTreeHandle {
  /** Close every currently-open directory. */
  collapseAll(): void;
  /** Re-load the tree from disk, preserving open dirs + scroll. */
  refresh(): Promise<void>;
}

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
  /**
   * Called when the user requests deletion of a node via the per-row trash
   * icon or Cmd/Ctrl+Delete (Backspace) on the focused row. The parent is
   * expected to confirm with the user before calling the delete API.
   */
  onRequestDelete?: (relPath: string, name: string, isDir: boolean) => void;
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
// Persistence — expanded folders + scrollTop per projectPath
// ---------------------------------------------------------------------------

const TREE_STATE_VERSION = 1;

interface PersistedTreeState {
  openIds: string[];
  scrollTop: number;
  v: number;
}

function treeStateKey(projectPath: string): string {
  return `agent-manager:tree-state:${projectPath}`;
}

function readPersistedTreeState(projectPath: string): PersistedTreeState | null {
  if (!projectPath) return null;
  try {
    const raw = localStorage.getItem(treeStateKey(projectPath));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedTreeState>;
    if (parsed.v !== TREE_STATE_VERSION) return null;
    const openIds = Array.isArray(parsed.openIds)
      ? parsed.openIds.filter((id): id is string => typeof id === 'string')
      : [];
    const scrollTop = typeof parsed.scrollTop === 'number' && parsed.scrollTop >= 0
      ? parsed.scrollTop
      : 0;
    return { openIds, scrollTop, v: TREE_STATE_VERSION };
  } catch {
    return null;
  }
}

function writePersistedTreeState(projectPath: string, state: PersistedTreeState): void {
  if (!projectPath) return;
  try {
    localStorage.setItem(treeStateKey(projectPath), JSON.stringify(state));
  } catch {
    // localStorage full / disabled — silently ignore
  }
}

/** Find a node by id anywhere in the (possibly lazy) tree. */
function findNodeById(nodes: TreeNode[], targetId: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === targetId) return node;
    if (node.children && targetId.startsWith(node.id + '/')) {
      const found = findNodeById(node.children, targetId);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Node renderer
// ---------------------------------------------------------------------------

const isMacPlatform = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

type DeleteRequester = (relPath: string, name: string, isDir: boolean) => void;

function makeNodeRenderer(onRequestDelete?: DeleteRequester) {
  return function Node({ node, style, dragHandle }: NodeRendererProps<TreeNode>) {
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
        {onRequestDelete && (
          <button
            type="button"
            className={styles.deleteBtn}
            onClick={(e) => {
              e.stopPropagation();
              onRequestDelete(node.id, data.name, data.isDir);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            title={`Delete ${data.isDir ? 'folder' : 'file'} (${isMacPlatform ? 'Cmd' : 'Ctrl'}+Del)`}
            aria-label={`Delete ${data.name}`}
            tabIndex={-1}
          >
            {'\u{1F5D1}'}
          </button>
        )}
      </div>
    );
  };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree({
  projectPath,
  showHidden = false,
  onFileSelect,
  onDirSelect,
  height: externalHeight,
  activeFilePath,
  searchTerm,
  onRequestDelete,
}, ref) {
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const treeRef = useRef<TreeApi<TreeNode>>(null);
  const loadedDirs = useRef<Set<string>>(new Set());
  const provider = useMemo(() => getFileSystemProvider(), []);

  // Persistence refs — debounced writer + latest-known scroll offset
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTopRef = useRef<number>(0);
  // Set on mount from storage; consumed after tree data + rAF to restore scroll
  const pendingScrollTopRef = useRef<number | null>(null);

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

  // Load root directory on mount, then restore persisted open dirs + scroll.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadedDirs.current.clear();

    const persisted = readPersistedTreeState(projectPath);
    // Stash scrollTop to apply after tree data lands in the DOM
    pendingScrollTopRef.current = persisted?.scrollTop ?? null;
    lastScrollTopRef.current = persisted?.scrollTop ?? 0;

    async function loadAndRestore(): Promise<void> {
      try {
        const { items } = await provider.listDir(projectPath, '/', showHidden);
        if (cancelled) return;
        let nodes = entriesToNodes(items, '/');
        loadedDirs.current.add('/');

        // Parallel-load persisted open directories (skip ones that no longer exist)
        const candidates = (persisted?.openIds ?? []).filter(id => id !== '/' && id.startsWith('/'));
        if (candidates.length > 0) {
          // Sort shallow-first so parent loads happen before children are matched
          const sorted = [...candidates].sort(
            (a, b) => a.split('/').length - b.split('/').length,
          );

          // Load all candidate directories in parallel (settled — ignore failures)
          const results = await Promise.all(
            sorted.map((dirId) =>
              provider
                .listDir(projectPath, dirId, showHidden)
                .then((r) => ({ dirId, items: r.items, ok: true as const }))
                .catch(() => ({ dirId, items: [] as DirEntry[], ok: false as const })),
            ),
          );
          if (cancelled) return;

          // Apply in shallow-first order so each child's parent already exists
          for (const { dirId, items: childItems, ok } of results) {
            // Check the target dir still exists in the current tree (parent chain)
            const parent = findNodeById(nodes, dirId);
            if (!parent || !parent.isDir) continue;
            if (!ok) continue;
            const children = entriesToNodes(childItems, dirId);
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
        setLoading(false);

        // After React commits + react-arborist builds its list, open dirs + scroll.
        if (persisted && (persisted.openIds.length > 0 || persisted.scrollTop > 0)) {
          requestAnimationFrame(() => {
            if (cancelled || !treeRef.current) return;
            for (const id of persisted.openIds) {
              if (id === '/') continue;
              const node = treeRef.current.get(id);
              if (node) treeRef.current.open(id);
            }
            requestAnimationFrame(() => {
              if (cancelled || !treeRef.current) return;
              const list = treeRef.current.list.current;
              if (list && pendingScrollTopRef.current != null) {
                list.scrollTo(pendingScrollTopRef.current);
                pendingScrollTopRef.current = null;
              }
            });
          });
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }

    loadAndRestore();

    return () => { cancelled = true; };
  }, [projectPath, showHidden, provider]);

  // Debounced writer — captures current tree.openIds + lastScrollTop.
  const schedulePersist = useCallback(() => {
    if (!projectPath) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      if (!projectPath) return;
      const api = treeRef.current;
      const openIds: string[] = [];
      if (api) {
        // Iterate visible nodes; Tree exposes openState but we need Node.isOpen
        // on internal nodes. Walk the open map via visibleNodes for reliability.
        for (const node of api.visibleNodes) {
          if (node.isOpen && node.isInternal) {
            openIds.push(node.id);
          }
        }
      }
      writePersistedTreeState(projectPath, {
        openIds,
        scrollTop: lastScrollTopRef.current,
        v: TREE_STATE_VERSION,
      });
    }, 200);
  }, [projectPath]);

  // Flush pending write on unmount so last-known state is captured
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, []);

  // Scroll handler — stores the latest offset, debounces the persist write.
  const handleScroll = useCallback(
    (props: { scrollOffset: number }) => {
      lastScrollTopRef.current = props.scrollOffset;
      schedulePersist();
    },
    [schedulePersist],
  );

  // Lazy-load children when a directory is toggled open.
  // Track in-flight loads to avoid duplicate requests.
  const loadingDirs = useRef<Set<string>>(new Set());

  const handleToggle = useCallback((id: string) => {
    // Schedule a persist write — toggle may be opening OR closing a dir.
    // react-arborist updates its open state synchronously before onToggle fires
    // so the debounced writer will see the correct latest openIds.
    schedulePersist();

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
  }, [projectPath, showHidden, provider, schedulePersist]);

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

  // Expose imperative methods to parent components (e.g. toolbar buttons)
  useImperativeHandle(ref, () => ({
    collapseAll: () => {
      const api = treeRef.current;
      if (!api) return;
      // Iterate a stable snapshot — closing a node mutates visibleNodes.
      const openIds: string[] = [];
      for (const node of api.visibleNodes) {
        if (node.isOpen && node.isInternal) {
          openIds.push(node.id);
        }
      }
      for (const id of openIds) {
        api.close(id);
      }
      // Persistence: react-arborist's close() does not fire onToggle, so
      // schedule the debounced write ourselves so the cleared state lands
      // in localStorage.
      schedulePersist();
    },
    refresh: async () => {
      await refresh();
    },
  }), [refresh, schedulePersist]);

  // Auto-refresh: silently reload all loaded directories to detect external changes.
  // Unlike refresh(), this does not clear loadedDirs or set loading state, preventing
  // visual flashes and race conditions with user interactions during polling.
  const refreshingRef = useRef(false);

  const silentRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    const prevLoaded = new Set(loadedDirs.current);
    if (prevLoaded.size === 0) return;

    refreshingRef.current = true;

    try {
      const { items: rootItems } = await provider.listDir(projectPath, '/', showHidden);
      let nodes = entriesToNodes(rootItems, '/');
      const newLoaded = new Set(['/']);

      const dirsToReload = Array.from(prevLoaded).filter(d => d !== '/');
      if (dirsToReload.length > 0) {
        const results = await Promise.allSettled(
          dirsToReload.map(async (dirId) => {
            const { items } = await provider.listDir(projectPath, dirId, showHidden);
            return { dirId, children: entriesToNodes(items, dirId) };
          })
        );

        const successResults = results
          .filter((r): r is PromiseFulfilledResult<{ dirId: string; children: TreeNode[] }> =>
            r.status === 'fulfilled')
          .map(r => r.value)
          .sort((a, b) => a.dirId.split('/').length - b.dirId.split('/').length);

        for (const { dirId, children } of successResults) {
          if (children.length > 0) newLoaded.add(dirId);
          nodes = updateNodeInTree(nodes, dirId, (n) => ({
            ...n,
            isLoading: false,
            children,
          }));
        }
      }

      // Capture open state AFTER API calls complete so any user interactions
      // during the async window (e.g. collapseAll) are reflected correctly.
      // Reading before the await would snapshot stale state and re-open dirs
      // the user explicitly collapsed.
      const openDirIds: string[] = [];
      if (treeRef.current) {
        for (const dirId of newLoaded) {
          if (dirId === '/') continue;
          const node = treeRef.current.get(dirId);
          if (node?.isOpen) openDirIds.push(dirId);
        }
      }

      loadedDirs.current = newLoaded;
      setTreeData(nodes);

      if (openDirIds.length > 0) {
        requestAnimationFrame(() => {
          if (!treeRef.current) return;
          for (const dirId of openDirIds) {
            treeRef.current.open(dirId);
          }
        });
      }
    } catch {
      // Silently ignore — next poll will retry
    } finally {
      refreshingRef.current = false;
    }
  }, [projectPath, showHidden, provider]);

  useEffect(() => {
    const interval = setInterval(silentRefresh, 5000);
    return () => clearInterval(interval);
  }, [silentRefresh]);

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
          if (cancelled || !treeRef.current || !activeFilePath) return;
          treeRef.current.scrollTo(activeFilePath);
        });
      });
    }

    revealPath();
    return () => { cancelled = true; };
  }, [activeFilePath, projectPath, showHidden, provider]);

  // Bind onRequestDelete into the Node renderer so per-row trash buttons work.
  const nodeRenderer = useMemo(
    () => makeNodeRenderer(onRequestDelete),
    [onRequestDelete],
  );

  // Cmd/Ctrl + Delete (or Backspace on macOS) on the focused row fires the
  // delete request. The parent component owns confirmation + actual deletion.
  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!onRequestDelete) return;
      const hasMod = e.metaKey || e.ctrlKey;
      const isDeleteKey = e.key === 'Delete' || e.key === 'Backspace';
      if (!hasMod || !isDeleteKey) return;

      const api = treeRef.current;
      if (!api) return;
      const focused = api.focusedNode ?? api.selectedNodes[0] ?? null;
      if (!focused) return;

      e.preventDefault();
      e.stopPropagation();
      onRequestDelete(focused.id, focused.data.name, focused.data.isDir);
    },
    [onRequestDelete],
  );

  return (
    <div
      ref={containerRef}
      className={styles.container}
      onKeyDown={handleTreeKeyDown}
    >
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
          onScroll={handleScroll}
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
          {nodeRenderer}
        </Tree>
      )}
    </div>
  );
});

export default FileTree;

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

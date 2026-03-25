import { useState, useCallback, useRef } from 'react';
import { SettingsButton } from '@/components/settings/SettingsPanel';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { showToast } from '@/components/ui/ToastContainer';
import {
  buildSnapshot,
  downloadSnapshot,
  saveToConfig,
  loadFromConfig,
  loadFromFile,
  importSnapshot,
} from '@/lib/workspaceSnapshot';
import type { SessionSnapshot } from '@/lib/workspaceSnapshot';
import styles from '@/styles/modules/Header.module.css';

// ---------------------------------------------------------------------------
// Workspace Export/Import buttons
// ---------------------------------------------------------------------------

function WorkspaceButtons() {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLDivElement>(null);

  const handleExport = useCallback((target: 'file' | 'config') => {
    setShowExportMenu(false);
    const sessions = useSessionStore.getState().sessions;
    const rooms = useRoomStore.getState().rooms;
    const snapshot = buildSnapshot(sessions, rooms);

    if (snapshot.sessions.length === 0) {
      showToast('No sessions with SSH config to export', 'warning');
      return;
    }

    if (target === 'file') {
      downloadSnapshot(snapshot);
      showToast(`Exported ${snapshot.sessions.length} sessions to file`, 'success');
    } else {
      saveToConfig(snapshot)
        .then(() => showToast(`Saved ${snapshot.sessions.length} sessions to AASC config`, 'success'))
        .catch((err) => showToast(err.message, 'error'));
    }
  }, []);

  const handleImportSnapshot = useCallback(async (source: 'file' | 'config') => {
    setShowImportMenu(false);
    if (source === 'file') {
      fileInputRef.current?.click();
      return;
    }
    // Load from AASC config
    setImporting(true);
    try {
      const snapshot = await loadFromConfig();
      if (!snapshot) {
        showToast('No saved workspace found in AASC config', 'warning');
        return;
      }
      await importSnapshot(snapshot, {
        onSessionCreated: (terminalId: string, _snap: SessionSnapshot) => {
          useSessionStore.getState().selectSession(terminalId);
        },
        onComplete: (created: number, failed: number) => {
          const msg = `Imported ${created} session${created !== 1 ? 's' : ''}${failed > 0 ? `, ${failed} failed` : ''}`;
          showToast(msg, failed > 0 ? 'warning' : 'success');
          useRoomStore.getState().loadFromStorage();
        },
      });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Import failed', 'error');
    } finally {
      setImporting(false);
    }
  }, []);

  const handleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const snapshot = await loadFromFile(file);
      await importSnapshot(snapshot, {
        onSessionCreated: (terminalId: string, _snap: SessionSnapshot) => {
          useSessionStore.getState().selectSession(terminalId);
        },
        onComplete: (created: number, failed: number) => {
          const msg = `Imported ${created} session${created !== 1 ? 's' : ''}${failed > 0 ? `, ${failed} failed` : ''}`;
          showToast(msg, failed > 0 ? 'warning' : 'success');
          useRoomStore.getState().loadFromStorage();
        },
      });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Import failed', 'error');
    } finally {
      setImporting(false);
    }
  }, []);

  // Close dropdowns on outside click
  const closeMenus = useCallback(() => {
    setShowExportMenu(false);
    setShowImportMenu(false);
  }, []);

  return (
    <>
      {/* Backdrop to close menus */}
      {(showExportMenu || showImportMenu) && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 99 }}
          onClick={closeMenus}
        />
      )}

      {/* Export button */}
      <div ref={exportRef} style={{ position: 'relative' }}>
        <button
          onClick={() => { setShowExportMenu((v) => !v); setShowImportMenu(false); }}
          title="Export workspace"
          className={styles.headerIconBtn}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
        {showExportMenu && (
          <div className={styles.workspaceMenu}>
            <div className={styles.workspaceMenuTitle}>EXPORT WORKSPACE</div>
            <button
              className={styles.workspaceMenuItem}
              onClick={() => handleExport('file')}
            >
              <span className={styles.workspaceMenuIcon}>&#128190;</span>
              Save as JSON file
            </button>
            <button
              className={styles.workspaceMenuItem}
              onClick={() => handleExport('config')}
            >
              <span className={styles.workspaceMenuIcon}>&#9881;</span>
              Save to AASC config
            </button>
          </div>
        )}
      </div>

      {/* Import button */}
      <div ref={importRef} style={{ position: 'relative' }}>
        <button
          onClick={() => { setShowImportMenu((v) => !v); setShowExportMenu(false); }}
          title="Import workspace"
          className={styles.headerIconBtn}
          disabled={importing}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </button>
        {showImportMenu && (
          <div className={styles.workspaceMenu}>
            <div className={styles.workspaceMenuTitle}>IMPORT WORKSPACE</div>
            <button
              className={styles.workspaceMenuItem}
              onClick={() => handleImportSnapshot('file')}
            >
              <span className={styles.workspaceMenuIcon}>&#128193;</span>
              Load from JSON file
            </button>
            <button
              className={styles.workspaceMenuItem}
              onClick={() => handleImportSnapshot('config')}
            >
              <span className={styles.workspaceMenuIcon}>&#9881;</span>
              Load from AASC config
            </button>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={handleFileSelected}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function ExitButton() {
  if (!window.electronAPI) return null;
  return (
    <button
      className={`${styles.headerIconBtn} ${styles.exitBtn}`}
      onClick={() => window.electronAPI?.quitApp()}
      title="Quit"
      aria-label="Quit application"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 2v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
        <path d="M5 3.8A6 6 0 1 0 11 3.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none"/>
      </svg>
    </button>
  );
}

export default function Header() {
  return (
    <header className={styles.header}>
      <div className={styles.title}>AI AGENT SESSION CENTER</div>

      <div className={styles.stats}>
        <WorkspaceButtons />
        <SettingsButton />
        <ExitButton />
      </div>
    </header>
  );
}

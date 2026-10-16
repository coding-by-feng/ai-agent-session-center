/**
 * NewSessionModal - Local terminal creation form.
 * Fields: working dir, command, session title, room, API key,
 * remote control, model, effort level, commands terminal.
 *
 * On a phone it fills the screen (Modal.module.css). In the phone app
 * (AASC-18) it asks only for what a paired phone may send (server/mobile/
 * phoneProfile.ts): a folder, Claude or Codex, a title, the room, model and
 * effort. The API key, Remote Control, the commands terminal and a free-form
 * command are refused for a phone, so they are not offered. AASC-54: the folder
 * can be any folder under the Mac's home folder that isn't hidden or private,
 * found with "Browse…" (the phone's folder browser, loaded lazily: the kit
 * stays out of the desktop's entry chunk); one no agent has worked in asks
 * "Start in a new folder?" before the session starts. The room is asked of the
 * Mac (a phone doesn't own the room list).
 */
import { lazy, Suspense, useEffect, useState, useMemo } from 'react';
import type {
  CodexModelOption,
  CreateTerminalRequest,
  ListCodexModelsResponse,
} from '@/types/api';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { CLI_LAUNCHERS } from '@/components/layout/cliLaunchers';
import { isNativeMobileApp } from '@/lib/platform';
import Combobox from '@/components/ui/Combobox';
import Select from '@/components/ui/Select';
import BrowseDirButton from '@/components/ui/BrowseDirButton';
import { showToast } from '@/components/ui/ToastContainer';
import { useUiStore } from '@/stores/uiStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { useKnownProjects } from '@/hooks/useKnownProjects';
import { getCommandSuggestions, saveCommand } from '@/lib/commandSuggestions';
import { isKnownFolder } from '@/lib/folderBrowser';
import { sendRoomOp } from '@/lib/roomOps';
import {
  deriveRemoteControlName,
  loadRemoteControlSettings,
  saveRemoteControlSettings,
  sanitizeRemoteControlName,
  loadSessionPrefs,
  saveSessionPrefs,
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  normalizeEffortLevel,
} from '@/lib/remoteControlName';
import styles from '@/styles/modules/Modal.module.css';

// Phone-only (the phone kit): never in the desktop's entry chunk.
const PhoneFolderBrowser = lazy(() => import('@/components/mobile/PhoneFolderBrowser'));
const NewFolderConfirm = lazy(() => import('@/components/mobile/NewFolderConfirm'));

// ---------------------------------------------------------------------------
// Working directory history (localStorage)
// ---------------------------------------------------------------------------

const WORKDIR_HISTORY_KEY = 'workdir-history';
const MAX_WORKDIR_HISTORY = 20;
const LAST_SESSION_KEY = 'lastSession';
const DIR_SESSION_CONFIGS_KEY = 'dir-session-configs';

interface LastSessionConfig {
  workingDir?: string;
  command?: string;
}

function loadLastSession(): LastSessionConfig {
  try {
    return JSON.parse(localStorage.getItem(LAST_SESSION_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveLastSession(config: LastSessionConfig): void {
  try {
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(config));
  } catch { /* ignore quota errors */ }
}

function saveDirSessionConfig(dir: string, config: LastSessionConfig): void {
  if (!dir) return;
  try {
    const all: Record<string, LastSessionConfig> = JSON.parse(
      localStorage.getItem(DIR_SESSION_CONFIGS_KEY) || '{}',
    );
    all[dir] = { ...config, workingDir: dir };
    localStorage.setItem(DIR_SESSION_CONFIGS_KEY, JSON.stringify(all));
  } catch { /* ignore quota errors */ }
}

function loadWorkdirHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(WORKDIR_HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveWorkdir(dir: string): void {
  if (!dir) return;
  const history = loadWorkdirHistory().filter((d) => d !== dir);
  history.unshift(dir);
  localStorage.setItem(WORKDIR_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_WORKDIR_HISTORY)));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function NewSessionModal() {
  const closeModal = useUiStore((s) => s.closeModal);
  const activeModal = useUiStore((s) => s.activeModal);
  const [saved] = useState(() => loadLastSession());
  // The phone app: a CLI choice instead of a command, and no home-folder default
  // (a phone may start a session only in a known project folder).
  const [phoneApp] = useState(() => isNativeMobileApp());
  const [workingDir, setWorkingDir] = useState(() => (
    phoneApp && (!saved.workingDir || saved.workingDir === '~') ? '' : saved.workingDir || '~'
  ));
  const [command, setCommand] = useState(() => (
    phoneApp
      ? (CLI_LAUNCHERS.some((c) => c.command === saved.command) ? saved.command! : 'claude')
      : saved.command || ''
  ));
  const [apiKey, setApiKey] = useState('');
  const [sessionTitle, setSessionTitle] = useState('');
  const [roomId, setRoomId] = useState('');
  const [sessionPrefs] = useState(() => loadSessionPrefs());
  const [effortLevel, setEffortLevel] = useState(normalizeEffortLevel(sessionPrefs.effortLevel));
  const [claudeModel, setClaudeModel] = useState(sessionPrefs.model || '');
  const [codexModel, setCodexModel] = useState(sessionPrefs.codexModel || '');
  const [codexModels, setCodexModels] = useState<CodexModelOption[]>([]);
  const [codexModelStatus, setCodexModelStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [codexCatalogStale, setCodexCatalogStale] = useState(false);
  const [enableOpsTerminal, setEnableOpsTerminal] = useState(false);
  const [remoteControlSettings] = useState(() => loadRemoteControlSettings());
  const [autoEnableRemoteControl, setAutoEnableRemoteControl] = useState(
    !!remoteControlSettings.autoEnable,
  );
  const [enableRemoteControl, setEnableRemoteControl] = useState(
    !!remoteControlSettings.autoEnable || remoteControlSettings.enabled,
  );
  const [remoteControlName, setRemoteControlName] = useState('');
  const [remoteControlNameTouched, setRemoteControlNameTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // The phone app's folder browser, the folder waiting for "Start in a new folder?",
  // and the Mac's home folder (from the browser) to read a typed `~/…` path.
  const [browseOpen, setBrowseOpen] = useState(false);
  const [confirmDir, setConfirmDir] = useState<string | null>(null);
  const [macHome, setMacHome] = useState<string | null>(null);

  // A folder handed in by the opener (the phone's ＋ sheet, AASC-54). Adjusted
  // during render, not in an effect: the form stays mounted between openings.
  const newSessionDir = useUiStore((s) => s.newSessionDir);
  const [seenNewSessionDir, setSeenNewSessionDir] = useState<string | null>(null);
  if (newSessionDir !== seenNewSessionDir) {
    setSeenNewSessionDir(newSessionDir);
    if (newSessionDir) setWorkingDir(newSessionDir);
  }

  // Working directory history (merged with known Claude Code projects)
  const workdirHistory = useKnownProjects();
  // Folders an agent has worked in: these start without the new-folder confirm.
  const sessions = useSessionStore((s) => s.sessions);
  const usedFolders = useMemo(() => {
    const used = new Set(workdirHistory);
    for (const s of sessions.values()) if (s.projectPath) used.add(s.projectPath);
    return [...used];
  }, [workdirHistory, sessions]);

  // Command history
  const commandSuggestions = useMemo(() => getCommandSuggestions(), []);

  // Rooms
  const rooms = useRoomStore((s) => s.rooms);
  const roomOptions = useMemo(() => rooms.map((r) => r.name), [rooms]);

  const isClaudeCommand = command.trim().toLowerCase().startsWith('claude');
  const isCodexCommand = /^(?:\S*\/)?codex(?:\s|$)/i.test(command.trim());
  const apiKeyEnvName = isCodexCommand
    ? 'OPENAI_API_KEY'
      : 'ANTHROPIC_API_KEY';

  useEffect(() => {
    if (activeModal !== 'new-session' || !isCodexCommand) return;

    const controller = new AbortController();
    setCodexModelStatus('loading');
    setCodexCatalogStale(false);

    void fetch('/api/codex/models', { signal: controller.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Codex model catalog returned ${res.status}`);
        return res.json() as Promise<ListCodexModelsResponse>;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setCodexModels(data.models);
        setCodexCatalogStale(data.stale);
        setCodexModel((current) => (
          current && data.models.some((item) => item.id === current) ? current : ''
        ));
        setCodexModelStatus('ready');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setCodexModels([]);
        setCodexModel('');
        setCodexModelStatus('error');
      });

    return () => controller.abort();
  }, [activeModal, isCodexCommand]);

  const codexModelOptions = useMemo(() => {
    const recommended = codexModels.find((item) => item.isDefault);
    return [
      {
        value: '',
        label: recommended
          ? `Default (Codex recommended: ${recommended.displayName})`
          : 'Default (Codex recommended)',
      },
      ...codexModels.map((item) => ({ value: item.id, label: item.displayName })),
    ];
  }, [codexModels]);
  const selectedCodexModel = codexModels.find((item) => item.id === codexModel)
    ?? codexModels.find((item) => item.isDefault);
  const autoRemoteControlName = useMemo(
    () => deriveRemoteControlName(sessionTitle, workingDir, useSessionStore.getState().sessions.values()),
    [sessionTitle, workingDir],
  );
  const effectiveRemoteControlName = remoteControlNameTouched && remoteControlName
    ? sanitizeRemoteControlName(remoteControlName)
    : autoRemoteControlName;

  // #33: Client-side form validation — required fields
  const workingDirValid = workingDir.trim().length > 0;
  const commandValid = command.trim().length > 0;
  const formValid = workingDirValid && commandValid;

  async function handleSubmit(newFolderConfirmed = false) {
    // Mark all required fields as touched so validation errors show
    setTouched({ workingDir: true, command: true });
    if (submitting || !formValid) return;
    // A phone asks before it starts where no agent has worked (AASC-54).
    if (phoneApp && !newFolderConfirmed && !isKnownFolder(workingDir, usedFolders, macHome)) {
      setConfirmDir(workingDir.trim());
      return;
    }
    setSubmitting(true);

    // No host/username — the server resolves a host-less request to a local
    // PTY and falls back to the OS user.
    const body: CreateTerminalRequest = {
      workingDir: workingDir || '~',
      command: command || undefined,
      apiKey: (!phoneApp && apiKey) || undefined,
      sessionTitle: sessionTitle || undefined,
      effortLevel: isClaudeCommand ? effortLevel || undefined : undefined,
      model: isClaudeCommand
        ? claudeModel || undefined
        : isCodexCommand
          ? codexModel || undefined
          : undefined,
      enableOpsTerminal: (!phoneApp && enableOpsTerminal) || undefined,
      remoteControlName:
        !phoneApp && isClaudeCommand && enableRemoteControl && effectiveRemoteControlName
          ? effectiveRemoteControlName
          : undefined,
      forceNew: true,
      // A phone's folder must be there: never the home-folder fallback for a missing one.
      requireExistingDir: phoneApp || undefined,
    };

    try {
      const res = await fetch('/api/terminals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        saveWorkdir(workingDir);
        if (command) saveCommand(command);
        const configToSave: LastSessionConfig = {
          workingDir: workingDir || '~',
          command: command || undefined,
        };
        saveLastSession(configToSave);
        saveDirSessionConfig(workingDir || '~', configToSave);
        saveSessionPrefs({
          model: claudeModel || undefined,
          codexModel: codexModel || undefined,
          effortLevel: effortLevel || undefined,
        });
        if (!phoneApp) saveRemoteControlSettings({
          enabled: enableRemoteControl,
          autoEnable: autoEnableRemoteControl,
          lastName: remoteControlNameTouched ? remoteControlName : undefined,
        });
        // Auto-select the new session so the detail panel stays open
        if (data.terminalId) {
          useSessionStore.getState().selectSession(data.terminalId);
          // Assign to selected room. The phone app asks the Mac, which owns the list.
          if (roomId && phoneApp) {
            void sendRoomOp({ type: 'move', sessionId: data.terminalId, roomId }).then((outcome) => {
              if (!outcome.ok) showToast(outcome.message, 'error');
            });
          } else if (roomId) {
            useRoomStore.getState().addSession(roomId, data.terminalId);
          }
        }
        showToast('Terminal session created', 'success');
        closeModal();
      } else {
        showToast(data.error || 'Failed to create terminal', 'error');
      }
    } catch {
      showToast('Network error creating terminal', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal modalId="new-session" title="New Terminal Session" panelClassName={styles.newSessionPanel}>
      <div className={styles.newSessionBody}>
        {/* Working directory */}
        <div className={styles.sshField}>
          <label>Working Directory <span className={styles.sshFieldRequired}>*</span></label>
          <div className={styles.workdirInputRow}>
            <Combobox
              value={workingDir}
              onChange={setWorkingDir}
              items={workdirHistory}
              placeholder={phoneApp ? 'Choose a project folder' : '~'}
              className={styles.workdirCombo}
            />
            {phoneApp ? (
              <Button onClick={() => setBrowseOpen(true)}>Browse…</Button>
            ) : (
              <BrowseDirButton onPick={setWorkingDir} defaultPath={workingDir} />
            )}
          </div>
          {touched.workingDir && !workingDirValid && (
            <span className={styles.sshFieldError}>Required</span>
          )}
        </div>

        {/* Command — in the phone app, Claude or Codex (all a phone may start) */}
        {phoneApp ? (
          <div className={styles.sshField}>
            <span className={styles.phoneFieldLabel} id="new-session-cli">CLI</span>
            <div className={styles.cliChoice} role="group" aria-labelledby="new-session-cli">
              {CLI_LAUNCHERS.map(({ command: cli, label, Icon }) => (
                <Button key={cli} pressed={command === cli} icon={<Icon size={16} />} onClick={() => setCommand(cli)}>
                  {label}
                </Button>
              ))}
            </div>
          </div>
        ) : (
        <div className={styles.sshField}>
          <label>
            Command <span className={styles.sshFieldRequired}>*</span> <span className={styles.sshFieldHint}>(runs in directory)</span>
          </label>
          <Combobox
            value={command}
            onChange={setCommand}
            items={commandSuggestions}
            placeholder="e.g. claude"
          />
          {touched.command && !commandValid && (
            <span className={styles.sshFieldError}>Required</span>
          )}
        </div>
        )}

        {/* Session title */}
        <div className={styles.sshField}>
          <label>Session Title</label>
          <input value={sessionTitle} onChange={(e) => setSessionTitle(e.target.value)} placeholder="Optional" />
        </div>

        {/* Room */}
        <div className={styles.sshField}>
          <label>Room</label>
          <Combobox
            value={roomId ? (rooms.find((r) => r.id === roomId)?.name ?? '') : ''}
            onChange={(v) => {
              const match = rooms.find((r) => r.name === v);
              setRoomId(match ? match.id : '');
            }}
            items={roomOptions}
            placeholder="None (corridor)"
          />
        </div>

        {/* API key (not from the phone app: a phone may not set one) */}
        {!phoneApp && (
        <div className={styles.sshField}>
          <label>
            API Key <span className={styles.sshFieldHint}>(override {apiKeyEnvName})</span>
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Optional"
          />
        </div>
        )}

        {/* Remote control (Claude only; not from the phone app) */}
        {!phoneApp && isClaudeCommand && (
          <div className={styles.sshField}>
            <label className={styles.opsCheckboxRow} style={{ marginBottom: 4 }}>
              <input
                type="checkbox"
                checked={enableRemoteControl}
                onChange={(e) => setEnableRemoteControl(e.target.checked)}
              />
              <div className={styles.opsCheckboxText}>
                <span className={styles.opsCheckboxLabel}>Enable Remote Control</span>
                <span className={styles.opsCheckboxHint}>Auto-runs <code>/remote-control &lt;name&gt;</code> after Claude starts</span>
              </div>
            </label>
            {enableRemoteControl && (
              <input
                value={remoteControlNameTouched ? remoteControlName : autoRemoteControlName}
                onChange={(e) => {
                  setRemoteControlName(e.target.value);
                  setRemoteControlNameTouched(true);
                }}
                placeholder={autoRemoteControlName}
                style={{ marginTop: 4 }}
              />
            )}
            <label className={styles.opsCheckboxRow} style={{ marginTop: 6 }}>
              <input
                type="checkbox"
                checked={autoEnableRemoteControl}
                onChange={(e) => setAutoEnableRemoteControl(e.target.checked)}
              />
              <div className={styles.opsCheckboxText}>
                <span className={styles.opsCheckboxLabel}>Auto-enable for future Claude sessions</span>
                <span className={styles.opsCheckboxHint}>Pre-checks the box above whenever the command starts with <code>claude</code></span>
              </div>
            </label>
          </div>
        )}

        {/* Model + Effort level (Claude only) */}
        {command.trim().toLowerCase().startsWith('claude') && (
        <div className={styles.sshFieldRow}>
          <div className={`${styles.sshField} ${styles.sshFieldGrow}`}>
            <label>Model</label>
            <Combobox
              value={claudeModel}
              onChange={setClaudeModel}
              items={[...MODEL_OPTIONS]}
              placeholder="Default"
            />
          </div>
          <div className={`${styles.sshField} ${styles.sshFieldGrow}`}>
            <label>Effort Level</label>
            <Combobox
              value={effortLevel}
              onChange={setEffortLevel}
              items={[...EFFORT_LEVELS]}
              placeholder="high"
            />
          </div>
        </div>
        )}

        {/* Official account-visible model catalog (Codex only) */}
        {isCodexCommand && (
          <div className={styles.sshField}>
            <label>
              Codex Model <span className={styles.sshFieldHint}>(official catalog)</span>
            </label>
            {codexModelStatus === 'loading' && (
              <input disabled value="Loading official Codex models..." readOnly />
            )}
            {codexModelStatus === 'ready' && (
              <Select
                value={codexModel}
                onChange={setCodexModel}
                options={codexModelOptions}
                placeholder="Default (Codex recommended)"
                className={styles.codexModelSelect}
                title="Codex model"
              />
            )}
            {codexModelStatus === 'error' && (
              <>
                <input disabled value="Default (catalog unavailable)" readOnly />
                <span className={styles.sshFieldError}>
                  Catalog unavailable — Codex default will be used.
                </span>
              </>
            )}
            {codexModelStatus === 'ready' && selectedCodexModel && (
              <span className={styles.codexModelMeta}>
                {codexModel
                  ? `${selectedCodexModel.description || selectedCodexModel.displayName} · ${selectedCodexModel.id}`
                  : `Codex chooses the current recommended model (${selectedCodexModel.displayName}).`}
                {codexCatalogStale ? ' Last known catalog.' : ''}
              </span>
            )}
          </div>
        )}

        {/* Ops terminal checkbox (a phone may not open a plain shell) */}
        {!phoneApp && (
        <label className={styles.opsCheckboxRow}>
          <input
            type="checkbox"
            checked={enableOpsTerminal}
            onChange={(e) => setEnableOpsTerminal(e.target.checked)}
          />
          <div className={styles.opsCheckboxText}>
            <span className={styles.opsCheckboxLabel}>Commands Terminal</span>
            <span className={styles.opsCheckboxHint}>Extra shell tab for manual commands</span>
          </div>
        </label>
        )}
      </div>

      <div className={styles.newSessionFooter}>
        {/* The shared kit (AASC-11): Cancel was bare text beside a bordered Create. */}
        <Button onClick={() => closeModal()}>CANCEL</Button>
        <Button
          variant="primary"
          onClick={() => void handleSubmit()}
          disabled={submitting || !formValid}
          aria-busy={submitting || undefined}
        >
          {submitting ? 'CREATING...' : 'CREATE'}
        </Button>
      </div>
      {phoneApp && (browseOpen || confirmDir !== null) && (
        <Suspense fallback={null}>
          <PhoneFolderBrowser
            open={browseOpen}
            onClose={() => setBrowseOpen(false)}
            onPick={(dir, home) => {
              setWorkingDir(dir);
              setMacHome(home);
              setBrowseOpen(false);
            }}
            startPath={workingDir.trim() || null}
            known={usedFolders}
          />
          <NewFolderConfirm
            dir={confirmDir}
            cliLabel={CLI_LAUNCHERS.find((c) => c.command === command)?.label ?? command}
            onConfirm={() => {
              setConfirmDir(null);
              void handleSubmit(true);
            }}
            onCancel={() => setConfirmDir(null)}
          />
        </Suspense>
      )}
    </Modal>
  );
}

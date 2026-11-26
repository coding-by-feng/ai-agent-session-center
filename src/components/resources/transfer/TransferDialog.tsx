/**
 * TransferDialog — Copy or Move a project folder to a paired computer (Nov 27 2026,
 * docs/plans/project-transfer.md). Pick the computer and the folder there, choose what comes
 * along, and the server measures it (a plan; it hashes every file). One button sends it through
 * Electron main, which reports progress; a failure that can be picked up again offers Resume.
 *
 * While a transfer runs the dialog is locked (no ✕, Escape or backdrop): Cancel is the way out.
 * If the dialog unmounts anyway (the RESOURCES tab closed), the transfer keeps running in main and
 * its progress is simply no longer shown here.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type {
  TransferFailure,
  TransferMode,
  TransferOptions,
  TransferOutcome,
  TransferPlanInfo,
  TransferProgress,
  TransferStartResult,
} from '@/types/projectTransfer';
import type { RemoteComputer } from '@/types/electron';
import { projectTransferApi } from '@/lib/projectTransferApi';
import {
  destinationProblem,
  doneLine,
  formatBytes,
  progressFraction,
  progressLine,
  reachesSecurely,
  summaryLines,
} from '@/lib/projectTransferFormat';
import Button from '@/components/ui/Button';
import Field from '@/components/ui/Field';
import Modal from '@/components/ui/Modal';
import NativeSelect from '@/components/ui/NativeSelect';
import TextInput from '@/components/ui/TextInput';
import { useUiStore } from '@/stores/uiStore';
import styles from '@/styles/modules/TransferDialog.module.css';

export const TRANSFER_DIALOG_ID = 'project-transfer';

export interface TransferDialogProps {
  /** The project folder on this computer (absolute). */
  root: string;
  mode: TransferMode;
  open: boolean;
  onClose(): void;
  /** Where the folder already exists there: offer Project Sync instead. */
  onOpenProjectSync?(): void;
  /** A transfer finished (the row re-reads its Move marker). */
  onDone?(outcome: TransferOutcome): void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'failed'; error: string; failure?: TransferFailure }
  | { kind: 'done'; outcome: TransferOutcome };

interface PlanState {
  key: string;
  info?: TransferPlanInfo;
  error?: string;
}

const message = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;

const folderName = (root: string) => root.replace(/\/+$/, '').split('/').pop() || root;

const agents = (n: number) => (n === 1 ? '1 agent' : `${n} agents`);

export default function TransferDialog(props: TransferDialogProps) {
  if (!props.open) return null;
  return <TransferDialogBody {...props} />;
}

function TransferDialogBody({
  root,
  mode,
  onClose,
  onOpenProjectSync,
  onDone,
}: TransferDialogProps) {
  const remotesApi = window.electronAPI?.remotes;
  const [remotes, setRemotes] = useState<RemoteComputer[] | null>(null);
  const [remotesError, setRemotesError] = useState<string | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [destEdit, setDestEdit] = useState<string | null>(null);
  const [options, setOptions] = useState<TransferOptions>({
    memory: true,
    aasc: true,
    includeNodeModules: false,
  });
  const [attempt, setAttempt] = useState(0);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [transferId, setTransferId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The transfer this dialog follows: its id is chosen here and given to main, which uses it as-is.
  const followRef = useRef<{ running: boolean; id: string | null }>({ running: false, id: null });
  const planRef = useRef<TransferPlanInfo | null>(null);

  // The modal store holds one open dialog: open ours for as long as this body is mounted.
  useEffect(() => {
    const origin = document.activeElement as HTMLElement | null;
    useUiStore.getState().openModal(TRANSFER_DIALOG_ID);
    return () => {
      if (useUiStore.getState().activeModal === TRANSFER_DIALOG_ID)
        useUiStore.getState().closeModal();
      if (origin?.isConnected) origin.focus();
    };
  }, []);

  useEffect(() => {
    let live = true;
    if (!remotesApi) return;
    remotesApi.list().then(
      (list) => live && setRemotes(list),
      (e: unknown) => {
        if (!live) return;
        setRemotes([]);
        setRemotesError(message(e, 'Could not read the paired computers.'));
      },
    );
    return () => {
      live = false;
    };
  }, [remotesApi]);

  useEffect(() => {
    const off = remotesApi?.onProjectTransferProgress?.((p) => {
      const follow = followRef.current;
      if (follow.running && p.transferId === follow.id) setProgress(p);
    });
    return () => off?.();
  }, [remotesApi]);

  const active = (remotes ?? []).filter((c) => c.status === 'active');
  const reachable = active.filter(reachesSecurely);
  const remote = reachable.find((c) => c.id === chosenId) ?? reachable[0] ?? null;
  const canPlan = active.length > 0;
  const planKey = `${attempt}|${+options.memory}|${+options.aasc}|${+options.includeNodeModules}`;

  // Measure on open and again on each option change. A stale answer is not shown, and its plan
  // is deleted; so is the plan it replaces (unless a transfer is running from it).
  useEffect(() => {
    if (!canPlan) return;
    let live = true;
    projectTransferApi.plan(root, options).then(
      (info) => {
        if (!live) {
          void projectTransferApi.discardPlan(info.planId).catch(() => undefined);
          return;
        }
        planRef.current = info;
        setPlan({ key: planKey, info });
      },
      (e: unknown) => {
        if (live) setPlan({ key: planKey, error: message(e, 'Could not measure the folder.') });
      },
    );
    return () => {
      live = false;
      const prev = planRef.current;
      if (prev && !followRef.current.running) {
        planRef.current = null;
        void projectTransferApi.discardPlan(prev.planId).catch(() => undefined);
      }
    };
  }, [planKey, options, canPlan, root]);

  const current = plan?.key === planKey ? plan : null;
  const info = current?.info ?? null;
  const name = info?.name ?? folderName(root);
  const verb = mode === 'move' ? 'Move' : 'Copy';
  const title = `${verb} ${name} to another computer`;
  const destination = destEdit ?? (info ? `~/${info.homeRelative}` : '~/');
  const destError = destEdit !== null || info ? destinationProblem(destination) : null;
  const working = info?.summary.workingAgents ?? 0;
  const moveBlocked = mode === 'move' && working > 0;
  const running = phase.kind === 'running';
  const idle = phase.kind === 'idle';

  /** A new transfer gets a fresh id; Resume passes the earlier one, which the target may still hold. */
  async function start(resumeId?: string) {
    if (!info || !remote || !remotesApi?.projectTransferStart) return;
    const id = resumeId ?? crypto.randomUUID();
    followRef.current = { running: true, id };
    setTransferId(id);
    setProgress(null);
    setActionError(null);
    setPhase({ kind: 'running' });
    let result: TransferStartResult;
    try {
      result = await remotesApi.projectTransferStart({
        remoteId: remote.id,
        planId: info.planId,
        destination: destination.trim(),
        mode,
        transferId: id,
      });
    } catch (e) {
      result = { ok: false, error: message(e, 'The transfer stopped.') };
    }
    followRef.current = { running: false, id: null };
    if (result.ok) {
      setPhase({ kind: 'done', outcome: result.data });
      onDone?.(result.data);
    } else {
      setPhase({
        kind: 'failed',
        error: result.failure?.error ?? result.error,
        failure: result.failure,
      });
    }
  }

  async function cancel(discard: boolean) {
    const id = (phase.kind === 'failed' && phase.failure?.transferId) || transferId;
    if (!id || !remotesApi?.projectTransferCancel) {
      if (discard) setPhase({ kind: 'idle' });
      return;
    }
    setActionError(null);
    try {
      const r = await remotesApi.projectTransferCancel(id, discard);
      if (!r.ok) {
        setActionError(r.error);
        return;
      }
      if (discard) {
        setPhase({ kind: 'idle' });
        setProgress(null);
      }
    } catch (e) {
      setActionError(message(e, 'Could not stop the transfer.'));
    }
  }

  const setOption = (key: keyof TransferOptions) => (e: ChangeEvent<HTMLInputElement>) =>
    setOptions((o) => ({ ...o, [key]: e.target.checked }));

  function body() {
    if (!remotesApi) return <p className={styles.line}>Available in the desktop app.</p>;
    if (remotes === null) return <p className={styles.hint}>Loading…</p>;
    if (remotesError) return <div className={styles.error}>{remotesError}</div>;
    if (active.length === 0)
      return (
        <p className={styles.line}>No paired computers. Connect one from the devices menu (⇧⌘S).</p>
      );
    if (phase.kind === 'done') {
      const computer = remote?.name ?? 'the other computer';
      return (
        <>
          <p className={styles.line} role="status">
            {doneLine(phase.outcome, computer, mode, options)}
          </p>
          {phase.outcome.commit.warnings?.map((w) => (
            <div key={w} className={styles.warning} role="note">
              {w}
            </div>
          ))}
          <div className={styles.actions}>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </>
      );
    }
    const computer = remote?.name ?? 'the other computer';
    return (
      <>
        <div className={styles.form}>
          <Field label="To" className={styles.field}>
            <NativeSelect
              value={remote?.id ?? ''}
              disabled={!idle}
              onChange={(v) => setChosenId(v)}
              options={[
                ...(remote ? [] : [{ value: '', label: 'Choose a computer', disabled: true }]),
                ...active.map((c) => ({
                  value: c.id,
                  label: reachesSecurely(c) ? c.name : `${c.name} (needs Tailscale)`,
                  disabled: !reachesSecurely(c),
                })),
              ]}
            />
          </Field>
          <Field label="Folder" className={styles.field}>
            <TextInput
              value={destination}
              disabled={!idle}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={destError ? true : undefined}
              onChange={(e) => setDestEdit(e.target.value)}
            />
          </Field>
        </div>
        {destError && <div className={styles.fieldError}>{destError}</div>}
        {!remote && (
          <p className={styles.hint}>Each paired computer needs Tailscale to receive a project.</p>
        )}
        <fieldset className={styles.options} disabled={!idle}>
          <legend className={styles.legend}>Bring along</legend>
          <label className={styles.check}>
            <input type="checkbox" checked={options.memory} onChange={setOption('memory')} />
            <span>Agent memory</span>
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={options.aasc} onChange={setOption('aasc')} />
            <span>AASC history</span>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={options.includeNodeModules}
              onChange={setOption('includeNodeModules')}
            />
            <span>
              Include node_modules{' '}
              <span className={styles.hint}>Built for this computer’s processor</span>
            </span>
          </label>
        </fieldset>
        <div className={styles.summary} aria-live="polite">
          {!current ? (
            <p className={styles.hint}>Measuring…</p>
          ) : current.error ? (
            <div className={styles.error}>
              <span>{current.error}</span>
              <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </div>
          ) : (
            info && (
              <ul className={styles.groups}>
                {summaryLines(info.summary, options).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )
          )}
        </div>
        {idle && working > 0 && (
          <div className={styles.warning} role="note">
            {moveBlocked
              ? `${working === 1 ? 'An agent is' : `${working} agents are`} working in this folder. Move it once ${working === 1 ? 'it finishes' : 'they finish'}.`
              : `${agents(working)} ${working === 1 ? 'is' : 'are'} working in this folder. Their latest changes may not be included.`}
          </div>
        )}
        {running && (
          <div className={styles.progress}>
            <progress
              className={styles.bar}
              max={1}
              value={progressFraction(progress)}
              aria-label={`${verb} progress`}
            />
            <p className={styles.line} aria-live="polite">
              {progress ? progressLine(progress, computer) : `Connecting to ${computer}…`}
            </p>
          </div>
        )}
        {phase.kind === 'failed' && (
          <div className={styles.error} role="alert">
            {phase.error}
          </div>
        )}
        {actionError && <div className={styles.error}>{actionError}</div>}
        <div className={styles.actions}>{actions()}</div>
      </>
    );
  }

  function actions() {
    if (running) return <Button onClick={() => void cancel(false)}>Cancel</Button>;
    if (phase.kind === 'failed') {
      const f = phase.failure;
      return (
        <>
          {f?.code === 'destination_exists' && onOpenProjectSync && (
            <Button
              variant="primary"
              onClick={() => {
                onOpenProjectSync();
                onClose();
              }}
            >
              Use Project Sync
            </Button>
          )}
          {f?.resumable && (
            <Button variant="primary" onClick={() => void start(f.transferId)}>
              Resume
            </Button>
          )}
          {f ? (
            <Button onClick={() => void cancel(true)}>Discard</Button>
          ) : (
            <Button onClick={() => setPhase({ kind: 'idle' })}>Back</Button>
          )}
        </>
      );
    }
    const ready = !!info && !!remote && !destError && !moveBlocked;
    return (
      <Button variant="primary" disabled={!ready} onClick={() => void start()}>
        {info ? `${verb} ${formatBytes(info.summary.bytes)}` : verb}
      </Button>
    );
  }

  return (
    <Modal
      modalId={TRANSFER_DIALOG_ID}
      title={title}
      onClose={onClose}
      locked={running}
      panelClassName={styles.dialog}
    >
      {body()}
    </Modal>
  );
}

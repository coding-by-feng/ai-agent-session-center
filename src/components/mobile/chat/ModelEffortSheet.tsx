/**
 * ModelEffortSheet — switch the session's model and effort from the phone
 * (AASC-42), as the CLI's own `/model <name>` and `/effort <level>`.
 *
 * In the terminal a bare `/model` or `/effort` opens a picker the phone can't
 * drive (the Mac refuses them bare: 400 needs_argument), so the choices are
 * here and the composer sends the command with its choice, as Claude's mobile
 * app does. Claude: the session modals' model list and the effort levels.
 * Codex: its models from the Mac (`GET /api/codex/models`); Codex has no
 * /effort (its reasoning effort is part of its own /model menu), so a tap sends.
 *
 * Claude (Oct 2026, by request): taps only select, so a model — every row names its
 * version — and an effort are picked in one visit; Apply sends what changed, model
 * first (the composer waits for each to land before the next).
 */
import { useEffect, useState } from 'react';
import Button from '../kit/Button';
import type { Session } from '@/types';
import type { CodexModelOption, ListCodexModelsResponse } from '@/types/api';
import { EmptyState, ListRow, ListSection, Sheet } from '../kit';
import { SuccessIcon } from '../kit/kitIcons';
import { detectCli } from '@/lib/cliDetect';
import { formatModelLabel, modelLabelKey } from '@/lib/modelLabel';
import { resolveRuntimeDisplay } from '@/lib/sessionRuntime';
import { MODEL_STEP_OPTIONS, isModelAlias, modelStepText } from '@/lib/queueModel';
import { MODEL_ALIAS_VERSIONS } from '@/lib/remoteControlName';
import { EFFORT_STEP_LEVELS, effortLevelSavesDefault, effortStepText } from '@/lib/queueEffort';
import type { EffortLevel } from '@/lib/queueEffort';
import styles from '@/styles/modules/mobile/ComposerSheets.module.css';

export interface ModelEffortSheetProps {
  open: boolean;
  onClose: () => void;
  session: Session;
  /** Which list leads (the one the user asked for). */
  focus?: 'model' | 'effort';
  /** The commands to send, in order: `/model sonnet`, then `/effort high` (only what changed). */
  onApply: (commands: string[]) => void;
}

const DETENTS = ['medium', 'large'] as const;

/** "Newest · Opus 5.5": an alias with the version it means today. */
const aliasNote = (alias: string): string => {
  const version = MODEL_ALIAS_VERSIONS[alias];
  return version ? `Newest · ${formatModelLabel(version)}` : 'The newest version';
};

/** What a model choice is called on Apply: an alias by today's version. */
const modelName = (model: string): string => formatModelLabel(MODEL_ALIAS_VERSIONS[model] ?? model);

type CodexLoad = { models: CodexModelOption[] | null; failed: boolean };

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultracode: 'Ultracode',
};

function Check({ on }: { on: boolean }) {
  return on ? <span className={styles.check} aria-label="Current"><SuccessIcon /></span> : null;
}

export default function ModelEffortSheet({ open, onClose, session, focus = 'model', onApply }: ModelEffortSheetProps) {
  const codex = detectCli(session) === 'codex';
  const [codexLoad, setCodexLoad] = useState<CodexLoad>({ models: null, failed: false });

  useEffect(() => {
    if (!open || !codex) return undefined;
    const controller = new AbortController();
    fetch('/api/codex/models', { signal: controller.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<ListCodexModelsResponse>;
      })
      .then((data) => setCodexLoad({ models: data.models ?? [], failed: false }))
      .catch(() => { if (!controller.signal.aborted) setCodexLoad({ models: [], failed: true }); });
    return () => controller.abort();
  }, [open, codex]);

  const currentModel = session.runtime?.launchModel ?? session.runtime?.model ?? session.model ?? '';
  const currentEffort = session.runtime?.effortAt !== undefined ? session.runtime?.effort : session.effortLevel;

  // Claude: what's picked so far (null = keep the current one). Reset each time the sheet opens.
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [pickedEffort, setPickedEffort] = useState<EffortLevel | null>(null);
  // The fixed versions start open when the session runs one, so its tick is in view.
  const runsPinned = currentModel !== '' && !isModelAlias(currentModel);
  const [showPinned, setShowPinned] = useState(runsPinned);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setPickedModel(null); setPickedEffort(null); setShowPinned(runsPinned); }
  }

  const choose = (command: string) => {
    onClose();
    onApply([command]);
  };

  if (codex) {
    const models = codexLoad.models;
    return (
      <Sheet open={open} onClose={onClose} title="Codex model" detents={DETENTS} testId="model-sheet">
        {!models ? (
          <EmptyState live title="Loading Codex’s models…" />
        ) : codexLoad.failed || models.length === 0 ? (
          <EmptyState title="No models" message="Your Mac couldn’t list Codex’s models. Try again, or use the Terminal tab." />
        ) : (
          <ListSection header="Model" footer="Codex sets its reasoning effort in its own /model menu: use the Terminal tab for that.">
            {models.map((m) => (
              <ListRow
                key={m.id}
                title={m.displayName}
                subtitle={m.isDefault ? `Recommended${m.description ? ` · ${m.description}` : ''}` : m.description || undefined}
                trailing={<Check on={m.id === currentModel} />}
                onClick={() => choose(modelStepText(m.id))}
                tall={!!m.description || m.isDefault}
              />
            ))}
          </ListSection>
        )}
      </Sheet>
    );
  }

  const aliases = MODEL_STEP_OPTIONS.filter((m) => isModelAlias(m));
  const pinned = MODEL_STEP_OPTIONS.filter((m) => !isModelAlias(m));
  const running = resolveRuntimeDisplay(session);
  const now = running ? `Now ${[running.model, running.effort ? `effort ${running.effort}` : ''].filter(Boolean).join(' · ')}` : null;

  const model = pickedModel ?? currentModel;
  const effort = pickedEffort ?? currentEffort ?? '';
  const modelChanged = pickedModel !== null && pickedModel !== currentModel;
  const effortChanged = pickedEffort !== null && pickedEffort !== currentEffort;
  const isModel = (m: string) => (isModelAlias(m) ? model === m : model !== '' && !isModelAlias(model) && modelLabelKey(m) === modelLabelKey(model));

  const apply = () => {
    const commands = [
      ...(modelChanged ? [modelStepText(pickedModel!)] : []),
      ...(effortChanged ? [effortStepText(pickedEffort!)] : []),
    ];
    if (commands.length === 0) return;
    onClose();
    onApply(commands);
  };
  const applyLabel = modelChanged || effortChanged
    ? `Apply · ${[modelName(model), EFFORT_LABELS[effort] ?? effort].filter(Boolean).join(' · ')}`
    : 'Apply';

  const modelSection = (
    <ListSection key="models" header="Model">
      {aliases.map((m) => (
        <ListRow
          key={m}
          title={formatModelLabel(m)}
          subtitle={aliasNote(m)}
          trailing={<Check on={isModel(m)} />}
          onClick={() => setPickedModel(m)}
        />
      ))}
      <ListRow
        title="Fixed versions"
        subtitle="Pin one exact version"
        value={showPinned ? 'Hide' : 'Show'}
        onClick={() => setShowPinned((v) => !v)}
      />
    </ListSection>
  );
  const pinnedSection = showPinned ? (
    <ListSection key="pinned" label="Fixed versions">
      {pinned.map((m) => (
        <ListRow
          key={m}
          title={formatModelLabel(m)}
          trailing={<Check on={isModel(m)} />}
          onClick={() => setPickedModel(m)}
        />
      ))}
    </ListSection>
  ) : null;
  const effortSection = (
    <ListSection key="effort" header="Effort" footer="Higher effort thinks longer and uses more of your plan.">
      {EFFORT_STEP_LEVELS.map((level) => (
        <ListRow
          key={level}
          title={EFFORT_LABELS[level] ?? level}
          subtitle={effortLevelSavesDefault(level) ? 'Also your default for new sessions' : 'This session only'}
          trailing={<Check on={effort === level} />}
          onClick={() => setPickedEffort(level)}
        />
      ))}
    </ListSection>
  );
  const footer = (
    <div className={styles.applyBar}>
      <Button
        variant="primary"
        block
        onClick={apply}
        disabledReason={modelChanged || effortChanged ? undefined : 'Pick a model or an effort to change'}
      >
        {applyLabel}
      </Button>
    </div>
  );

  return (
    <Sheet open={open} onClose={onClose} title={focus === 'effort' ? 'Effort and model' : 'Model and effort'} detents={DETENTS} initialDetent="large" testId="model-sheet" footer={footer}>
      {now && <p className={styles.note}>{now}</p>}
      {focus === 'effort' ? <>{effortSection}{modelSection}{pinnedSection}</> : <>{modelSection}{pinnedSection}{effortSection}</>}
    </Sheet>
  );
}

/**
 * Composer — the session's message box on the phone (AASC-42).
 *
 *   ⧉ 2 queued ›                 Opus 5.5 · high · ◔ 38%     chips
 *   ┌────────────────────────────────────────────────┐
 *   │ Reply to Claude…                                │       grows to 6 lines
 *   │ ＋  /  @                            ■  [Send ↑] │
 *   └────────────────────────────────────────────────┘
 *
 * - The draft is kept per session on this phone (composerDraftStore).
 * - ＋: photo library, camera, saved prompt, command, file. "/" typed at the
 *   start of a word opens this CLI's commands and skills; "@" a file of the
 *   session's project. /model and /effort open their choices as a sheet.
 * - The main button follows lib/chat/composerAction: Send (idle, waiting),
 *   Queue while it works (hold: Send now, confirmed), "Deny and tell Claude"
 *   while a card waits (hold: queue instead). Stop beside it while it works.
 * - Sending is the Mac's confirmed send, polled until it lands (usePromptSender).
 * - While another device drives, the box is off and says who, with Take control.
 */
import { useCallback, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { Session } from '@/types';
import { ConfirmSheet, ListRow, ListSection, Sheet } from '../kit';
import { ChevronRightIcon, CloseIcon, InfoIcon } from '../kit/kitIcons';
import { useControlBaton } from '@/hooks/useControlBaton';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { useQueueStore, type QueueImageAttachment } from '@/stores/queueStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { getClientId } from '@/lib/deviceIdentity';
import { detectCli } from '@/lib/cliDetect';
import { entryToken, type CommandEntry } from '@/lib/commandIndex';
import { insertSuggestion } from '@/lib/phoneSuggestions';
import { readQueueImages } from '@/lib/queueImageAttach';
import { resolveContextDisplay, resolveRuntimeDisplay } from '@/lib/sessionRuntime';
import { formatModelLabel } from '@/lib/modelLabel';
import { parsePhonePath } from '@/lib/chat/phoneRoutes';
import { MAX_PROMPT_IMAGES } from '@/lib/chat/promptApi';
import { composerAction, macWindowOpen, pickerSheetFor, pickerSheetForText, runningTool } from '@/lib/chat/composerAction';
import type { WaitingCard } from '@/lib/chat/waitingCardModel';
import { showToast } from '@/components/ui/ToastContainer';
import DrivingBanner from './DrivingBanner';
import CommandSheet from './CommandSheet';
import FilePickerSheet from './FilePickerSheet';
import ModelEffortSheet from './ModelEffortSheet';
import SavedPromptSheet from './SavedPromptSheet';
import { usePromptSender, type OutgoingMessage, type SendPhase } from './usePromptSender';
import { useDriverName } from './useDriverName';
import { AtIcon, CameraIcon, CommandsIcon, ContextRing, FileIcon, PhotoIcon, PlusIcon, QueueIcon, SendIcon, SlashIcon, SnippetIcon, StopIcon } from './chatIcons';
import styles from '@/styles/modules/mobile/Composer.module.css';

export interface ComposerProps {
  session: Session;
  /** The waiting card on show, if any (it changes what Send means). */
  card: WaitingCard | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

type OpenSheet =
  | { type: 'plus' }
  | { type: 'command'; start: number | null }
  | { type: 'file'; start: number | null }
  | { type: 'model'; focus: 'model' | 'effort' }
  | { type: 'saved' };

type Confirm = { type: 'send-now' } | { type: 'queue-instead' } | { type: 'stop'; tool: string };

const MAX_LINES = 6;
const HOLD_MS = 500;
const PLUS_DETENTS = ['fit'] as const;

function statusLine(state: SendPhase, cliName: string, windowOpen: boolean): string | null {
  switch (state.phase) {
    case 'sending': return 'Sending…';
    case 'pending': return state.slow ? `Still waiting for ${cliName} to take it…` : `Sent to your Mac · waiting for ${cliName} to take it…`;
    case 'sent': return state.queued ? (windowOpen ? `Queued · sent when ${cliName} finishes` : 'Queued · sent when AASC is open on your Mac') : 'Sent';
    case 'failed': return state.message;
    case 'unsure': return state.message;
    default: return null;
  }
}

export default function Composer({ session, card, inputRef }: ComposerProps) {
  const sessionId = session.sessionId;
  const cli = detectCli(session);
  const cliName = cli === 'codex' ? 'Codex' : cli === 'claude' ? 'Claude' : 'the agent';
  const draft = useComposerDraftStore((s) => s.drafts[sessionId] ?? '');
  const setDraft = useComposerDraftStore((s) => s.setDraft);
  const appendToDraft = useComposerDraftStore((s) => s.appendToDraft);
  const [images, setImages] = useState<QueueImageAttachment[]>([]);
  const baton = useControlBaton(sessionId);
  const driver = useDriverName(baton.holder?.clientId, baton.holder?.label);
  const received = usePresenceStore((s) => s.received);
  const workspaceWriter = usePresenceStore((s) => s.workspaceWriter);
  const devices = usePresenceStore((s) => s.devices);
  const windowOpen = macWindowOpen({ received, workspaceWriter, devices }, getClientId());
  const queued = useQueueStore((s) => s.queues.get(sessionId)?.length ?? 0);
  const sender = usePromptSender(sessionId);
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const held = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });

  const text = draft.replace(/\s+$/, '');
  const decision = composerAction({
    status: session.status,
    cli,
    hasContent: text.trim() !== '',
    spectator: baton.mode === 'spectator',
    driverLabel: driver,
    card: card ? { kind: card.kind } : null,
    macWindowOpen: windowOpen,
  });
  const sending = sender.state.phase === 'sending';
  const fieldOff = !!decision.fieldDisabledReason;
  const runtime = resolveRuntimeDisplay(session);
  const context = resolveContextDisplay(session);
  const modelLabel = runtime ? [runtime.model, runtime.effort].filter(Boolean).join(' · ') : cli === 'codex' && session.model ? formatModelLabel(session.model) : null;

  // Grow with the text up to six lines, then scroll inside.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const style = window.getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || 22;
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_LINES + padding)}px`;
  }, [draft, inputRef]);

  const closeSheet = useCallback(() => setSheet(null), []);
  const cancelConfirm = useCallback(() => setConfirm(null), []);

  const focusAt = useCallback((caret: number) => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }, [inputRef]);

  const insertToken = useCallback((token: string, start: number | null) => {
    const el = inputRef.current;
    const current = useComposerDraftStore.getState().drafts[sessionId] ?? '';
    const caret = el?.selectionStart ?? current.length;
    const next = insertSuggestion(current, caret, token, start);
    setDraft(sessionId, next.text);
    focusAt(next.caret);
  }, [inputRef, sessionId, setDraft, focusAt]);

  /** Drop a typed "/" or "@" whose sheet was closed for another one. */
  const dropTrigger = useCallback((start: number | null) => {
    if (start === null) return;
    const current = useComposerDraftStore.getState().drafts[sessionId] ?? '';
    if (current[start] === '/' || current[start] === '@') setDraft(sessionId, current.slice(0, start) + current.slice(start + 1));
  }, [sessionId, setDraft]);

  // ---- Delivering ----

  const deliver = useCallback(async (message: OutgoingMessage, how: 'send' | 'send-now' | 'queue' | 'deny-and-tell') => {
    const restore = () => {
      if (useComposerDraftStore.getState().drafts[sessionId]) return;
      setDraft(sessionId, message.text);
      setImages([...(message.images ?? [])]);
    };
    if (how === 'queue') {
      sender.queue(message);
      return;
    }
    const result = how === 'deny-and-tell'
      ? await sender.denyAndTell(message, session.pendingRequest)
      : await sender.send(message, how === 'send-now' ? 'interrupt' : 'now');
    if (result.ok) return;
    restore();
    if ('error' in result && result.error?.code === 'needs_argument') {
      const picker = pickerSheetForText(message.text, cli);
      if (picker) setSheet({ type: 'model', focus: picker });
    }
  }, [sender, session.pendingRequest, sessionId, setDraft, cli]);

  const submit = useCallback((how: 'send' | 'send-now' | 'queue' | 'deny-and-tell' = decision.action) => {
    if (sending || fieldOff || text.trim() === '') return;
    if (how === decision.action && !decision.canSend) return;
    const picker = pickerSheetForText(text, cli);
    if (picker) {
      setSheet({ type: 'model', focus: picker });
      return;
    }
    const message: OutgoingMessage = { text, images };
    setDraft(sessionId, '');
    setImages([]);
    void deliver(message, how);
  }, [decision.action, decision.canSend, sending, fieldOff, text, cli, images, sessionId, setDraft, deliver]);

  // While another device drives, or the session has ended or is still starting,
  // the Mac would refuse a /model too: the chip is off and says why.
  const blocked = decision.fieldDisabledReason ?? decision.blockedReason;
  const chipReasonId = useId();
  const chooseCommands = useCallback((commands: string[]) => {
    if (blocked || commands.length === 0) return;
    // A dialog or a turn in progress would take the keys: queue them after it, in order.
    if (decision.action !== 'send') {
      for (const text of commands) sender.queue({ text });
      return;
    }
    if (commands.length === 1) {
      void deliver({ text: commands[0] }, 'send');
      return;
    }
    // `/model` then `/effort`: each waits until the one before has landed.
    void sender.sendInOrder(commands.map((text) => ({ text })));
  }, [blocked, deliver, decision.action, sender]);

  // ---- The box ----

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const caret = e.target.selectionStart ?? value.length;
    const typedOne = value.length === draft.length + 1;
    setDraft(sessionId, value);
    if (!typedOne || caret < 1) return;
    const ch = value[caret - 1];
    const wordStart = caret === 1 || /\s/.test(value[caret - 2]);
    if (!wordStart) return;
    if (ch === '/' && cli) setSheet({ type: 'command', start: caret - 1 });
    else if (ch === '@' && session.projectPath) setSheet({ type: 'file', start: caret - 1 });
  };

  // Return is a new line (a phone chat); Cmd/Ctrl+Return sends from a hardware keyboard.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onPhotos = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    void readQueueImages(files, images.length).then(({ images: read, message }) => {
      if (read.length > 0) setImages((prev) => [...prev, ...read].slice(0, MAX_PROMPT_IMAGES));
      if (images.length + read.length > MAX_PROMPT_IMAGES) showToast(`Up to ${MAX_PROMPT_IMAGES} photos a message.`, 'warning');
      else if (message) showToast(message, 'warning');
    });
  }, [images.length]);

  // ---- Hold the main button for its other way to send ----

  const clearHold = () => {
    if (held.current.timer) clearTimeout(held.current.timer);
    held.current.timer = null;
  };
  const onHoldStart = (e: PointerEvent<HTMLButtonElement>) => {
    if (!decision.holdAction || !decision.canSend || (e.pointerType === 'mouse' && e.button !== 0)) return;
    held.current.fired = false;
    clearHold();
    held.current.timer = setTimeout(() => {
      held.current.fired = true;
      navigator.vibrate?.(10);
      setConfirm(decision.holdAction === 'send-now' ? { type: 'send-now' } : { type: 'queue-instead' });
    }, HOLD_MS);
  };
  const onPrimaryClick = () => {
    clearHold();
    if (held.current.fired) {
      held.current.fired = false;
      return;
    }
    submit();
  };

  const stop = () => {
    const tool = runningTool(session);
    if (tool) setConfirm({ type: 'stop', tool });
    else void sender.stop(session.terminalId ?? null);
  };

  const openQueue = () => {
    const path = `/sessions/${sessionId}/info/queue`;
    const nav = usePhoneNavStore.getState();
    if (parsePhonePath(path)) nav.push(path);
    else nav.switchTab('queue');
  };

  // Stable handlers for the sheets (they re-render with every session update).
  const triggerStart = sheet && (sheet.type === 'command' || sheet.type === 'file') ? sheet.start : null;
  const closeToBox = useCallback(() => {
    closeSheet();
    focusAt(inputRef.current?.selectionStart ?? (useComposerDraftStore.getState().drafts[sessionId] ?? '').length);
  }, [closeSheet, focusAt, inputRef, sessionId]);
  const pickCommand = useCallback((entry: CommandEntry) => {
    const picker = pickerSheetFor(entry);
    if (picker) {
      dropTrigger(triggerStart);
      setSheet({ type: 'model', focus: picker });
      return;
    }
    closeSheet();
    insertToken(entryToken(entry), triggerStart);
  }, [dropTrigger, closeSheet, insertToken, triggerStart]);
  const pickFile = useCallback((path: string) => {
    closeSheet();
    insertToken(`@${path}`, triggerStart);
  }, [closeSheet, insertToken, triggerStart]);
  const pickSnippet = useCallback((snippet: string) => {
    appendToDraft(sessionId, snippet);
    focusAt((useComposerDraftStore.getState().drafts[sessionId] ?? '').length);
  }, [appendToDraft, sessionId, focusAt]);

  const line = statusLine(sender.state, cliName, windowOpen);
  const failed = sender.state.phase === 'failed';
  const dismissable = failed || sender.state.phase === 'unsure';
  const longLabel = decision.label.length > 8;

  return (
    <div className={styles.composer} data-testid="composer">
      {/* While a card waits it says who drives, and its answer takes control: no second banner. */}
      {!card && (baton.mode === 'spectator' || baton.mode === 'asked') && <DrivingBanner sessionId={sessionId} />}
      {line && (
        <p className={styles.status} data-tone={failed ? 'error' : undefined} role={failed ? 'alert' : 'status'}>
          <span>{line}</span>
          {dismissable && (
            <button type="button" className={styles.dismiss} onClick={sender.dismiss} aria-label="Dismiss">
              <CloseIcon />
            </button>
          )}
        </p>
      )}
      {decision.queueNote && !line && (
        <p className={styles.note}><InfoIcon /> {decision.queueNote}</p>
      )}
      {(queued > 0 || modelLabel) && (
        <div className={styles.chips}>
          {queued > 0 && (
            <button type="button" className={styles.chip} onClick={openQueue} aria-label={`${queued} queued: open this session’s queue`}>
              <QueueIcon /> <span>{queued} queued</span> <ChevronRightIcon />
            </button>
          )}
          {modelLabel && (
            <button
              type="button"
              className={`${styles.chip} ${styles.modelChip}`}
              onClick={() => { if (!blocked) setSheet({ type: 'model', focus: 'model' }); }}
              aria-label={`Model ${modelLabel}${context ? `, context ${context.pct}% used` : ''}: change`}
              aria-disabled={blocked ? true : undefined}
              aria-describedby={blocked ? chipReasonId : undefined}
            >
              <span className={styles.modelText}>{modelLabel}</span>
              {context && (
                <span className={styles.context} data-level={context.level}>
                  <ContextRing pct={context.pct} /> {Math.round(context.pct)}%
                </span>
              )}
              {blocked && <span id={chipReasonId} className={styles.srOnly}>{blocked}</span>}
            </button>
          )}
        </div>
      )}
      {images.length > 0 && (
        <ul className={styles.thumbs} aria-label="Photos to send">
          {images.map((img, i) => (
            <li key={`${img.name}-${i}`} className={styles.thumb}>
              <img src={img.dataUrl} alt={img.name} />
              <button type="button" className={styles.thumbRemove} onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove ${img.name}`}>
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.field} data-off={fieldOff ? '' : undefined}>
        <textarea
          ref={inputRef}
          className={styles.input}
          value={draft}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={decision.fieldDisabledReason ?? decision.placeholder}
          aria-label={`Message to ${cliName}`}
          disabled={fieldOff}
          rows={1}
          enterKeyHint="enter"
          autoCapitalize="sentences"
          autoComplete="off"
          spellCheck
          data-testid="composer-input"
        />
        <div className={styles.toolbar} data-long={longLabel ? '' : undefined}>
          <button type="button" className={styles.tool} onClick={() => setSheet({ type: 'plus' })} aria-label="Add a photo, saved prompt, command or file" aria-haspopup="dialog" disabled={fieldOff}>
            <PlusIcon />
          </button>
          {cli && (
            <button type="button" className={`${styles.tool} ${styles.optional}`} onClick={() => setSheet({ type: 'command', start: null })} aria-label="Commands and skills" aria-haspopup="dialog" disabled={fieldOff}>
              <SlashIcon />
            </button>
          )}
          {session.projectPath && (
            <button type="button" className={`${styles.tool} ${styles.optional}`} onClick={() => setSheet({ type: 'file', start: null })} aria-label="Mention a file" aria-haspopup="dialog" disabled={fieldOff}>
              <AtIcon />
            </button>
          )}
          <span className={styles.spacer} />
          {decision.showStop && (
            <button type="button" className={`${styles.tool} ${styles.stop}`} onClick={stop} aria-label={`Stop ${cliName}`} data-testid="composer-stop">
              <StopIcon />
            </button>
          )}
          <button
            type="button"
            className={styles.primary}
            data-action={decision.action}
            aria-disabled={decision.canSend && !sending ? undefined : true}
            aria-busy={sending || undefined}
            aria-describedby={decision.holdAction ? `${sessionId}-hold-hint` : undefined}
            onPointerDown={onHoldStart}
            onPointerUp={clearHold}
            onPointerLeave={clearHold}
            onPointerCancel={clearHold}
            onContextMenu={(e) => {
              e.preventDefault();
              if (decision.holdAction && decision.canSend) setConfirm(decision.holdAction === 'send-now' ? { type: 'send-now' } : { type: 'queue-instead' });
            }}
            onClick={onPrimaryClick}
            data-testid="composer-send"
          >
            <span>{decision.label}</span>
            <SendIcon size={18} />
          </button>
          {decision.holdAction && (
            <span id={`${sessionId}-hold-hint`} className={styles.srOnly}>
              {decision.holdAction === 'send-now' ? 'Hold to send now instead' : 'Hold to add it to the queue instead'}
            </span>
          )}
        </div>
      </div>
      {decision.blockedReason && <p className={styles.note}><InfoIcon /> {decision.blockedReason}</p>}

      <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={onPhotos} data-testid="composer-photo-input" />
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={onPhotos} data-testid="composer-camera-input" />

      <Sheet open={sheet?.type === 'plus'} onClose={closeSheet} title="Add to your message" detents={PLUS_DETENTS} testId="plus-sheet">
        <ListSection label="Add to your message">
          <ListRow leading={<PhotoIcon />} title="Photo library" subtitle={`Up to ${MAX_PROMPT_IMAGES} photos`} onClick={() => { closeSheet(); photoInput.current?.click(); }} disabledReason={images.length >= MAX_PROMPT_IMAGES ? `${MAX_PROMPT_IMAGES} photos already` : undefined} />
          <ListRow leading={<CameraIcon />} title="Camera" onClick={() => { closeSheet(); cameraInput.current?.click(); }} disabledReason={images.length >= MAX_PROMPT_IMAGES ? `${MAX_PROMPT_IMAGES} photos already` : undefined} />
          <ListRow leading={<SnippetIcon />} title="Saved prompt" onClick={() => setSheet({ type: 'saved' })} chevron />
          {cli && <ListRow leading={<CommandsIcon />} title="Command or skill" onClick={() => setSheet({ type: 'command', start: null })} chevron />}
          {session.projectPath && <ListRow leading={<FileIcon />} title="File from the project" onClick={() => setSheet({ type: 'file', start: null })} chevron />}
        </ListSection>
      </Sheet>
      {cli && (
        <CommandSheet
          open={sheet?.type === 'command'}
          onClose={closeToBox}
          cli={cli}
          projectPath={session.projectPath}
          onPick={pickCommand}
        />
      )}
      <FilePickerSheet
        open={sheet?.type === 'file'}
        onClose={closeToBox}
        projectPath={session.projectPath}
        onPick={pickFile}
      />
      <ModelEffortSheet
        open={sheet?.type === 'model'}
        onClose={closeSheet}
        session={session}
        focus={sheet?.type === 'model' ? sheet.focus : 'model'}
        onApply={chooseCommands}
      />
      <SavedPromptSheet
        open={sheet?.type === 'saved'}
        onClose={closeSheet}
        onPick={pickSnippet}
      />

      <ConfirmSheet
        open={confirm?.type === 'send-now'}
        title="Send now?"
        message={`${cliName} stops what it is doing, then gets your message.`}
        confirmLabel="Stop and send"
        danger
        onConfirm={() => { setConfirm(null); submit('send-now'); }}
        onCancel={cancelConfirm}
      />
      <ConfirmSheet
        open={confirm?.type === 'queue-instead'}
        title="Add to the queue instead?"
        message={`The waiting request stays open. Your message is sent after it is answered and ${cliName} finishes.`}
        confirmLabel="Add to queue"
        onConfirm={() => { setConfirm(null); submit('queue'); }}
        onCancel={cancelConfirm}
      />
      <ConfirmSheet
        open={confirm?.type === 'stop'}
        title={`Stop ${cliName}?`}
        message={confirm?.type === 'stop' ? `It is running ${confirm.tool}. Stopping interrupts it.` : ''}
        confirmLabel="Stop"
        danger
        onConfirm={() => { setConfirm(null); void sender.stop(session.terminalId ?? null); }}
        onCancel={cancelConfirm}
      />
    </div>
  );
}

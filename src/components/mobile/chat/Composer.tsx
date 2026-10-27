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
 * - ＋: photo library, camera, saved prompt, command, file. A "/" word under
 *   the caret (or "$" on Codex) lists the matching commands and skills above the
 *   box (ComposerSuggestions, Oct 21 2026; the / button opens them all as a
 *   sheet); "@" typed at a word start opens a file of the session's project.
 *   /model and /effort open their choices as a sheet.
 * - The main button follows lib/chat/composerAction: Send (idle, waiting),
 *   Queue while it works (hold: Send now, confirmed), "Deny and tell Claude"
 *   while a card waits (hold: queue instead). Stop is the status strip's, above it.
 * - P sends the quick reply ("proceed", or this phone's own; lib/chat/quickReply)
 *   the way the main button would, leaving the draft alone; off while a card waits
 *   (Send would deny it). Holding P edits the text (QuickReplySheet).
 * - Sending is the Mac's confirmed send, polled until it lands (usePromptSender).
 * - While another device drives, the box is off and says who, with Take control.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { Session } from '@/types';
import { ConfirmSheet, ListRow, ListSection, Sheet } from '../kit';
import { ChevronRightIcon, CloseIcon, InfoIcon } from '../kit/kitIcons';
import { useControlBaton } from '@/hooks/useControlBaton';
import { useComposerDraftStore, type ComposerSheetRequest } from '@/stores/composerDraftStore';
import { DEFAULT_AUTOMATION, useQueueStore, type QueueImageAttachment, type QueueItem } from '@/stores/queueStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { getClientId } from '@/lib/deviceIdentity';
import { detectCli } from '@/lib/cliDetect';
import { entryToken, type CommandEntry } from '@/lib/commandIndex';
import { insertSuggestion } from '@/lib/phoneSuggestions';
import { readQueueImages } from '@/lib/queueImageAttach';
import { resolveRuntimeDisplay } from '@/lib/sessionRuntime';
import { describeUsage } from '@/lib/chat/usageModel';
import { useClock } from '@/lib/chat/clock';
import { formatModelLabel } from '@/lib/modelLabel';
import { parsePhonePath } from '@/lib/chat/phoneRoutes';
import { MAX_PROMPT_IMAGES } from '@/lib/chat/promptApi';
import { composerAction, macWindowOpen, pickerSheetFor, pickerSheetForText } from '@/lib/chat/composerAction';
import { queueWaiting } from '@/lib/chat/queueWaiting';
import type { WaitingCard } from '@/lib/chat/waitingCardModel';
import { showToast } from '@/components/ui/ToastContainer';
import DrivingBanner from './DrivingBanner';
import CommandSheet from './CommandSheet';
import FilePickerSheet from './FilePickerSheet';
import ModelEffortSheet from './ModelEffortSheet';
import UsageSheet from './UsageSheet';
import SavedPromptSheet from './SavedPromptSheet';
import QuickReplySheet from './QuickReplySheet';
import { useQuickReply } from '@/lib/chat/quickReply';
import { owesProceed } from '@/lib/sessionStatusStyle';
import ComposerSuggestions from './ComposerSuggestions';
import { usePromptSender, type OutgoingMessage, type SendPhase } from './usePromptSender';
import { useDriverName } from './useDriverName';
import { AtIcon, CameraIcon, CommandsIcon, ContextRing, FileIcon, PhotoIcon, PlusIcon, QueueIcon, QuickReplyIcon, SendIcon, SlashIcon, SnippetIcon } from './chatIcons';
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
  | { type: 'saved' }
  | { type: 'usage' };

type Confirm = { type: 'send-now' } | { type: 'send-ahead' } | { type: 'queue-instead' };

const HOLD_CONFIRM = { 'send-now': { type: 'send-now' }, 'send-ahead': { type: 'send-ahead' }, queue: { type: 'queue-instead' } } as const;
const HOLD_HINT = { 'send-now': 'Hold to send now instead', 'send-ahead': 'Hold to send now, ahead of the queue', queue: 'Hold to add it to the queue instead' } as const;

/** A stable empty queue, so the selector keeps its reference (zustand bails out on equality). */
const NO_ITEMS: readonly QueueItem[] = [];
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
  const queueItems = useQueueStore((s) => s.queues.get(sessionId) ?? NO_ITEMS);
  const queued = queueItems.length;
  const automation = useQueueStore((s) => s.automation.get(sessionId) ?? DEFAULT_AUTOMATION);
  const waiting = queueWaiting(queueItems, automation);
  const sender = usePromptSender(sessionId);
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  // A sheet Info asked for (Model ›): one that arrived before this composer mounted, then any later one.
  useEffect(() => {
    const take = (request: ComposerSheetRequest | null) => {
      if (request?.sessionId !== sessionId) return;
      useComposerDraftStore.getState().clearSheetRequest();
      setSheet({ type: 'model', focus: 'model' });
    };
    const first = setTimeout(() => take(useComposerDraftStore.getState().sheetRequest), 0);
    const unsubscribe = useComposerDraftStore.subscribe((s, prev) => {
      if (s.sheetRequest !== prev.sheetRequest) take(s.sheetRequest);
    });
    return () => {
      clearTimeout(first);
      unsubscribe();
    };
  }, [sessionId]);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const held = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  // The box as state too, for ComposerSuggestions (set once, on mount: never on a keystroke).
  const [boxEl, setBoxEl] = useState<HTMLTextAreaElement | null>(null);
  const boxRef = useCallback((el: HTMLTextAreaElement | null) => {
    inputRef.current = el;
    setBoxEl(el);
  }, [inputRef]);

  const text = draft.replace(/\s+$/, '');
  const actionInput = {
    status: session.status,
    cli,
    spectator: baton.mode === 'spectator',
    driverLabel: driver,
    card: card ? { kind: card.kind } : null,
    macWindowOpen: windowOpen,
    queueWaiting: waiting,
  };
  const decision = composerAction({ ...actionInput, hasContent: text.trim() !== '' });
  const sending = sender.state.phase === 'sending';
  // The quick reply always has text: it goes the way the main button would send it, but never as a
  // card's answer ("Deny and tell Claude" would deny the tool call with a "proceed").
  const quickReply = useQuickReply();
  const quickDecision = composerAction({ ...actionInput, hasContent: true });
  const quickBlocked = quickDecision.action === 'deny-and-tell'
    ? 'Answer the card first'
    : sending ? 'Still sending the last message' : quickDecision.fieldDisabledReason ?? (quickDecision.canSend ? null : quickDecision.blockedReason ?? 'Not now');
  // The last answer asks "Reply proceed…" (Oct 23 2026): P lights up, the reply being one tap.
  const quickPending = owesProceed(session) && !quickBlocked;
  const [quickOpen, setQuickOpen] = useState(false);
  const quickHeld = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  const fieldOff = !!decision.fieldDisabledReason;
  // Claude's suggested next prompt (server/promptSuggestionCapture.ts), offered only in an empty box
  // this phone may type into: the placeholder shows it, the chip fills it in to edit or send.
  const suggestion = !fieldOff && draft === '' ? session.promptSuggestion?.text ?? null : null;
  const runtime = resolveRuntimeDisplay(session);
  // Context window + plan limits on their own chip (Oct 20 2026); the clock ticks by the minute.
  const clock = useClock();
  const usage = describeUsage(session, clock);
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
    // A typed "/" lists in place (ComposerSuggestions); only "@" opens its sheet.
    if (ch === '@' && session.projectPath) setSheet({ type: 'file', start: caret - 1 });
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
    // The photos already held count toward the size cap too (~6 MB together: a queued message syncs in the queue).
    const heldChars = images.reduce((n, i) => n + i.dataUrl.length, 0);
    void readQueueImages(files, images.length, undefined, heldChars).then(({ images: read, message }) => {
      if (read.length > 0) setImages((prev) => [...prev, ...read].slice(0, MAX_PROMPT_IMAGES));
      if (images.length + read.length > MAX_PROMPT_IMAGES) showToast(`Up to ${MAX_PROMPT_IMAGES} photos a message.`, 'warning');
      else if (message) showToast(message, 'warning');
    });
  }, [images]);

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
      setConfirm(HOLD_CONFIRM[decision.holdAction!]);
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

  // ---- The quick reply: a tap sends it, a hold edits it ----

  const clearQuickHold = () => {
    if (quickHeld.current.timer) clearTimeout(quickHeld.current.timer);
    quickHeld.current.timer = null;
  };
  const onQuickHoldStart = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    quickHeld.current.fired = false;
    clearQuickHold();
    quickHeld.current.timer = setTimeout(() => {
      quickHeld.current.fired = true;
      navigator.vibrate?.(10);
      setQuickOpen(true);
    }, HOLD_MS);
  };
  const onQuickClick = () => {
    clearQuickHold();
    if (quickHeld.current.fired) {
      quickHeld.current.fired = false;
      return;
    }
    if (quickBlocked) return;
    void deliver({ text: quickReply }, quickDecision.action);
  };
  const quickVerb = quickDecision.action === 'queue' ? 'Queue' : 'Send';
  const quickShown = quickReply.length > 60 ? `${quickReply.slice(0, 59)}…` : quickReply;

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
  const setBoxText = useCallback((next: string) => setDraft(sessionId, next), [sessionId, setDraft]);
  const useSuggestion = useCallback(() => {
    if (!suggestion) return;
    setDraft(sessionId, suggestion);
    inputRef.current?.focus();
  }, [suggestion, sessionId, setDraft, inputRef]);
  // The picker sends the command itself: the typed fragment is already gone from `next`.
  const openPicker = useCallback((focus: 'model' | 'effort', next: string) => {
    setDraft(sessionId, next);
    setSheet({ type: 'model', focus });
  }, [sessionId, setDraft]);
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
      {(queued > 0 || modelLabel || usage.chip) && (
        <div className={styles.chips}>
          {queued > 0 && (
            // The count alone (Oct 20 2026: three chips share the row); its name says the rest.
            <button type="button" className={styles.chip} onClick={openQueue} aria-label={`${queued} queued: open this session’s queue`}>
              <QueueIcon /> <span>{queued}</span> <ChevronRightIcon />
            </button>
          )}
          {modelLabel && (
            <button
              type="button"
              className={`${styles.chip} ${styles.modelChip}`}
              onClick={() => { if (!blocked) setSheet({ type: 'model', focus: 'model' }); }}
              aria-label={`Model ${modelLabel}: change`}
              aria-disabled={blocked ? true : undefined}
              aria-describedby={blocked ? chipReasonId : undefined}
            >
              <span className={styles.modelText}>{modelLabel}</span>
              {blocked && <span id={chipReasonId} className={styles.srOnly}>{blocked}</span>}
            </button>
          )}
          {usage.chip && (
            <button
              type="button"
              className={`${styles.chip} ${styles.usageChip}`}
              onClick={() => setSheet({ type: 'usage' })}
              aria-label={`${usage.ariaLabel} Show details.`}
              aria-haspopup="dialog"
            >
              {usage.chip.context && (
                <span className={styles.context} data-level={usage.chip.context.level}>
                  <ContextRing pct={usage.chip.context.pct} /> {usage.chip.context.pctText}
                </span>
              )}
              {usage.chip.context && usage.chip.planText && <span aria-hidden="true">·</span>}
              {usage.chip.planText && (
                <span className={styles.planPart}>
                  {usage.chip.planText}{usage.chip.planHigh && <span aria-hidden="true"> ▲</span>}
                </span>
              )}
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
      {cli && (
        <ComposerSuggestions
          cli={cli}
          projectPath={session.projectPath ?? null}
          text={draft}
          textarea={boxEl}
          disabled={fieldOff}
          onChange={setBoxText}
          onPicker={openPicker}
        />
      )}
      {suggestion && (
        <button type="button" className={styles.suggest} onClick={useSuggestion} aria-label={`Use ${cliName}’s suggestion: ${suggestion}`}>
          <span aria-hidden="true">↳</span> Use suggestion
        </button>
      )}
      <div className={styles.field} data-off={fieldOff ? '' : undefined}>
        <textarea
          ref={boxRef}
          className={styles.input}
          value={draft}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={decision.fieldDisabledReason ?? suggestion ?? decision.placeholder}
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
          <button
            type="button"
            className={`${styles.tool} ${styles.optional}`}
            aria-label={`${quickVerb} “${quickShown}”`}
            aria-describedby={`${sessionId}-quick-hint`}
            aria-disabled={quickBlocked ? true : undefined}
            onPointerDown={onQuickHoldStart}
            onPointerUp={clearQuickHold}
            onPointerLeave={clearQuickHold}
            onPointerCancel={clearQuickHold}
            onContextMenu={(e) => {
              e.preventDefault();
              clearQuickHold();
              setQuickOpen(true);
            }}
            onClick={onQuickClick}
            data-pending={quickPending ? 'true' : undefined}
            data-testid="composer-quick-reply"
          >
            <QuickReplyIcon />
          </button>
          <span id={`${sessionId}-quick-hint`} className={styles.srOnly}>
            {quickBlocked ? `${quickBlocked}. ` : ''}{quickPending ? 'The last answer asks you to proceed. ' : ''}Hold to change what it sends.
          </span>
          <span className={styles.spacer} />
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
              if (decision.holdAction && decision.canSend) setConfirm(HOLD_CONFIRM[decision.holdAction]);
            }}
            onClick={onPrimaryClick}
            data-testid="composer-send"
          >
            <span>{decision.label}</span>
            <SendIcon size={18} />
          </button>
          {decision.holdAction && (
            <span id={`${sessionId}-hold-hint`} className={styles.srOnly}>
              {HOLD_HINT[decision.holdAction]}
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
      <UsageSheet open={sheet?.type === 'usage'} onClose={closeSheet} session={session} />
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
      <QuickReplySheet open={quickOpen} onClose={() => setQuickOpen(false)} current={quickReply} />

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
        open={confirm?.type === 'send-ahead'}
        title="Send it now?"
        message={`It goes to ${cliName} ahead of the ${waiting === 1 ? 'prompt' : `${waiting} prompts`} waiting in the queue.`}
        confirmLabel="Send now"
        onConfirm={() => { setConfirm(null); submit('send'); }}
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
    </div>
  );
}

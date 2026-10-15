/**
 * composerAction.ts — what the phone composer's main button does (AASC-42). Pure.
 *
 *   waiting / idle      Send        sends now (POST /prompt, mode now)
 *   working / prompting Queue       adds an active item to the session's queue,
 *                                   which the Mac's window sends when the turn
 *                                   ends; a hold offers Send now (interrupt, confirmed);
 *                                   Stop is offered beside it
 *   a card waits        Deny and tell Claude (a question: Send answer): the
 *                                   request is declined, then the text goes as a
 *                                   prompt; a hold offers the queue instead
 *   another device      the box is off, saying who drives
 *   connecting / ended  nothing to send to, and why
 */
import type { DevicePresence, SessionEvent } from '@/types';
import type { CommandEntry } from '@/lib/commandIndex';

export type ComposerPrimary = 'send' | 'queue' | 'deny-and-tell';

export interface ComposerInput {
  status: string;
  cli: 'claude' | 'codex' | null;
  /** Text or photos in the box. */
  hasContent: boolean;
  /** Another device drives the session: this phone's keystrokes are refused. */
  spectator: boolean;
  driverLabel?: string;
  /** The waiting card on show (waitingCardModel), if any. */
  card: { kind: 'permission' | 'question' | 'plan' | 'guess' } | null;
  /** Some AASC window is up to send the queue (macWindowOpen). */
  macWindowOpen: boolean;
}

export interface ComposerDecision {
  action: ComposerPrimary;
  label: string;
  /** The button may be pressed now. */
  canSend: boolean;
  /** Why it can't, even with something typed. */
  blockedReason?: string;
  /** Why the box itself is off. */
  fieldDisabledReason?: string;
  placeholder: string;
  showStop: boolean;
  /** What holding the button offers. */
  holdAction: 'send-now' | 'queue' | null;
  /** Said under the box when a queued prompt can't be sent yet. */
  queueNote?: string;
}

export const NO_MAC_WINDOW_NOTE = 'Sent when AASC is open on your Mac';

const BUSY = new Set(['working', 'prompting']);

export function composerAction(input: ComposerInput): ComposerDecision {
  const name = input.cli === 'codex' ? 'Codex' : input.cli === 'claude' ? 'Claude' : null;
  const reply = name ? `Reply to ${name}…` : 'Message the agent…';

  if (input.status === 'ended') {
    return { action: 'send', label: 'Send', canSend: false, fieldDisabledReason: 'This session has ended', placeholder: reply, showStop: false, holdAction: null };
  }
  if (input.spectator) {
    return {
      action: 'send',
      label: 'Send',
      canSend: false,
      fieldDisabledReason: `${input.driverLabel ?? 'Another device'} is driving`,
      placeholder: reply,
      showStop: false,
      holdAction: null,
    };
  }
  if (input.card) {
    const question = input.card.kind === 'question';
    return {
      action: 'deny-and-tell',
      label: question ? 'Send answer' : `Deny and tell ${name ?? 'the agent'}`,
      canSend: input.hasContent,
      placeholder: question ? 'Answer in your own words…' : `Tell ${name ?? 'the agent'} what to do instead…`,
      showStop: false,
      holdAction: 'queue',
    };
  }
  if (BUSY.has(input.status)) {
    return {
      action: 'queue',
      label: 'Queue',
      canSend: input.hasContent,
      placeholder: name ? `Queue a message for ${name}…` : 'Queue a message…',
      showStop: true,
      holdAction: 'send-now',
      ...(input.macWindowOpen ? {} : { queueNote: NO_MAC_WINDOW_NOTE }),
    };
  }
  if (input.status === 'connecting') {
    return { action: 'send', label: 'Send', canSend: false, blockedReason: 'The agent is still starting', placeholder: reply, showStop: false, holdAction: null };
  }
  return { action: 'send', label: 'Send', canSend: input.hasContent, placeholder: reply, showStop: false, holdAction: null };
}

/**
 * Is an AASC window up to send queued prompts (feature 72: the Mac's window
 * fires the queue)? Yes while another device writes the workspace: a local
 * window wins that role whenever one is connected (presenceManager). When this
 * phone is the only writer left, nobody will send them. Before presence has
 * arrived, assume yes: a false alarm on every load would teach people to ignore it.
 */
export function macWindowOpen(
  presence: { received: boolean; workspaceWriter: string | null; devices: readonly DevicePresence[] },
  myClientId: string,
): boolean {
  if (!presence.received) return true;
  return presence.workspaceWriter !== null && presence.workspaceWriter !== myClientId;
}

/** The tool a working session is in the middle of (its last event a PreToolUse), else null: Stop confirms then. */
export function runningTool(session: { status: string; events?: readonly SessionEvent[] }): string | null {
  if (session.status !== 'working') return null;
  const last = session.events?.[session.events.length - 1];
  if (!last || last.type !== 'PreToolUse') return null;
  return last.detail.split(':')[0].trim() || 'a tool';
}

/**
 * A command that opens a picker in the terminal, which the composer offers as a
 * sheet instead (`/model` → the model list → `/model sonnet`); the Mac refuses
 * them bare (400 needs_argument). Codex has no /effort.
 */
export function pickerSheetFor(entry: Pick<CommandEntry, 'name' | 'kind' | 'source' | 'cli'>): 'model' | 'effort' | null {
  if (entry.kind !== 'command' || entry.source !== 'builtin') return null;
  if (entry.name === 'model') return 'model';
  if (entry.name === 'effort' && entry.cli === 'claude') return 'effort';
  return null;
}

/** The picker a typed `/model` or `/effort` (with nothing after it) opens, else null. */
export function pickerSheetForText(text: string, cli: 'claude' | 'codex' | null): 'model' | 'effort' | null {
  const match = /^\s*\/(model|effort)\s*$/.exec(text);
  if (!match) return null;
  if (match[1] === 'effort' && cli === 'codex') return null;
  return match[1] as 'model' | 'effort';
}

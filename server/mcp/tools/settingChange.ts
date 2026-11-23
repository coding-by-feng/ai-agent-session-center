// tools/settingChange.ts — what `session_set_model` / `session_set_effort` (a worker, sessionCard.ts) and
// `central_set_runtime` (the calling central itself, centralRuntime.ts) share: the value checks, the check the change
// box re-asks before typing (runtimeChange.ts), and the answer, which says plainly whether the change is scheduled,
// typed or confirmed, so a central never reports a change the CLI has not made.

import type { Session } from '../../../src/types/session.js';
import { resolveCentralSession } from '../centrals.js';
import { isEscHeld } from '../escHold.js';
import { isEffortFor } from '../openWorker.js';
import type { ToolContext, ToolResult } from '../registry.js';
import { commandLine, type ChangeCheck, type RuntimeChangeBox, type SettingChange, type SettingKind } from '../runtimeChange.js';
import { toSessionCard } from '../scope.js';
import { ToolError, type CliKind } from '../types.js';
import { refOf } from './define.js';

/** A model name as the CLI takes it after `/model` (openWorker.ts's spec takes the same). */
export const MODEL = /^[a-zA-Z0-9._-]{1,100}$/;

export const MODEL_WORDS = 'A model name is letters, digits, dots, dashes and underscores only.';
export const MODEL_HINT = 'Pass the model as the CLI names it (sonnet, opus).';
export const EFFORT_WORDS = 'That is not an effort the session’s CLI takes.';
export const EFFORT_HINT = 'Claude: low, medium, high, xhigh, max, ultracode. Codex: minimal, low, medium, high, xhigh.';

/** How long a call waits for a free worker's change to be confirmed before it answers "scheduled". */
export const WORKER_WAIT_MS = 20_000;

/** The CLI a card runs; INVALID when AASC does not know it (it could not tell what that CLI takes). */
export function cliOf(ctx: ToolContext, s: Session): CliKind {
  const cli = toSessionCard(s, ctx.rooms()).cli;
  if (cli === null) {
    throw new ToolError(
      'INVALID',
      'AASC does not know which agent that session runs.',
      'Model and effort are set in Claude Code and Codex sessions only.',
    );
  }
  return cli;
}

/** INVALID unless the value is one `kind` takes for this CLI. */
export function assertValue(kind: SettingKind, value: string, cli: CliKind): void {
  if (kind === 'model' && !MODEL.test(value)) throw new ToolError('INVALID', MODEL_WORDS, MODEL_HINT);
  if (kind === 'effort' && !isEffortFor(cli, value)) throw new ToolError('INVALID', EFFORT_WORDS, EFFORT_HINT);
}

/** The change box, or UNAVAILABLE on a server without the P2 runtime. */
export function boxOf(ctx: ToolContext): RuntimeChangeBox {
  if (!ctx.settings) {
    throw new ToolError('UNAVAILABLE', 'AASC cannot change a session’s model or effort right now.', 'Try again once AASC has restarted.');
  }
  return ctx.settings;
}

/** A worker's check before typing: the steering rails again; a person at it or a task on it waits. */
export function workerCheck(ctx: ToolContext, sessionId: string): () => ChangeCheck {
  return () => {
    const id = ctx.resolveSessionId(sessionId) ?? sessionId;
    const s = ctx.sessions().find((x) => x.sessionId === id);
    if (!s) return { go: false, wait: false, reason: 'the session is gone' };
    try {
      ctx.mayDrive(s, { quiet: true });
      return { go: true };
    } catch (err) {
      if (err instanceof ToolError && (err.code === 'HUMAN_ACTIVE' || err.code === 'BUSY')) return { go: false, wait: true };
      return { go: false, wait: false, reason: err instanceof ToolError ? err.message.replace(/\.$/, '') : 'the steering rails refused it' };
    }
  };
}

/** The calling central's own live card in its own terminal, or null. */
export function ownCard(ctx: ToolContext): Session | null {
  const terminalId = ctx.central.terminalId;
  const card = resolveCentralSession(ctx.central.centralId, ctx.sessions());
  if (!card || !terminalId || card.terminalId !== terminalId || card.status === 'ended') return null;
  return card;
}

/** The central's own check before typing: still its live card in that terminal, not hands-off; an Esc hold waits. */
export function selfCheck(ctx: ToolContext, terminalId: string): () => ChangeCheck {
  return () => {
    const me = ctx.centrals().find((c) => c.centralId === ctx.central.centralId);
    if (!me || me.terminalId !== terminalId) return { go: false, wait: false, reason: 'the central was relaunched or ended' };
    const card = resolveCentralSession(me.centralId, ctx.sessions());
    if (!card || card.terminalId !== terminalId || card.status === 'ended') {
      return { go: false, wait: false, reason: 'the central’s session has ended' };
    }
    if (card.handsOff === true) return { go: false, wait: false, reason: 'the person marked the central hands-off' };
    if (isEscHeld(card.userCancelledAt, null)) return { go: false, wait: true };
    let locked = false;
    try {
      locked = ctx.ledger.isLocked(card.sessionId);
    } catch {
      locked = false;
    }
    return locked ? { go: false, wait: true } : { go: true };
  };
}

const STATE_WORDS: Record<SettingChange['state'], string> = {
  waiting: 'scheduled',
  typed: 'typed, not confirmed yet',
  confirmed: 'confirmed',
  'not-applied': 'not applied',
  expired: 'not applied',
  replaced: 'replaced by a newer change',
};

/** One change in AASC's words, for the summary. */
export function changeLine(ctx: ToolContext, c: SettingChange): string {
  const where = c.self ? 'your own session' : refOf(ctx)(c.sessionId);
  const line = commandLine(c.kind, c.value);
  switch (c.state) {
    case 'confirmed':
      return `Confirmed: the CLI in ${where} recorded ${line}.`;
    case 'typed':
      return c.cli === 'codex'
        ? `Typed ${line} into ${where}; Codex reports its setting at its next turn, so it is not confirmed yet.`
        : `Typed ${line} into ${where}; the CLI has not recorded it yet.`;
    case 'waiting':
      return c.self
        ? `Scheduled: AASC types ${line} into ${where} once this reply has ended and nobody is typing there, then checks the CLI took it.`
        : `Scheduled: AASC types ${line} into ${where} once it is free (its turn over, no dialog, nobody at it), then checks the CLI took it.`;
    default:
      return `Not applied in ${where}: ${c.reason ?? STATE_WORDS[c.state]}.`;
  }
}

/** The answer for the changes a call scheduled, as they are now. */
export function changeAnswer(ctx: ToolContext, list: readonly SettingChange[]): ToolResult {
  const pending = list.some((c) => c.state === 'waiting' || c.state === 'typed');
  const tail = pending
    ? ' Do not tell the person it is done: AASC reports the result (the activity log, the model and effort on the card, which session_get shows, a voice call says it, and a notice when notices are on).'
    : '';
  return {
    data: {
      changes: list.map((c) => ({
        changeId: c.changeId,
        sessionId: c.sessionId,
        kind: c.kind,
        value: c.value,
        state: c.state,
        reason: c.reason,
      })),
    },
    summary: `${list.map((c) => changeLine(ctx, c)).join(' ')}${tail}`,
    activity: list.map((c) => ({
      summary: `Asked for a ${c.kind} change (${STATE_WORDS[c.state]}).`,
      targetSessionId: c.sessionId,
      outcome: c.state === 'not-applied' || c.state === 'expired' ? ('failed' as const) : ('ok' as const),
      detail: { changeId: c.changeId, kind: c.kind, state: c.state },
    })),
  };
}

// tools/centralRuntime.ts — `central_set_runtime` (system toolset, Nov 23 2026): the calling central changes its own
// model or reasoning effort when the person asks it to ("switch this central to low effort").
//
// Every other tool refuses the central's own card (policy.ts `kindRefusal`: "a central never steers itself"); that
// rule stays. This tool is the one narrow way past it, and only for these two settings:
//   - it is an `ask`: the person allows it on the Mac or the phone first (NEEDS_CONFIRMATION → confirm_wait);
//   - the target is never named: it is always the caller's own live card in its own terminal;
//   - the values pass the same checks as session_set_model / session_set_effort (settingChange.ts);
//   - nothing is typed now. The central is in its turn when it calls a tool, so a line typed now would land as a
//     queued message in its own input. The change box (runtimeChange.ts) types `/model <m>`, then `/effort <e>`, once
//     the reply has ended and nobody is typing there, and reports the result only once the CLI recorded it.

import { z } from 'zod';
import type { ConfirmAsk, ToolContext, ToolDef } from '../registry.js';
import { commandLine, type SettingKind } from '../runtimeChange.js';
import { ToolError } from '../types.js';
import { defineTool } from './define.js';
import { assertValue, boxOf, changeAnswer, cliOf, ownCard, selfCheck } from './settingChange.js';

interface Wanted {
  kind: SettingKind;
  value: string;
}

/** The changes asked for, model first (a model switch resets the effort, so the effort goes after it). */
function wantedOf(args: { model?: string; effort?: string }): Wanted[] {
  const list: Wanted[] = [];
  if (args.model !== undefined) list.push({ kind: 'model', value: args.model });
  if (args.effort !== undefined) list.push({ kind: 'effort', value: args.effort });
  if (list.length === 0) throw new ToolError('INVALID', 'Nothing to change.', 'Pass a model, an effort, or both.');
  return list;
}

/** The caller's own card and the checked changes; refuses before any card opens. */
function prepare(args: { model?: string; effort?: string }, ctx: ToolContext) {
  const wanted = wantedOf(args);
  const card = ownCard(ctx);
  if (card === null || card.terminalId === null || card.terminalId === undefined) {
    throw new ToolError('UNAVAILABLE', 'AASC cannot find your own session in its terminal.', 'Ask the person to restart this central.');
  }
  const cli = cliOf(ctx, card);
  for (const w of wanted) assertValue(w.kind, w.value, cli);
  return { card, terminalId: card.terminalId, cli, wanted };
}

const setRuntime = defineTool({
  name: 'central_set_runtime',
  toolset: 'system',
  title: 'Change my own model or effort',
  description:
    'Changes YOUR OWN model, reasoning effort or both (this central’s session), only when the person asks you to ' +
    '("switch this central to low effort", "use opus"). Waits for the person to allow it on the Mac or phone ' +
    '(NEEDS_CONFIRMATION → confirm_wait). Nothing changes during your reply: AASC types /model and /effort into your ' +
    'session after this reply has ended and checks the CLI recorded them, so tell the person it is scheduled, never ' +
    'that it is done; AASC reports the result. Claude Code asks "Switch model?" / "Change effort level?" mid-' +
    'conversation (the next reply re-reads the history: slower, more tokens) and AASC answers Yes; it also saves the ' +
    'model and effort as the person’s default for new sessions. Claude effort: low, medium, high, xhigh, max, ultracode; Codex: ' +
    'minimal, low, medium, high, xhigh. For another session use session_set_model / session_set_effort.',
  risk: 'ask',
  phase: 3,
  input: {
    model: z.string().min(1).max(100).optional().describe('The model as your CLI names it (sonnet, opus, gpt-5).'),
    effort: z.string().min(1).max(20).optional().describe('The effort, one your CLI takes.'),
  },
  confirm(args, ctx): ConfirmAsk {
    const { card, terminalId, wanted } = prepare(args, ctx);
    return {
      summary: `change this central to ${wanted.map((w) => commandLine(w.kind, w.value)).join(' then ')}`,
      detail:
        'AASC types it into the central’s own session once its current reply has ended, answers Claude Code’s ' +
        '“Switch model?” question with Yes (its next reply re-reads the whole conversation: slower, more tokens), ' +
        'then checks the CLI took it. Claude Code also saves it as your default for new sessions.',
      targetSessionId: card.sessionId,
      fingerprint: `central_runtime:${terminalId}:${wanted.map((w) => `${w.kind}=${w.value}`).join(',')}`,
    };
  },
  async run(args, ctx) {
    const { card, terminalId, cli, wanted } = prepare(args, ctx);
    const box = boxOf(ctx);
    const scheduled = wanted.map((w) =>
      box.schedule({
        centralId: ctx.central.centralId,
        sessionId: card.sessionId,
        terminalId,
        cli,
        kind: w.kind,
        value: w.value,
        self: true,
        check: selfCheck(ctx, terminalId),
      }),
    );
    return changeAnswer(ctx, scheduled);
  },
});

export const centralRuntimeTools: readonly ToolDef[] = [setRuntime];

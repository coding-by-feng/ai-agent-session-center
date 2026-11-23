// tools/sessionCard.ts — the card setters of the sessions toolset (P3, Ruling P3-7): a central labels and files a
// session's card the way the person does from its detail panel: title, remark, pinned, muted, alerted, accent colour,
// character model, AI popup and sharing with the paired phone.
//
// Each setter names its session through `resolveTarget`, passes the card rail (`ctx.mayEdit`, policy.ts
// `assertMayEditCard`: in scope; never a central's card, its own included, an ops shell, a subagent, an AI popup, an
// external or an SSH card; never a hands-off card) and calls the card's PUT route with that route's own body key. The
// inputs mirror the routes' limits (apiRouter.ts `titleSchema`, `remarkSchema`, …), narrowed where a route takes any
// text for a value the window reads as a fixed kind: a colour is `#rgb` or `#rrggbb`, a character model one of the six
// the 3D view draws. Nothing is typed, so the 60-second rule and the lock are not asked, and an ended card may be
// written. A title passes the title rule (titleRule.ts, Ruling P3-23): it is typed into every relaunch as `-n "<title>"`
// and stored back as loose words, so one with shell syntax, a quote, a wildcard, a line break or a word starting with a
// dash is INVALID.
//
// `session_set_shared` is the one `ask` (Ruling P3-6): sharing a session with the paired phone waits on the person's
// confirm card; turning sharing off, or sharing a card already shared, needs none (`confirm` answers null).
//
// The answer's `data` echoes `{ sessionId, <field>: value }`; the words around it never repeat what the central wrote.

import { z } from 'zod';
import { ROBOT_MODEL_TYPES } from '../../../src/lib/robotModelMeta.js';
import type { Session } from '../../../src/types/session.js';
import type { ToolContext, ToolDef, ToolResult } from '../registry.js';
import { titleRefusal } from '../titleRule.js';
import type { SettingKind } from '../runtimeChange.js';
import { ToolError } from '../types.js';
import { defineTool, refOf, resolveTarget, seg, SESSION_REF, unwrap } from './define.js';
import { assertValue, boxOf, changeAnswer, cliOf, ownCard, workerCheck, WORKER_WAIT_MS } from './settingChange.js';

/** The rule every setter applies, as its description tells it (Ruling 65). */
const CARD_RULE =
  'Never on a hands-off session, another central’s session or your own, a command shell, a subagent, an AI popup, ' +
  'an external or an SSH session.';

/** A colour the window draws a card in. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** The character models the 3D view draws (src/lib/robotModelMeta.ts). */
const CHARACTER_MODELS = ROBOT_MODEL_TYPES as [string, ...string[]];

/** The card `id` names, once the card rail let it through. */
function editable(ctx: ToolContext, id: string): Session {
  const s = resolveTarget(ctx, id);
  ctx.mayEdit(s);
  return s;
}

/** A setter's write: the rail, then `PUT /sessions/:id/<route>` with `body`. */
async function putCard(ctx: ToolContext, id: string, route: string, body: Record<string, unknown>): Promise<Session> {
  const s = editable(ctx, id);
  unwrap<unknown>(await ctx.client.put(`/sessions/${seg(s.sessionId)}/${route}`, body));
  return s;
}

/** A setter's answer: the field echoed in `data`, AASC's words in the summary and the activity row. */
function setAnswer(ctx: ToolContext, s: Session, field: Record<string, unknown>, words: string): ToolResult {
  const ref = refOf(ctx)(s.sessionId);
  return {
    data: { sessionId: s.sessionId, ...field },
    summary: `Session ${ref}: ${words}.`,
    activity: [{ summary: words, targetSessionId: s.sessionId }],
  };
}

const onOff = (on: boolean): string => (on ? 'on' : 'off');

// ---------------------------------------------------------------------------
// The setters
// ---------------------------------------------------------------------------

const setTitle = defineTool({
  name: 'session_set_title',
  toolset: 'sessions',
  title: 'Retitle a session',
  description:
    'Sets a session’s title, as the person renames its card. The title is plain words: no shell syntax, quotes, ' +
    `wildcards or line breaks, and no word starting with a dash (INVALID otherwise). ${CARD_RULE}`,
  risk: 'write',
  phase: 3,
  idempotent: true,
  input: { id: SESSION_REF, title: z.string().min(1).max(500).describe('The new title (1–500 characters, plain words).') },
  async run(args, ctx) {
    const bad = titleRefusal(args.title);
    if (bad !== null) throw new ToolError('INVALID', bad, 'Give a title of plain words.');
    const s = await putCard(ctx, args.id, 'title', { title: args.title });
    return setAnswer(ctx, s, { title: args.title }, 'set the title');
  },
});

const setRemark = defineTool({
  name: 'session_set_remark',
  toolset: 'sessions',
  title: 'Set a session’s remark',
  description: `Sets the one-line progress remark on a session’s card; an empty remark clears it. ${CARD_RULE}`,
  risk: 'write',
  phase: 3,
  idempotent: true,
  input: { id: SESSION_REF, remark: z.string().max(200).describe('The remark (at most 200 characters; empty clears it).') },
  async run(args, ctx) {
    const s = await putCard(ctx, args.id, 'remark', { remark: args.remark });
    return setAnswer(ctx, s, { remark: args.remark }, args.remark === '' ? 'cleared the remark' : 'set the remark');
  },
});

/** The four on/off switches whose route takes one boolean under its own key. */
function switchTool(spec: { name: string; title: string; does: string; route: string; key: string; field: string; what: string }): ToolDef {
  return defineTool({
    name: spec.name,
    toolset: 'sessions',
    title: spec.title,
    description: `${spec.does} ${CARD_RULE}`,
    risk: 'write',
    phase: 3,
    idempotent: true,
    input: { id: SESSION_REF, on: z.boolean().describe('true to turn it on, false to turn it off.') },
    async run(args, ctx) {
      const s = await putCard(ctx, args.id, spec.route, { [spec.key]: args.on });
      return setAnswer(ctx, s, { [spec.field]: args.on }, `turned ${spec.what} ${onOff(args.on)}`);
    },
  });
}

const setPinned = switchTool({
  name: 'session_set_pinned',
  title: 'Pin a session',
  does: 'Pins a session’s card (AASC brings a pinned session back after a restart) or unpins it.',
  route: 'pinned',
  key: 'pinned',
  field: 'pinned',
  what: 'the pin',
});

const setMuted = switchTool({
  name: 'session_set_muted',
  title: 'Mute a session',
  does: 'Mutes a session’s sounds and notifications, or unmutes them.',
  route: 'muted',
  key: 'muted',
  field: 'muted',
  what: 'muting',
});

const setAlerted = switchTool({
  name: 'session_set_alerted',
  title: 'Alert on a session',
  does: 'Turns the alert on a session’s card on or off (the person is told when it next needs them).',
  route: 'alerted',
  key: 'alerted',
  field: 'alerted',
  what: 'the alert',
});

const setAiPopup = switchTool({
  name: 'session_set_ai_popup',
  title: 'Toggle a session’s AI popup',
  does: 'Turns the select-to-explain AI popup in a session’s terminal on or off.',
  route: 'ai-popup',
  key: 'aiPopupEnabled',
  field: 'aiPopup',
  what: 'the AI popup',
});

const setAccentColor = defineTool({
  name: 'session_set_accent_color',
  toolset: 'sessions',
  title: 'Colour a session’s card',
  description: `Sets the accent colour AASC draws a session’s card and character in, as #rgb or #rrggbb. ${CARD_RULE}`,
  risk: 'write',
  phase: 3,
  idempotent: true,
  input: {
    id: SESSION_REF,
    color: z.string().regex(HEX_COLOR, 'A colour is #rgb or #rrggbb.').describe('The colour, #rgb or #rrggbb (#00f0ff).'),
  },
  async run(args, ctx) {
    const s = await putCard(ctx, args.id, 'accent-color', { color: args.color });
    return setAnswer(ctx, s, { accentColor: args.color }, 'set the accent colour');
  },
});

const setCharacterModel = defineTool({
  name: 'session_set_character_model',
  toolset: 'sessions',
  title: 'Pick a session’s character',
  description: `Sets the character the 3D view draws for a session: ${CHARACTER_MODELS.join(', ')}. ${CARD_RULE}`,
  risk: 'write',
  phase: 3,
  idempotent: true,
  input: { id: SESSION_REF, model: z.enum(CHARACTER_MODELS).describe('The character model.') },
  async run(args, ctx) {
    const s = await putCard(ctx, args.id, 'character-model', { model: args.model });
    return setAnswer(ctx, s, { characterModel: args.model }, 'set the character');
  },
});

const setShared = defineTool({
  name: 'session_set_shared',
  toolset: 'sessions',
  title: 'Share a session with the phone',
  description:
    'Shares a session with the person’s paired phone, or stops sharing it. Sharing asks the person on the Mac first ' +
    '(NEEDS_CONFIRMATION: then call confirm_wait); stopping, or a session already shared, does not. ' +
    CARD_RULE,
  risk: 'ask',
  phase: 3,
  idempotent: true,
  input: { id: SESSION_REF, on: z.boolean().describe('true to share it with the paired phone, false to stop.') },
  confirm(args, ctx) {
    const s = editable(ctx, args.id);
    if (!args.on || s.remoteVisible === true) return null;
    return { summary: `share session ${refOf(ctx)(s.sessionId)} with your paired phone`, targetSessionId: s.sessionId };
  },
  async run(args, ctx) {
    const s = await putCard(ctx, args.id, 'remote-visible', { remoteVisible: args.on });
    return setAnswer(ctx, s, { shared: args.on }, args.on ? 'shared it with the phone' : 'stopped sharing it with the phone');
  },
});

// ---------------------------------------------------------------------------
// session_set_model, session_set_effort (Ruling P3-17; Nov 23 2026: typed when free, confirmed from the CLI's record)
// ---------------------------------------------------------------------------

/** The rails a steer applies, as the two descriptions tell them (Ruling 65). */
const STEER_RULE =
  'The steering rails apply: never a hands-off session, another central, an ended one or one without a terminal; ' +
  'not within a minute of the person driving it, nor while a central’s task holds it (BUSY). For your own session ' +
  'use central_set_runtime.';

/** Schedules one change in a worker (runtimeChange.ts) and answers how far it got within WORKER_WAIT_MS. */
async function setWorker(ctx: ToolContext, ref: string, kind: SettingKind, value: string): Promise<ToolResult> {
  const s = resolveTarget(ctx, ref);
  if (ownCard(ctx)?.sessionId === s.sessionId) {
    throw new ToolError('INVALID', 'That is your own session.', 'Use central_set_runtime to change your own model or effort.');
  }
  const cli = cliOf(ctx, s);
  assertValue(kind, value, cli);
  ctx.mayDrive(s);
  const box = boxOf(ctx);
  if (!s.terminalId) throw new ToolError('INVALID', 'That session has no terminal to type into.', 'Pick another session.');
  const change = box.schedule({
    centralId: ctx.central.centralId,
    sessionId: s.sessionId,
    terminalId: s.terminalId,
    cli,
    kind,
    value,
    self: false,
    check: workerCheck(ctx, s.sessionId),
  });
  // A free session is usually confirmed within seconds; a busy one is not waited for.
  const free = s.status === 'idle' || s.status === 'waiting';
  const now = free ? ((await box.waitFor(change.changeId, WORKER_WAIT_MS, ctx.signal)) ?? change) : change;
  return changeAnswer(ctx, [now]);
}

const setModel = defineTool({
  name: 'session_set_model',
  toolset: 'sessions',
  title: 'Switch a session’s model',
  description:
    'Switches the model a Claude Code or Codex session runs, when the person asks for it. AASC types /model <model> ' +
    'into it once it is free (its turn over, no dialog, nobody typing there), then checks the CLI recorded it: the ' +
    'answer says scheduled, typed, confirmed or not applied, and only confirmed means done. Mid-conversation Claude ' +
    'Code asks "Switch model?" (the next reply re-reads the whole history: slower, more tokens); AASC answers Yes for ' +
    'the model asked for. Claude Code also saves the model as the person’s default for new sessions. ' +
    `${STEER_RULE}`,
  risk: 'steers',
  phase: 3,
  input: {
    id: SESSION_REF,
    model: z.string().min(1).max(100).describe('The model as the CLI names it (sonnet, opus, gpt-5): letters, digits, . _ -.'),
  },
  run: (args, ctx) => setWorker(ctx, args.id, 'model', args.model),
});

const setEffort = defineTool({
  name: 'session_set_effort',
  toolset: 'sessions',
  title: 'Set a session’s effort',
  description:
    'Sets the reasoning effort of a Claude Code session (low, medium, high, xhigh, max, ultracode) or a Codex one ' +
    '(minimal, low, medium, high, xhigh), when the person asks for it. AASC types /effort <effort> once the session is ' +
    'free, then checks the CLI recorded it: only confirmed means done. Mid-conversation Claude Code may ask "Change ' +
    'effort level?" first (the next reply re-reads the history); AASC answers Yes for the effort asked for. ' +
    `${STEER_RULE}`,
  risk: 'steers',
  phase: 3,
  input: { id: SESSION_REF, effort: z.string().min(1).max(20).describe('The effort, one the session’s CLI takes.') },
  run: (args, ctx) => setWorker(ctx, args.id, 'effort', args.effort),
});

export const cardTools: readonly ToolDef[] = [
  setTitle,
  setRemark,
  setPinned,
  setMuted,
  setAlerted,
  setAccentColor,
  setCharacterModel,
  setAiPopup,
  setShared,
  setModel,
  setEffort,
];
